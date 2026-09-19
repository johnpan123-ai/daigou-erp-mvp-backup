# Production Cutover Runbook Candidate

狀態：候選文件；不可直接視為切換授權。任何 Production 操作、SQL apply、部署、Restore、DNS 變更及第一筆業務寫入都需另行明確授權。

## 1. 切換前固定輸入

- 固定 Release Candidate commit、checkpoint、所有 migration 的 Git blob 與 SHA-256。
- 固定最後 Production Cloud Snapshot 的 filename、檔案 SHA-256、schema、identity version、15-table rows、soft-deleted rows、snapshot fingerprint 與 relationship hash。
- 固定新 Production Supabase project ref、Pages project、domain 與 public-key fingerprint；public key 可進前端，service role、DB password、Postgres URI 不可進前端。
- 所有 Staging SQL apply、human acceptance、authoritative postflight 必須先完成；未完成項不得以自動化測試替代。

## 2. 舊 Production 可能寫入來源

1. 舊 Production Pages 網站的所有已登入瀏覽器分頁與裝置。
2. 舊網址、書籤、手機捷徑及尚未失效的前端資產。
3. Supabase REST/RPC client、管理 Dashboard、SQL Editor 與維運腳本。
4. Catalog、訂單、採購或其他匯入工具與排程。
5. 任何第三方 webhook、自動化、物流、金流或通知整合（若存在）。
6. 人員直接操作舊站、Staging 或新 Production 的平行工作。

切換負責人需逐項列出實際存在者；「未找到」不等於已停用。

## 3. Freeze

1. 公告 freeze 起訖與責任人，要求所有操作人關閉或停止舊站寫入。
2. 停止匯入、排程、外部 webhook 及所有已知寫入 client；保留讀取。
3. 將舊站切至既有維護/唯讀入口，或以可逆方式撤除寫入入口。不得臨時修改 RLS 來達成 freeze。
4. 記錄 freeze 前最後 request/epoch、15-table counts 與最新業務 timestamp。
5. 在至少一個完整觀察窗口內確認沒有新增/更新 request、epoch 或 business-table `updated_at`；同時核對應用程式、PostgREST/RPC 與外部整合紀錄。
6. 任一來源仍在寫入即停止切換。不得一邊匯出一邊容許舊站繼續寫。

## 4. 最後 Snapshot

1. 只從 frozen 舊 Production 的 Cloud export 路徑取得 snapshot。
2. 下載完成後立即計算檔案 SHA-256，記錄 filename、rows、soft-deleted rows、fingerprint、relationship hash。
3. 離線 preflight 必須為 15/15、blocking orphan 0、metadata missing 0、canonical anomalies 0、duplicate IDs 0。
4. 原檔唯讀保存；任何 portability 轉換只能產生獨立 candidate，並另記 policy、target 與 effective candidate fingerprint。
5. 檔案、policy 或 target 任一改變，先前確認與 idempotency intent 全部失效。

## 5. 新 Production target 與 migration

1. 從 Dashboard 與待部署 bundle 交叉核對 project ref、public-key fingerprint、Auth/profile 與實際 network destination。
2. 先用 catalog SELECT-only 驗證已套用 migration 契約；不可只看 migration table 名稱。
3. 依數字順序補齊缺少的已核准 migration。此 RC 新增順序為 031 後 032；前置 020、021、023–030 必須已存在且 postflight 相符。
4. 每份 SQL 在套用前再次核對 blob/SHA；套用後執行該 artifact 自帶 postflight。
5. SQL 套用與 frontend deploy 分開記錄；SQL gate 未通過不得部署會呼叫新 RPC 的 frontend。

## 6. Frontend 與 Restore 順序

1. 以固定 RC HEAD、Production mode 與已核准 public build config 建置隔離產物。
2. 驗證 active Supabase target、public-key fingerprint、secret scan、entry/provider bundle 與 asset manifest。
3. 先部署到不承接真實流量的 Production deployment，做未登入與登入唯讀 smoke。
4. 確認 owner/profile、authoritative fresh、Dashboard/Inventory/Settings/Purchasing/Japan Package/Outbound 唯讀載入。
5. 在新 Production 尚未接受業務寫入時，執行唯一一次指定 snapshot Atomic Restore。結果不明時不得重試，先查 request/idempotency/epoch/rollback metadata。
6. Restore 完成後做 15-table counts、identity/content/relationship、orphan/duplicate/Unknown Product、processing/lock 及 epoch postflight。
7. 保留 Server 成功結果；若 browser cache refresh 失敗，只修同步，不得再 Restore。

## 7. 切換前人工 Gate

在尚未切 DNS、尚未放行第一筆 Production 寫入前，由使用者本人完成 `human-acceptance-script.md` 的唯讀與最小寫入項目。任何 NEEDS HUMAN ACCEPTANCE 未簽核即停止。

## 8. Domain / Pages 切換與雙寫防護

1. 記錄舊/new deployment ID、domain mapping 與回復點。
2. 確認舊站所有寫入入口仍 frozen，再切 domain/Pages alias。
3. 驗證固定正式網址載入新 bundle、連線新 Supabase，舊網址不再提供可寫 UI。
4. 保留舊站資料庫唯讀，不可同時重新開放兩邊寫入。
5. 通知所有人重新開啟正式網址；舊分頁必須關閉，不能繼續離線排隊或送出。

## 9. 第一筆寫入與 rollback decision point

- 第一筆新 Production 寫入前：仍可把流量切回舊站，前提是舊站 freeze 後沒有漏寫且新站沒有新增業務資料。
- 第一筆新 Production 寫入後：禁止直接把網域切回可寫舊站，否則會遺失新資料或雙寫。若需回復，先重新 freeze 新站、匯出新站增量/完整 snapshot、評估可逆合併或將新站維持唯一 authority；需獨立事故授權。
- Restore rollback snapshot 只用於新 Production 尚未產生後續業務寫入、且 Server 狀態已查證的情況。不得在未知 request 狀態下執行。

## 10. 觀察與舊站保留

- 舊站及其資料庫至少保留一個經營運者核准的觀察期，期間保持唯讀與受控存取；具體天數是營運決策，未核准前不得刪除。
- 觀察 active deployment、Auth、readStatus、RPC errors、idempotency、epoch、processing/lock、Realtime/catch-up 與核心頁面。
- 觀察期結束需另行核准 archive/retire；本 runbook 不授權刪除 project、domain、snapshot 或 rollback 資料。

## 11. 停止條件

target/ref 不符、public key 不符、owner/profile 未確認、freshness 未成立、snapshot identity 不符、migration postflight 失敗、request 結果不明、epoch 非預期、partial write、processing/lock 殘留、雙寫來源未 frozen，任一出現即停止後續切換。
