# P0-B：Cloud Restore Fail-Closed 人工驗收 SOP

## Stage

**Implementation Passed / Awaiting Manual Acceptance**

本文件尚未代表 `Accepted` 或 `Completed`。只有依本 SOP 完成人工驗收，並確認 Cloud 業務資料 0 write 後，才能另建 Accepted checkpoint。

## 修正內容

- Cloud／Fallback Mode 的「匯入 JSON 還原」停用並顯示安全原因。
- Cloud／Fallback Mode 的「還原上次狀態」停用並顯示安全原因。
- `SupabaseProvider.restoreBackup()` 無條件先丟出 `CloudRestoreDisabledError`，不執行權限查詢、Supabase select、delete、upsert 或本機 cache import。
- Local／Test Mode 保留 P0-A 的單一 IndexedDB transaction atomic restore。

## 驗收前準備

1. 使用本機 Integration Sandbox，不部署任何版本。
2. 記錄目前 Production 核心表 row count／checksum；只讀，不修改。
3. 在 Test Mode 先下載目前 Test Snapshot，作為測完後復原檔。
4. 若要人工測 Local Mode，先下載 Local JSON；不要用仍有營運用途的 Local DB 直接覆蓋。
5. 成功測試檔：`tests/fixtures/p0-a-atomic-import-valid.json`。
6. 失敗測試檔：`tests/fixtures/p0-a-atomic-import-invalid-collection-8.json`；第 8 個集合 `purchaseBatchItems` 故意不是陣列。

## 一、Cloud Mode：兩個 UI 入口必須不可執行

### Settings

1. 進入「設定」→「資料備份與還原」。
2. 找到「匯入 JSON 還原」。
3. 確認按鈕顯示「Cloud Mode 暫停還原」且不可點擊。
4. 確認畫面顯示：為避免正式資料部分覆蓋，正式還原應使用已驗證的 Database Backup 流程。
5. 開啟 Network，只檢查 ERP 業務 REST；不得出現 restore 所造成的 `DELETE`／`POST`／`PUT`／`PATCH`／upsert。Auth session refresh 不屬於 restore 業務寫入，需另列。

### 商品主檔

1. 進入「商品主檔」→「更多操作」。
2. 確認「Cloud Mode 暫停還原」按鈕不可點擊。
3. 確認選單內顯示同一段安全說明。
4. 不應開啟確認視窗，也不應讀取或套用「上次匯入前備份」。

### 預期結果

- UI 無法選擇 JSON 或開始 restore。
- Production 核心表 row count／checksum 前後完全相同。
- 沒有任何 restore 造成的 Supabase 業務資料 request。

## 二、直接呼叫 Cloud Provider 的防線

執行：

```powershell
npm run test:cloud-restore-fail-closed
```

預期：

- `SupabaseProvider.restoreBackup()` 回報 `CloudRestoreDisabledError`。
- 錯誤訊息包含「Cloud Mode 暫停直接 JSON 還原」。
- 第一筆 Supabase request 前即拒絕；測試記錄 Production Supabase request = 0。
- Test DB、Production IndexedDB 與 Production localStorage checksum 不變。

## 三、Test Mode：P0-A atomic restore 不得退化

### 成功案例

1. 切到 Test Mode。
2. 在設定頁選擇 `p0-a-atomic-import-valid.json`。
3. 確認提示成功後 F5。
4. 預期 Test DB 集合筆數：
   - inventory 1
   - salesOrders 1、salesOrderItems 1
   - productGroups 1、productCategories 1、productVariants 2
   - purchaseBatches 1、purchaseBatchItems 2
   - privateOrders 1、privateOrderItems 1
   - japanPackages 1、japanPackageItems 1
   - outboundShipments 1、outboundShipmentItems 1
   - bundleComponents 1、importBatches 1
5. 商品、Variant、採購、日本包裹與出庫都應為同一份 B 資料，不得混入匯入前 A 資料。

### 失敗案例

1. 以上述成功結果 B 作為目前 Test DB。
2. 匯入 `p0-a-atomic-import-invalid-collection-8.json`。
3. 畫面必須顯示「還原失敗，資料未套用；匯入前的原有資料已完整保留」。
4. F5。
5. Test DB 必須完整維持 B；不得變成 0 筆，也不得前 7 個集合已清空、第 8 個才失敗。

## 四、Local Mode：本機 restore 仍可用

1. 使用已備份或全新隔離的 Local browser profile，切到 Local Mode。
2. 匯入成功 fixture，F5 後確認上述 16 集合筆數。
3. 再匯入損壞 fixture，確認失敗並 F5。
4. Local DB 必須完整保留成功 fixture；不應發出 Supabase request。
5. 驗收完成後匯回步驟前的 Local JSON，不要把測試 fixture 留在日常 Local DB。

## 不應改變的核心數字

- Production 商品、Variant、採購批次／明細、私人訂單、日本包裹、出庫等所有 row count／checksum。
- Test／Local 成功還原以外的任何資料庫。
- 需求、WACA、已採購、缺口、待採購與 Dashboard KPI 計算公式。

## 失敗模擬與正確提示

- 格式失敗：使用第 8 集合損壞 fixture；必須提示「資料未套用」。
- transaction 中途失敗：`npm run test:atomic-import-data` 會注入第 8 集合 `put` 失敗；Test DB 必須 rollback。
- Cloud 直接呼叫：`npm run test:cloud-restore-fail-closed`；必須先拋錯且 Supabase request = 0。
- UI 不可把失敗顯示成「還原成功」或「0 筆資料」。

## 驗收後清理／回退

- Test DB：重新匯入驗收前下載的 Test Snapshot，或用 Settings「清空 Test Sandbox」後重建測試資料。
- Local DB：重新匯入驗收前的 Local JSON。
- 程式回退：`checkpoint-20260816-2218-before-p0-b-cloud-restore-fail-closed`。
- 不要使用 `git reset --hard`；需要回退時從 checkpoint 建新分支或精準 revert P0-B implementation commit。

## Production

**0 write / 0 restore / 0 migration / 0 deploy**
