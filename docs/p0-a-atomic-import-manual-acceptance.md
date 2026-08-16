# P0-A：`importData()` 原子化人工驗收 SOP

## Stage

**Implementation Passed / Awaiting Manual Acceptance**

在人工完成「成功匯入、F5、失敗檔匯入、再次 F5」以前，不得標記 `Accepted` 或 `Completed`。

## 修正內容

- 一般 JSON 還原的 15 組核心集合必須先全部通過格式驗證。
- `importBatches` 為相容舊版備份的可選集合；缺少時以空陣列匯入。
- 所有集合使用同一個 IndexedDB `readwrite` transaction。
- 任一集合寫入失敗時整個 transaction abort；匯入前資料完整保留。
- 失敗提示明確顯示「資料未套用；匯入前的原有資料已完整保留」。
- 不修改 Provider、Schema、Supabase、資料公式或 Production 資料。

## 驗收前準備

1. 僅使用 Test Sandbox：`http://127.0.0.1:4192/settings`。
2. 頁面頂端必須顯示 Test Sandbox 警示；不得在 Cloud／Production 執行。
3. 先用「Test Sandbox 資料管理 → 匯入正式版 JSON 快照」匯回一份既有測試 Snapshot，作為基準 A。
4. 記錄基準 A 畫面上的商品、Variant、採購批次、日本包裹、出庫筆數。
5. 本次要測的是上方「資料備份與還原 → 匯入 JSON 還原」，不是紫色的 Test Snapshot 匯入按鈕。

## 成功案例：A 全部換成 B

### 操作

1. 進入「設定」。
2. 在「資料備份與還原」找到「匯入 JSON 還原」。
3. 點「匯入還原」。
4. 選擇：
   `tests/fixtures/p0-a-atomic-import-valid.json`
5. 等待「資料還原成功！」。
6. 檢查設定頁數量。
7. 分別進入訂購紀錄、採購批次、日本包裹、出庫頁確認 B 資料。
8. 按 F5，再重複確認。

### 預期結果

- Inventory：1 筆。
- Sales Orders：1 筆。
- Sales Order Items：1 筆。
- Product Groups：1 筆，名稱為「P0-A 新資料商品」。
- Product Categories：1 筆。
- Variants：2 筆。
- Purchase Batches：1 筆。
- Purchase Batch Items：2 筆。
- Private Orders／Items：各 1 筆。
- Japan Packages／Items：各 1 筆。
- Outbound Shipments／Items：各 1 筆。
- Bundle Components：1 筆。
- Import Batches：1 筆。
- F5 後仍完全相同。
- 不得混入基準 A 的舊商品、舊採購批次、舊日本包裹或舊出庫項目。

## 失敗案例：第 8 集合格式錯誤

### 操作

1. 保留成功案例完成後的 B，不要先清資料。
2. 再次點「資料備份與還原 → 匯入 JSON 還原」。
3. 選擇：
   `tests/fixtures/p0-a-atomic-import-invalid-collection-8.json`
4. 這個檔案故意把第 8 組 `purchaseBatchItems` 改成物件而不是陣列。
5. 關閉錯誤提示後按 F5。
6. 再次檢查成功案例的全部筆數與 B 資料。

### 預期結果

- 畫面顯示：「還原失敗，資料未套用；匯入前的原有資料已完整保留。」
- 不得顯示成功。
- F5 後仍完整維持 B。
- Product Groups 仍 1、Variants 仍 2、Purchase Batches 仍 1、Purchase Batch Items 仍 2。
- 日本包裹、出庫、私人訂單、Bundle 都仍為 B，不能變成 0，也不能只換掉前 7 組。

## Test DB 與不應改變的數字

- 成功匯入後，Test DB 的 16 個集合筆數必須符合上方 B 清單。
- 失敗匯入前後，Test DB checksum 與各集合筆數必須完全相同。
- Production IndexedDB、Production localStorage、Production Supabase row count 全部不得改變。
- Production Supabase request 必須為 0。
- 本測試不應改變任何需求、WACA、已採購、缺口或待採購公式；成功案例數字變化只來自刻意把 Test DB A 替換為 B。

## 自動失敗注入證據

`npm run test:atomic-import-data` 另會在第 8 集合 `erp_purchase_batch_items` 的 IndexedDB `put` 強制丟錯，確認不是只有格式驗證：

- transaction 會 abort。
- 前 7 組不會殘留新資料。
- F5 後仍完整保留基準 A。
- 成功匯入 B 後 16 組集合與 fixture 完全一致。

## 失敗時畫面

- 使用者必須看到明確失敗提示。
- 不得顯示「還原成功」。
- 不得顯示 0 筆來掩蓋匯入失敗。
- 原資料仍可正常瀏覽。

## 測完清理／回復

1. 仍在 Test Sandbox 的「設定」。
2. 使用「Test Sandbox 資料管理 → 匯入正式版 JSON 快照」。
3. 選擇原本的 `workbench-backup-*.json`，重新建立平常使用的 Test Snapshot。
4. 不得使用 Cloud Restore，不得切到 Production 匯入。
5. 程式碼回退點：`checkpoint-20260816-2117-before-p0-a-atomic-import`。

## 驗收紀錄（待人工填寫）

- 成功案例：待驗收
- 成功後 F5：待驗收
- 失敗案例：待驗收
- 失敗後 F5：待驗收
- Production 0 write：待驗收
- 最終 Stage：維持 **Implementation Passed / Awaiting Manual Acceptance**
