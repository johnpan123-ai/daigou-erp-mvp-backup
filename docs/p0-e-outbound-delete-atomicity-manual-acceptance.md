# P0-E 出庫單＋明細刪除人工驗收 SOP

目前狀態：**Design Gate / Blocked；此 SOP 尚不可執行，也不能標 Accepted。**

只有真正 atomic 的 Local／Cloud 刪除入口獲准並完成後，才在 Test Sandbox 執行。

## 驗收頁面

`/outbound-shipments` → 開啟一張專用測試出庫單。

## 測試前準備

- Test Sandbox；Production Supabase request 必須為 0。
- 建立 shipment A，含 3 筆 items；記錄 shipment ID、三個 item ID、總件數、checked／checked_at。
- 另保留 shipment B 作為不應受影響的控制組。
- 記錄 outbound_shipments／outbound_shipment_items 筆數與 checksum。

## 成功案例

1. 開啟 shipment A，按「刪除出庫單」並二次確認。
2. 預期成功後才返回列表。
3. shipment A 不存在；三筆 A items 全部不存在。
4. shipment B 的單頭、items、checked／checked_at 完全不變。
5. F5 後結果一致，不得重新出現 A 或 orphan items。

## Failure Injection

1. 回到刪除前 Snapshot。
2. 以 Test-only 注入模擬第 2 筆 item soft-delete 失敗。
3. 再刪除 shipment A。
4. 畫面必須提示刪除失敗，不能導向或顯示成功。
5. F5 後 shipment A 與三筆 items 必須全部存在，checksum 等於失敗前。
6. 不得出現單頭消失、只剩明細，或只刪部分 item。

## Test DB 預期

- 成功：shipment -1；items -3。
- 失敗：shipment、items 筆數與 checksum 0 變更。
- 其他出庫單 0 變更。

## 清理與回退

- 人工資料以原始 Test Snapshot 重匯清理。
- 程式回退：`checkpoint-20260816-2315-before-p0-e-outbound-delete-atomicity`。
- Production：0 write／0 deploy。

