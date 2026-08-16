# P0-D Inventory XLS＋訂購紀錄同步人工驗收 SOP

目前狀態：**Design Gate / Blocked；此 SOP 尚不可執行，也不能標 Accepted。**

只有複合 Provider 契約與真正 atomic 的 Local／Cloud 實作獲准並完成後，才在 Test Sandbox 執行。

## 驗收頁面

`/inventory`（商品主檔）

## 測試前準備

- Test Sandbox；Production Supabase request 必須為 0。
- 匯入前 Snapshot A，記錄 Inventory、ProductGroup、Category、Variant 筆數與 checksum。
- 一份小型 XLS B，包含可識別的新 SKU、既有 SKU 更新與至少一個會建立／補齊 Variant 的項目。
- 預先建立 Test-only failure injection；不得在 Production 啟用。

## 成功案例

1. 在商品主檔選擇 XLS B。
2. 確認先下載非空且可重新 parse 的 JSON backup。
3. 匯入成功後確認 Inventory 與訂購紀錄同步資料都已更新。
4. 記錄新 SKU、ProductGroup、Variant 筆數與關聯。
5. F5 後重新確認兩邊完全一致。
6. 不得出現 Inventory 有資料、PurchaseRecords 沒有對應資料，或反向不一致。

## Failure Injection

1. 回到 Snapshot A。
2. 在 atomic transaction 的 Category／Variant 階段注入失敗。
3. 再匯入 XLS B。
4. 畫面必須顯示「匯入未套用」的明確錯誤，不能顯示成功報告。
5. F5 後 Inventory、ProductGroup、Category、Variant 的筆數與 checksum 必須全部等於 A。
6. 不得只留下 Inventory 或部分 Variant。

## Test DB 預期

- 成功：所有受影響集合一次變成 B 的一致狀態。
- 失敗：所有受影響集合 0 變更；不能是半套資料。
- Production IndexedDB／localStorage／Supabase 全部不變。

## 不應改變的數字

匯入 fixture 未涵蓋的 WACA、私人訂單、已採購、缺口、待採購、日本包裹與出庫資料不應改變。

## 清理與回退

- 重匯 Test Snapshot A 清理人工資料。
- 程式回退：`checkpoint-20260816-2312-before-p0-d-inventory-sync-atomicity`。
- Production：0 write／0 deploy。

