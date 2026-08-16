# P0-B：Production Cloud Restore 原子性設計 Gate

## Stage

**Implementation Passed / Awaiting Manual Acceptance**

使用者已採用方案 1。Cloud restore 現已由 UI 與 `SupabaseProvider.restoreBackup()` 雙層 fail-closed；Local／Test atomic restore 保留。這不是 `Accepted` 或 `Completed`，且沒有執行任何 Production restore。

## 實際呼叫鏈

### Settings 雲端 JSON 還原

`Settings.handleFileChange()`
→ `dataProvider.restoreBackup()`
→ `SupabaseProvider.restoreBackup()`
→ 逐表查詢現有 key
→ 逐表、每 100 筆執行 REST delete
→ `db.importData()` 寫本機 cache
→ 逐表呼叫 `saveXXX()`／upsert 回 Supabase

### Inventory「還原上次狀態」

`Inventory.handleRollbackBackup()`
→ `dataProvider.restoreBackup()`
→ 與上方相同 Cloud restore 路徑

### Test／Local

`TestSandboxProvider`／`LocalProvider.restoreBackup()`
→ `db.importData()`

這一條已由 P0-A 改為單一 IndexedDB transaction；但它不能證明 Production Cloud restore 安全。

## 根本原因

Supabase REST 每一次 delete／upsert 都是獨立 HTTP request 與獨立資料庫 transaction。瀏覽器無法把多張表、多個 request 包在同一個 PostgreSQL transaction 裡。

目前流程可能出現：

1. 前幾張表已刪除。
2. 後續 delete、local import 或 upsert 失敗。
3. catch 顯示失敗，但前面已成功的雲端變更不會 rollback。
4. Production 留下部分舊資料、部分新資料或已刪資料。

即使先做完整 JSON 驗證，也只能擋格式錯誤，無法處理第 N 個網路 request／RLS／timeout 失敗。

## 其他資料完整性缺口

現有 Cloud restore 只直接處理：

- inventory
- sales orders／items
- product groups／categories／variants
- purchase batches／items
- private orders／items

目前沒有在這條 Cloud restore 裡完整還原：

- bundle components
- japan packages／items
- outbound shipments／items
- import batches
- dashboard category images／Storage objects

因此即使所有現有 REST request 都成功，也不是目前 ERP 的完整 Production restore。

## 為什麼不能只用 Test Sandbox 驗收

- Test Mode 會選到 `TestSandboxProvider`，不會執行 `SupabaseProvider.restoreBackup()`。
- fail-closed Guard 會阻止 Production Supabase request。
- 在 Test DB 做 A → B → 損壞 C，只能驗證 P0-A 的 IndexedDB 原子性。
- 若用這個結果把 P0-B 標成 Accepted，會錯誤宣稱 Production 跨表 restore 已有 transaction。

## 安全方案

### 方案 1：Cloud restore fail-closed（建議立即止血）

- 雲端模式停用「匯入 JSON 還原」與「還原上次狀態」。
- `SupabaseProvider.restoreBackup()` 在任何寫入前直接拒絕，避免其他 UI 繞過。
- Local／Test atomic restore 保持可用。
- Production 真正事故仍使用已驗證的 PostgreSQL dump，在新 Project 驗證後由受控流程還原。

優點：不改 Schema、不新增 Migration，能立即消除前端半套 restore 風險。

限制：這是風險封鎖，不是提供新的 Cloud atomic restore 能力。Stage 應標記為 `Risk Contained`，不能冒充完整 restore 已實作。

### 方案 2：真正 server-side atomic restore

- 建立 owner-only PostgreSQL function／受控後端 job。
- 在單一 server-side transaction 內完成完整驗證、依 FK 順序 delete/upsert、完整 15+ 集合 restore。
- 任一步 throw，整個 PostgreSQL transaction rollback。
- 先在獨立 Supabase Test Project 以成功 B／故意失敗 C 驗證，再考慮 Production。

此方案必須修改 Supabase function／Migration、Provider 呼叫與權限設計，屬高風險架構變更，不能在目前「不改 Schema／Migration」限制下自行實作。

## 建議

先採方案 1，把已確認危險的 Cloud restore fail-closed；另立高風險專案設計方案 2。不要保留目前前端逐表 restore 並只加 loading／confirm，因為那不會提供 rollback。

## 實作結果與停止點

- 已採方案 1：Cloud／Fallback UI 停用 JSON 還原與上次狀態還原。
- `SupabaseProvider.restoreBackup()` 在任何 Cloud read／write 前丟出 `CloudRestoreDisabledError`。
- Local／Test 仍沿用 P0-A atomic IndexedDB restore。
- 專用自動測試：`npm run test:cloud-restore-fail-closed`。
- 人工 SOP：`docs/p0-b-cloud-restore-fail-closed-manual-acceptance.md`。

目前停止於 `Implementation Passed / Awaiting Manual Acceptance`。Production 0 write、0 restore、0 migration、0 deploy；真正 Cloud atomic restore 仍需另立高風險 server-side transaction 專案。
