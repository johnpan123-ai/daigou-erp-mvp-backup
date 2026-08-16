# P0-D Inventory XLS／訂購紀錄同步原子性 Design Gate

狀態：**Design Gate / Blocked（未實作、未 Accepted）**  
分析時間：2026-08-16 23:12（Asia/Taipei）  
分析前回復點：`checkpoint-20260816-2312-before-p0-d-inventory-sync-atomicity`

## 現況資料流

`Inventory.handleFileChange()` 在 XLS 解析後依序執行：

1. `dataProvider.upsertInventory(itemsWithBatchMeta)`
2. `dataProvider.syncProductGroupsWithInventory()`
3. `loadItems()`

第一步已經改寫 Inventory；第二步才依 Inventory 更新 ProductCategory／ProductVariant。任一步失敗都沒有涵蓋兩段操作的共同 transaction。

Cloud Provider 的實際範圍更大：

- `upsertInventory()` 先更新本地 IndexedDB，再對 `inventory_items` 執行 residue delete 與完整 upsert。
- `syncProductGroupsWithInventory()` 先更新本地 ProductGroup／Category／Variant，再分別保存 categories 與 variants 到 Supabase。
- 上述 delete、upsert、category save、variant save 都是彼此獨立的提交。

因此可能出現：Inventory 已是新 XLS，但 ProductGroup／Variant 仍是舊狀態；或 Local cache 已更新、Cloud 只完成部分集合。

## 匯入前 JSON Backup 的限制

目前匯入前會先產生可解析、非空的 JSON backup；backup 失敗會阻止 XLS 匯入。這是必要的人工回復點，但不是 transaction：

- 第二段失敗時不會自動 rollback 第一段。
- P0-B 已明確停用 Cloud JSON restore，不能用自動 restore 當 Cloud compensation。
- 即使重新呼叫多個 save 還原，也只是另一組可能失敗或與其他寫入競爭的 request。

## 為什麼本輪不能安全實作

真正保證「Inventory 與訂購紀錄全部成功，或全部不變」需要：

1. 一個複合資料層入口，例如 `importInventoryAndSyncProducts()`。
2. Local／Test 使用涵蓋所有受影響 key 的單一 IndexedDB `readwrite` transaction。
3. Cloud 使用 PostgreSQL transaction／受控 RPC，包含 residue 清理、Inventory 寫入與 Category／Variant 同步。
4. Provider 契約與 Cloud server endpoint 的一致錯誤語意。

這會修改 Provider 核心契約並需要 server-side transaction。依本輪停止條件，不得以 UI loading、前端 rollback 或多次 REST request 冒充原子性。

## 建議方案

- 先建立純函式 staged plan：解析 XLS 後計算 Inventory／Category／Variant 的完整 next state，提交前不寫資料。
- 由單一 server-side transaction 驗證並一次套用 staged plan。
- Local／Test 以單一 IndexedDB transaction 實作相同契約。
- 加入 Test-only failure injection，分別在 Inventory、Category、Variant 寫入點失敗，確認 checksum 完全不變。
- 保留現有匯入前 JSON backup，作為 transaction 以外的額外人工保護。

## 本階段結論

- 沒有修改 Inventory、Provider、db.ts、Schema 或資料。
- 沒有執行 XLS 寫入或 failure injection。
- Production Supabase write：0。
- 狀態是 **Design Gate / Blocked**，不是 Implementation Passed，也不是 Accepted。

