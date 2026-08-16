# P0-E 出庫單＋明細刪除原子性 Design Gate

狀態：**Design Gate / Blocked（未實作、未 Accepted）**  
分析時間：2026-08-16 23:15（Asia/Taipei）  
分析前回復點：`checkpoint-20260816-2315-before-p0-e-outbound-delete-atomicity`

## 現況資料流

`OutboundShipmentDetail.deleteShipment()` 目前依序執行：

1. 從完整 shipment 陣列移除目前單頭。
2. `await dataProvider.saveOutboundShipments(updated)`。
3. 從完整 item 陣列移除該 shipment 的所有明細。
4. `await dataProvider.saveOutboundShipmentItems(updatedItems)`。
5. 返回出庫列表。

兩次 save 各自 await，但兩者之間沒有共同 transaction。第 1 次成功、第 2 次失敗時會留下「單頭已刪除、明細仍存在」；反向補償也不是原子操作。

## Cloud Provider 額外風險

兩個 Cloud save 都先寫本地 IndexedDB，再各自對 Supabase 執行 soft delete／upsert。更重要的是，兩個 soft-delete request 都使用：

```ts
await retrySupabase(...).catch(error => console.error(error));
```

這會把 soft delete 失敗轉成已 resolve 的 Promise：

- UI 呼叫端可能繼續執行並導向列表。
- 本地已移除，但 Cloud `deleted_at` 可能仍為空。
- F5／pull 後，Cloud 舊單頭或舊明細可能重新出現。
- 單頭與明細的失敗也可能各自不同，形成 orphan 或半刪除狀態。

此問題不是 P0 checked save queue 的退化；queue 僅保護出庫 item 點收 save，不涵蓋整張出庫單刪除的兩集合 transaction。

## 為什麼本輪不能安全實作

真正保證整張出庫單刪除「全部成功或完全不變」需要：

1. 單一業務入口，例如 `deleteOutboundShipmentWithItems(shipmentId)`。
2. Local／Test 使用同一 IndexedDB `readwrite` transaction 更新 shipments 與 items。
3. Cloud 使用 PostgreSQL transaction／受控 RPC，同時 soft-delete shipment 與其 items。
4. Provider 契約明確回報成功／失敗；soft-delete error 不得被吞掉。

只在 UI 中交換兩次 save 順序、加 loading、或失敗後重新存舊陣列，都不能保證 Cloud atomicity。依停止條件，這需要 Provider 核心契約與 server-side transaction，不能自行擴大。

## 建議方案

- 新增受控 RPC：以 shipment ID 驗證權限，在單一 PostgreSQL transaction 對單頭與全部明細設定同一 `deleted_at`。
- Local／Test 以同一 transaction 刪除兩個 key 的相關資料。
- UI 在 server commit 前保持頁面，不先顯示成功或導向。
- 失敗時保留原畫面並顯示明確錯誤；重新讀取後仍應看到原單頭與全部明細。
- 專用 failure injection 分別模擬單頭與第 N 筆明細失敗。

## 本階段結論

- 沒有修改 OutboundShipmentDetail、Provider、db.ts、Schema 或資料。
- 沒有刪除任何 Test／Production 出庫資料。
- Production Supabase write：0。
- 狀態是 **Design Gate / Blocked**，不是 Implementation Passed，也不是 Accepted。

