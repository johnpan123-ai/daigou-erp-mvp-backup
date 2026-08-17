# NEXT DEVELOPMENT ROADMAP — 起床後執行規劃

建立時間：2026-08-18（Asia/Taipei）  
依據：Next nightly raw integrity、Golden regression、P0 regression、error audit 與 Next-only soak。  
本文件只規劃，不在本輪執行 roadmap。

## 目前工作總覽

| 工作 | 類別 | 優先級 | 資料安全 | Production 影響 | 需人工驗收 | Migration/RPC/Schema | 可只在 Next | 適合 Experimental | 目前判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0-G Variant destructive sync hotfix `b50a0a4` | A 緊急資料安全 | P0 | 高 | 有 | 是 | 否（runtime guard） | 可先 Next/Preview | 不適合長期 Experimental | 優先驗收，尚未核准上線 |
| P0-A atomic Snapshot import | A | P0 | 高 | 有（restore/import） | 是 | Local/Test 不需；Cloud restore 另案 | 可 | 不需 | Snapshot importer automated PASS；legacy harness 需修測試入口 |
| P0-B Cloud restore stop-gap | A | P0 | 高 | 有 | 已完成使用者 SOP | 否 | 可 | 不需 | Accepted，維持 Cloud fail-closed |
| P0-F bootstrap recovery | A | P0 | 中 | 有 | 已完成使用者 SOP | 否 | 可 | 不需 | Accepted |
| P0-C 採購批次＋明細 atomic | D 尚未安全解決 | P0 | 高 | 有 | 是 | 需要 PostgreSQL transaction/RPC；可能需 migration | 先可做 | 不適合用 Experimental 代替 | Design Gate |
| P0-D Inventory＋PurchaseRecords atomic sync | D | P0 | 高 | 有 | 是 | 需要 server-side staging/transaction/RPC；可能需 migration | 先可做 | 不適合 | Design Gate |
| P0-E 出庫單＋明細刪除 atomic | D | P0 | 高 | 有 | 是 | 需要 transaction/RPC；若採 soft delete 才可能需 Schema | 先可做 | 不適合 | Design Gate |
| `.catch(() => [])` read-failure audit | B Next 穩定性 | P1 | 中～高 | 間接 | 是 | 首階段不需 | 是 | 可做診斷 | 下一個安全修正候選 |
| `db.ts` storage fallback | B | P1 | 高 | 間接 | 是 | 可能需要 db.ts policy；不先改 Schema | 是 | 不適合只靠實驗 | 需獨立設計 |
| PurchaseRecords fresh-load Error state | B | P1 | 中 | 間接 | 是 | 否 | 是 | 可 | UI/狀態修正候選 |
| post-sync `getProductVariants({recalc:true})` fail-closed audit | B | P1 | 高 | 有 | 是 | 可能需 Provider | 先 Next | 不適合 | 需另案分析 |
| Outbound checked queue | B | P1 | 高 | 有 | 已自動測試；仍需 field test | 否 | 是 | 不需 | 本輪 regression PASS |
| Snapshot import stale cache | B | P1 | 中 | 無 | 是 | 否 | 是 | 不需 | 已以全頁 reload 止血；保留回歸 |
| 第二層官網／近期採購／套組顯示／複製帳目 | C 已完成功能 | P2 | 低 | 未上線 | 是 | 否 | 是 | 不適合長期實驗 | Ready/Needs Manual/Field Testing |
| 採購操作防誤點／運費分攤／Local Mode 入口 | C | P2 | 低～中 | 未上線 | 是 | 否 | 是 | 不需 | Ready/Needs Manual |
| 出庫改善與日幣成本 XLS | C | P2 | 中 | 未上線 | 是 | 否 | 是 | 不需 | Ready/Needs Manual |
| PurchaseRecords／搜尋排序／sticky table | E 效能 | P2 | 低 | 未上線 | 是 | 否 | 是 | 可 | 只有 baseline，無穩定 optimization claim |
| Snapshot/Product Variant/XLS import 效能 | E | P2 | 中 | 未上線 | 是 | 否 | 是 | 適合隔離 benchmark | 先量測；parser 不是 bottleneck |
| Dashboard 工作台改版 | F 未來功能 | P3 | 低 | 未上線 | 是 | 否 | 是 | 可 | 暫緩 |
| 每日 22:00 Email JSON Backup | F | P3 | 中 | 有外部服務 | 是 | 否；需 Email/Secrets 設計 | 先 sandbox | 適合另案 | 暫緩，先確認備份安全模型 |

## 起床後第一件事

**先做 P0-G Production Hotfix `b50a0a4` 的最終驗收，不是直接部署。**

理由：Next nightly 的 P0-G regression、fault injection、Golden raw data 與 orphan checks 均通過；但 hotfix 仍需要一次乾淨 Production-base diff review、production-like/Preview 人工驗收、rollback point 與明確上線批准。不上線的風險是 Production 仍含已知 Variant read failure → empty → destructive sync 風險；上線的風險則是 guard 誤擋合法初始化或遇到未盤點的 read path。兩者都必須先在 Production-like 隔離環境確認。

### Hotfix `b50a0a4` 決策

- **建議：優先驗收，暫不自動 Push/Deploy。**
- **已具備：** 只從 Production `c3756cd` 起、runtime guard diff、strict source probe、Verified Empty 分流、identity/manual-adjustment/planned-new sanity gates、專用 fault injection regression。
- **尚缺：** Production-base clean diff review、實際 Preview/production-like 手動 smoke、Production rollback tag 與使用者明確「可以上雲」。
- **上線風險：** 正常資料讀取契約若有未盤點的空資料初始化可能被阻擋；需看錯誤訊息與初始化案例。
- **不上線風險：** Production 仍保留 `c08fe2e` 造成的 destructive path，不能以「目前沒有損壞證據」視為安全。
- **Test-only code：** hotfix diff 不應包含 Test UI、Sandbox importer、Test Owner 或 fault injection UI；需在 release diff 再掃一次。

## Phase 1｜立即處理：資料安全／Production

1. P0-G hotfix 最終驗收與 rollback point。
2. 保持 P0-B Cloud restore fail-closed，不重新開放。
3. P0-A 先分清 Snapshot importer 與 legacy `importData()` 兩條路徑；修正 test harness 後再決定是否需要 Cloud/Local restore 專案。
4. 為 P0-C、P0-D、P0-E 分別完成 server-side atomic boundary 設計；不接受前端補償假 atomic。

## Phase 2｜Next 穩定化：Field Test 前的安全網

1. 優先修 P1-`db.ts` read failure 與 destructive follow-up 的契約。
2. 修 Purchasing / JapanPackageDetail / PurchaseManagement 的 Error-vs-Empty。
3. 修 PurchaseRecords fresh-load Error state。
4. 修正 `test:atomic-import-data` 的 mode/port harness，確保它真的測試正確 DB；不要用測試改動掩蓋 runtime 行為。
5. 重跑 Golden Business Regression、raw orphan、P0-G、Outbound queue；再進行多日 Field Testing。
6. 重新測 heap trend；若多輪且強制 GC 後仍單調上升，才建立 memory leak 修正 stage。

## Phase 3｜功能與效能

等待 Phase 1／2 穩定後，再依人工驗收與 Feature Registry 推進：

- 官網連結、近期採購、套組顯示、複製帳目、採購操作與運費分攤逐項 Field Tested。
- PurchaseRecords 搜尋／排序／sticky table 僅使用固定 benchmark；不改公式、不改 UI 結構直到有穩定 Before/After。
- Snapshot import 優先保持 atomic/checksum/readback；目前 parser 約 17ms，不是主要瓶頸。
- Dashboard 改版與 Email backup 另案，不與 P0 混做。

## P1 排序（按資料破壞可能性）

1. `db.ts` read fallback → empty/localStorage，因已證實可能餵給 destructive sync：最高。
2. Cloud post-sync `getProductVariants({recalc:true})` 讀取失敗後仍可能走一般 fallback：可能直接影響 Production，需次高。
3. Purchasing / JapanPackageDetail 的 `.catch(() => [])`：會讓使用者在不完整資料上繼續操作。
4. PurchaseRecords fresh-load Error state：主要是 stale/錯誤狀態，但可能造成錯誤判斷。
5. Outbound fire-and-forget 入口：目前 serial queue、pending protection 與 failure test 已通過，剩下 Field Testing，不宜先重構。

## P0-C / P0-D / P0-E Cloud Atomic Operations Roadmap

| 項目 | 建議順序 | 風險 | 最小安全邊界 | 需要 |
| --- | ---: | --- | --- | --- |
| P0-C 採購批次＋明細 | 1 | 直接改變已採購／缺口 | server-side transaction：header、items、必要 audit 一起成功或 rollback | PostgreSQL transaction/RPC；若新增 RPC function 需 migration/權限 review |
| P0-D Inventory＋需求同步 | 2 | 跨 Inventory、Variant、PurchaseRecords，最容易產生兩邊不一致 | staging/import batch + server-side transaction／可重試 job；不以前端 Promise.all 假裝 atomic | 可能需 staging table/RPC/migration |
| P0-E 出庫單＋明細刪除 | 3 | 可能留下孤兒或半刪除歷史 | transaction delete 或明確 soft-delete policy；先保留 checked history | RPC；soft-delete 若改欄位才需 Schema/migration |

共通驗證：建立 production-like project/DB clone，使用固定 anonymized fixture 與故障注入；先在新 project restore/驗證，再考慮 Production；Production 只讀，沒有 migration/repair。

## Next Field Test 計畫

| 日程 | 內容 | 通過條件 |
| --- | --- | --- |
| Day 1 | PurchaseRecords F5、搜尋／分類、代理採購人、改數量、採購批次 | 最終數量、缺口、已採購、F5 一致；無舊 request 覆蓋 |
| Day 2 | Japan Package、套組展開、手動商品、編輯 | item.id／quantity／bundle FK 不變；未知商品不增加 |
| Day 3 | Outbound 同 SKU、多來源、整組／逐筆點收、F5、XLS | checked／checked_at 各 item 正確；不新增／merge item |
| Day 4 | Snapshot 更新、錯檔 rollback、Local/Test restore | 成功全換、失敗全保留；Cloud restore 仍阻擋 |
| Day 5+ | 重複日常流程並記錄 error/slow/memory | 逐項由 Field Testing 升 Field Tested；不自動升 Production Ready |

## Experimental Performance 重啟條件

只有在：Next raw data 正確、P0 regression stable、Golden Business Regression 連續通過、P1 read failures 有明確 Error state、至少數日 Field Testing 沒有新增資料異常後，才重啟 Experimental Performance。實驗必須有固定 Snapshot、Before/After、checksum、Production request 0，且不能混入功能開發。

## Production Feature Gate

普通 Feature：`Implemented → Automated Tested → Manual Accepted → Integrated into Next → Field Testing → Field Tested → Production Candidate → Production Ready`。

P0 Hotfix：`Root cause → isolated regression → fault injection → manual acceptance → clean Production-base diff → rollback point → explicit Production approval`。自動測試不等於 Accepted。

## 明日工作卡

### 第一件

**P0-G Production Hotfix 最終驗收**  
原因：Production 仍有已知 destructive risk；Next guard 已通過，但 hotfix 尚未完成 production-like/Preview gate。  
預估人工驗收：正常 XLS sync、Variant read failure injection、F5、WACA／已採購／FK／orphan 不變；確認只有 runtime diff。

### 第二件

**決定 P1 read-failure 修正順序，先從 `db.ts` fail-closed 設計開始**  
原因：這是已被 P0-G 實際證明能把讀取錯誤偽裝成空資料的共同根因。  
預估人工驗收：模擬 IndexedDB read failure；畫面顯示 Error 而非 0 筆；任何 sync/write 都不啟動；F5 後原資料保留。

### 第三件

**P0-C／D／E 選一個建立 Cloud atomic boundary 設計**  
原因：目前不能靠前端補償保證 header/items 或跨表同步一致。  
預估人工驗收：先在 production-like DB 故障注入，成功全寫、失敗全 rollback；不碰 Production。

### 今天先不要做

- 不要 Push／Deploy P0-G hotfix。
- 不要修 P0-C／D／E 的前端補償。
- 不要重啟 Experimental Performance。
- 不要加入 Dashboard 改版、Daily Email Backup 或其他新功能。
- 不要在 Production 觸發 Variant sync、restore、import 或資料修復。
