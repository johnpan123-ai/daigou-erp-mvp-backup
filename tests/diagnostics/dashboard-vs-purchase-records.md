# Dashboard 與 PurchaseRecords 差異診斷

診斷時間：2026-08-12 22:33（Asia/Taipei）
資料來源：同一時間點由正式雲端 pull 到瀏覽器後匯出的唯讀 JSON 快照（快照本身不提交 Git）。

## 同時間點結果

| 項目 | Dashboard | PurchaseRecords |
|---|---:|---:|
| 商品群組 | 551 | 550 |
| 進行中 | 229 | 228 |
| 已結單 | 322 | 322 |

先前觀察的 `234 / 317` 與 `228 / 322` 不是同一時間點的同一份 React state。重新使用同一份快照後，狀態差只剩 1 筆 metadata 群組。

## 只存在 Dashboard

| group_id | title | closing_date | Dashboard 原因 |
|---|---|---|---|
| `00000000-0000-4000-a000-000000000000` | `WACA_UPDATE_METADATA_DO_NOT_DELETE` | `2026-08-12T05:46:40.289Z` | Dashboard 沒有排除 WACA metadata，日期正規化為 2026-08-12，當日仍算進行中 |

PurchaseRecords 在載入快取及 fresh data 時，都以 `WACA_META_ID` 明確排除此群組，因此總數少 1、進行中少 1。

## 只存在 PurchaseRecords

無。

## 同群組狀態相反

- Dashboard 進行中、PurchaseRecords 已結單：無。
- Dashboard 已結單、PurchaseRecords 進行中：無。

## 仍存在的公式差異風險（固定 fixture 已重現）

若 `closing_date` 是 `08/30` 這類非 `YYYY-MM-DD` 值：

- Dashboard 保留原字串，再和 `YYYY-MM-DD` 做字串比較，會判定已結單。
- PurchaseRecords 無法正規化，會當成沒有有效結單日，因此判定進行中。

此階段只記錄差異，未修改任何統計公式。
