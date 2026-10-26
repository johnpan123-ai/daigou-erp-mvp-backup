# ERP2 v33 日本包裹新增失敗診斷（2026-10-26）

## 正式基準與事故證據

- Production deployment: `62ea2cd7-d351-427e-b773-842bd8225b61`
- Runtime HEAD: `ff5555c45ca3937f44fab6411d87e3fa25c6671f`
- Artifact identity: `EF277F4180FE1CA05A5063E8AF3255C6401510BC6879C1C224B54A15E8EC008E`
- Schema v33 fingerprint: `a5387d8513f2f1aab7eba16ab2f0b10a43a21fdbfeb85d8ac0686a6fc7878ac5`
- Owner 回報操作時，頁面顯示 Realtime 尚未確認且處於唯讀模式；瀏覽器主控台記錄寫入暫停。
- Supabase Unified Logs 在事故時段找不到 `/rest/v1/rpc/erp_apply_japan_package_transaction` 請求，因此沒有 HTTP 狀態或資料庫錯誤碼。請求在瀏覽器端就被阻止。
- 正式資料庫唯讀查詢確認：`羊周邊` 在 `japan_packages` 與 `erp_idempotency_keys` 都是 0 筆，沒有誤報失敗或重複建立。

## 根因與寫入路徑

新增路徑為：

1. `JapanPackagesList.handleAddSubmit`
2. `dataProvider.applyJapanPackageTransaction`
3. `DynamicDataProvider.guardedWrite`
4. `assertCloudWriteAllowed`
5. `supabaseProvider.applyJapanPackageTransaction`
6. PostgREST RPC `public.erp_apply_japan_package_transaction(uuid, jsonb)`

本次停在第 4 步。Realtime readiness 未能確認時，fail-closed Guard 丟出：

- Error class: `CloudOfflineWriteError`
- Error code: `CLOUD_OFFLINE_WRITE_BLOCKED`

這個 Guard 正確避免在無法確認雲端狀態時寫入。真正缺陷是新增表單把該錯誤改成通用的「儲存失敗，請重試！」，隱藏了必須等待重新同步的原因。

Migration 078 沒有令包裹選用欄位變成必填，也沒有造成這次後端拒絕。相同的通用 catch 在上一版 R5 已存在，而七項修復沒有修改 `JapanPackagesList.tsx` 的新增流程。因此這是既有錯誤呈現缺陷，在短暫的 Realtime 未確認狀態下被觸發。

## 最小修復

- 新增表單改用既有 `cloudMutationFailureMessage` 分類器。
- 分類器依固定的 error name/code 顯示既有雲端唯讀說明，不呈現未信任的後端文字。
- 不改動 Guard、Provider 分派、RPC、Schema、Migration 或資料模型。

修復後，在 Realtime 未確認時會顯示：

> 雲端資料目前不是可確認的最新狀態。新增、修改、刪除與匯入已停用；重新連線後會讀取雲端最新資料。

表單輸入保留、RPC 呼叫數為 0；重新連線完成後可重新儲存。

## 隔離驗證

使用 disposable PostgreSQL v33（v32 + 078）、authenticated PostgREST 14.18 與 safeupdate 1.4 實測：

- 只輸入名稱、預設 `registered`：HTTP 200，建立成功。
- 全部選用欄位及中文／日文：建立成功且資料一致。
- 同一 idempotency key 重送：第二次為 replay，資料庫只有 1 筆。
- 不合法狀態：HTTP 400，包裹與 idempotency key 都是 0 筆，完整回滾。
- 建立後立即讀取及重新讀取：皆可查到。
- 新包裹接續新增商品、點收完成、自動轉成 `confirmed`、建立出庫配置：皆通過。
- 真實 React UI 桌面與手機 viewport：成功建立並立即顯示。
- 同步雙擊儲存：只送出 1 次 transaction/RPC。
- Realtime 未確認：0 次 RPC、0 筆資料、保留表單，顯示精確原因。

相關回歸已通過：日本包裹 transaction/provider/UI、Provider Guard、Cloud/Local 隔離、Backup/Restore、WACA Guard、change-impact、TypeScript/Vite build，以及相對部署 HEAD 的 P0 ESLint delta（新增 0 項）。

既有 `japan-package-daily-status-isolated` 仍有一項歷史 `arrived` 狀態期待值與 v33 保留歷史狀態規則不一致；本修復沒有修改狀態交易或資料庫程式。新建立的一般包裹已在上述 v33 隔離測試證實會於全數點收後正確轉成 `confirmed`。

## 安全邊界

- 不需要追加 Migration。
- 正式 ERP1／ERP2 業務資料未修改。
- 未 Push、未 Restore、未 Deploy。
