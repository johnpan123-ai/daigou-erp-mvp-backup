# P0-C 採購批次＋明細原子保存 Design Gate

狀態：**Design Gate / Blocked（未實作、未 Accepted）**  
分析時間：2026-08-16 23:09（Asia/Taipei）  
分析前回復點：`checkpoint-20260816-2309-before-p0-c-purchase-batch-atomicity`

## 現況與可重現競態

`PurchaseBatchModal.handleAddBatchSubmit()` 的新增與編輯流程都依序執行：

1. `dataProvider.savePurchaseBatches(...)`
2. `dataProvider.savePurchaseBatchItems(...)`

若第 1 步成功、第 2 步失敗：

- 新增可能留下沒有明細的 `purchase_batch`。
- 編輯可能留下已更新的批次 metadata，但明細仍是舊資料。
- 已採購與缺口依明細計算，因此畫面可能同時存在批次標頭與不一致的採購數字。

Cloud Provider 會在每一步先改本地快取，再各自透過 Supabase REST upsert／soft-delete。兩個方法各自有 error handling，但兩者之間沒有共同 transaction。

## 為什麼本輪不能用前端 compensation 冒充 atomic

在第二步失敗後重新呼叫 `savePurchaseBatches(oldBatches)` 只是第三次獨立 REST 寫入；它也可能失敗、逾時或和其他使用者寫入競爭。這只能是 best-effort compensation，不能保證「全部成功或完全沒改」。

Local／Test IndexedDB 可以使用單一 `readwrite` transaction 同時寫兩個 key，但要安全接入現有 UI，至少需要新增一個複合資料層操作並擴充 Provider 契約。Cloud 仍需獨立的 server-side transaction。依本輪硬性停止條件，這屬 Provider 核心契約／RPC Design Gate，不能自行擴大。

## 安全可選方案

### 建議方案：server-side transaction

- 新增受控 RPC／Edge endpoint，例如 `save_purchase_batch_with_items`。
- 輸入完整 batch 與 items draft。
- PostgreSQL transaction 內驗證 IDs、寫 batch、替換該 batch items。
- 任一步失敗由資料庫 rollback。
- Local／Test Provider 以單一 IndexedDB transaction 實作相同業務契約。
- UI 只呼叫一個 `savePurchaseBatchWithItems()`，並有 submitting lock／明確錯誤。

### 可接受的暫時止血

- 在 Cloud Mode 暫停新增／編輯採購批次，直到 server-side transaction 完成。
- 這會直接阻擋正式核心作業，因此必須由使用者明確批准，今晚不自行啟用。

### 不建議

- 只加 loading／disabled。
- 第二步失敗後 best-effort 寫回舊陣列。
- 先存 items 再存 batch（只會把 orphan 方向反過來）。
- 在 Browser 端把兩個 Supabase REST request 稱為 transaction。

## 本階段結論

- 沒有修改 `PurchaseBatchModal`、Provider、db.ts、Schema 或資料。
- 沒有 Failure Injection 寫入 Test DB，因為目前沒有可 rollback 的安全邊界；現有來源碼已足以證明兩次獨立提交。
- Production Supabase write：0。
- 下一步需要批准 Provider 複合契約＋Cloud server-side transaction，或批准 Cloud 暫停此功能。

