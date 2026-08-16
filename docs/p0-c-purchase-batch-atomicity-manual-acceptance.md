# P0-C 採購批次＋明細原子保存人工驗收 SOP

目前狀態：**Design Gate / Blocked；此 SOP 尚不可執行，也不能標 Accepted。**

只有 server-side transaction／等價的真正 atomic 實作獲准並完成後，才執行以下 Test Sandbox 驗收。

## 驗收頁面

`/purchase-records/<有缺口的測試商品 ID>` → 商品第二層 → `新增採購批次`

## 測試前資料

- Test Sandbox，Production Supabase request 必須為 0。
- 一個有 2～3 個 Variant 且有缺口的測試商品。
- 記錄修改前：purchase batch 筆數、batch item 筆數、各 Variant 已採購與缺口。

## 成功案例

1. 新增採購批次。
2. 三個 Variant 分別填入數量，例如 1／2／3 與有效日幣成本。
3. 按儲存一次。
4. 預期新增 batch 1 筆，items 3 筆。
5. 已採購依 1／2／3 增加，缺口同步減少。
6. F5 後 batch、3 筆 items、已採購與缺口完全一致。
7. 不得產生重複 batch 或孤立 item。

## Failure Injection

由專用 automated fault-injection test 安全模擬「第 N 筆 item 寫入失敗」；不要在 Production 或一般 UI 注入。

預期：

- 儲存顯示失敗，Modal 不假裝成功。
- batch 0 新增、items 0 新增。
- 已採購與缺口完全不變。
- F5 後仍是匯入前狀態。
- 不得留下半套資料。

## Test DB 預期

- 成功：原 batch +1；原 items +3。
- 失敗：batch、items 筆數與 checksum 均等於失敗前。

## 清理與回退

- 人工測試資料以原始 Test Snapshot 重新匯入清理。
- 程式回退：`checkpoint-20260816-2309-before-p0-c-purchase-batch-atomicity`。

## Production

- 人工驗收只能在 Test Sandbox。
- Production：0 write／0 deploy。

