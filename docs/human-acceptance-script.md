# ERP Release Candidate Human Acceptance Script

狀態：供使用者本人執行。需先完成必要 migration apply、Staging deploy 與唯讀 smoke；本文件不授權任何操作。每個寫入案例須用專用 Staging 測試資料，保留 ID 與截圖，不碰 snapshot 還原的真實業務資料。

## A. Catalog

- Route：`/inventory`
- 資料：既有 `FT-20260913-F1E-8M3K` 與 `FT-20260913-LUNA-7Q4-SKU` 作唯讀控制組；新增案例需另行授權唯一 `FT-<date>-CAT-<suffix>` XLS。
- 操作：確認 Cloud/fresh；執行一次既有匯入，價格 10、庫存 2；匯入後先不 F5。
- 預期畫面：新未加入商品同頁出現，既有 KPI 口徑自然收斂，不顯示整體失敗，不建立 Group/Variant。
- authoritative：Inventory 恰好 1、canonical ID/inventory_key 正確、Group 0、Variant 0；兩筆控制組未改。
- 停止：timeout 不收斂、結果不明、duplicate、Group/Variant 被建立、舊 KPI 蓋回、backup gate 失敗。
- 禁止：第二次匯入、手動 full pull、清 cache、按 legacy healthcheck、修改真實商品。
- 截圖/回貼：匯入前後同口徑 KPI、同頁 row、F5 後 row；SKU、canonical ID、inventory_key、實際 dispatch 次數。

## B. Purchasing

- Route：`/purchasing`；禁止進入 `/purchase-records/:id`。
- 資料：Group `6f88e940-203f-4193-b18f-847c99a5e7a1`、Variant `93cb2bac-e5a9-4bc0-a38e-27af08cdcd5e`，先唯讀確認 active 與 `show_in_purchase_list=true`。
- 操作：建立一次 `FT-<date>-F2-<suffix>` Batch，明細 1、quantity 1，Save 一次。
- 預期畫面：Modal 成功後關閉，Batch/Item 同頁出現；pre-RPC 拒絕時 Modal/Draft 保留且 RPC 0。
- authoritative：Batch 1、Item 1、兩個 canonical ID、Group/Variant FK 與 quantity 1；Group/Variant 主檔未改。
- 停止：stale/offline/readiness/permission、unknown result、CAS/server reject、post-commit sync pending；停止後只查狀態，不重送。
- 禁止：double-click、replay、改成本/主檔、進 purchase-records、建立第二批。
- 截圖/回貼：Modal 提交前、同頁結果、F5 後；Batch name/ID、Item ID、idempotency key（不含 token）、RPC 次數。

## C. Japan Package / Receiving

- Route：`/japan-packages` → 新 Package detail。
- 資料：沿用 B 的專用 Batch/Item；Package 名 `FT-<date>-F3-<suffix>`，quantity 1。
- 操作：A1 建 Package 一次；A2 附加該 Purchase Item 一次；B 依 UI 合法流程標記到貨/點收，最後勾選 checked；再取消一次 checked 以驗證 confirmed → arrived，若產品驗收只允許正向流程則此逆向步驟需另行確認。
- 預期畫面：各動作只 dispatch 1 RPC；partial receiving 不提前 confirmed；全數 checked 才 confirmed；problem 狀態不被覆蓋。
- authoritative：Package/Item canonical IDs、FK、quantity、checked/checked_at、status/version 與 canonical result 一致。
- 停止：031 未套用/postflight 不符、pre-RPC blocked、unknown result、CAS conflict、關聯重複、sync pending。
- 禁止：第二次提交、直接 SQL、改 Batch/Item、複製 Auth、清 cache。
- 截圖/回貼：Package list/detail、partial/final receiving、F5 後；Package ID、Item ID、request idempotency key、status/version、RPC 次數。

## D. Outbound

- Route：`/outbound-shipments` → `/outbound-shipments/:id`。
- 資料：沿用 C 已 confirmed/arrived 的專用 Japan Package Item；出庫名 `FT-<date>-F4-<suffix>`，quantity 1。
- 操作：建立 draft；加入 Item；依主操作按鈕走 draft → packing → shipped → received；在 received 勾選 checked。另建一張獨立、無真實資料的刪除專用 shipment，驗證一次原子刪除。
- 預期畫面：Item 可用量不超賣；狀態/日期與 UI 一致；相同 SKU 顯示聚合不造成重複業務 row；刪除成功後 header/items 同時消失。
- authoritative：Shipment/Item IDs、Japan Package Item FK、quantity、checked、status、version；刪除專用 shipment 及其 items 均 soft-deleted，其他 shipment 不變。
- 停止：032 未套用/postflight 不符、任一結果不明、stale CAS、header/items 只刪一邊、sync pending、主資料被意外修改。
- 禁止：桌面狀態列跳步、第二次刪除、手動 item 超量、操作非測試 Package Item、清 cache。
- 截圖/回貼：每個狀態、同頁 item、刪除前後與 F5 後；Shipment/Item IDs、status/version、idempotency key、RPC 次數。

## E. Multi-client 核心行為

- Route：兩個獨立 authenticated Staging browser session 開同一筆專用測試資料（優先 Purchasing 或 Japan Package），不能共用 memory harness。
- A Draft：Client A 修改欄位但不儲存；Client B 儲存另一項變更；等待 realtime/catch-up。A 的 draft 必須保留並提示遠端更新。
- B CAS：B 先儲存同欄位新版本；A 再送 stale save。A 必須被拒絕，B 的值不可被覆蓋。
- C Convergence：A 取消/結束編輯後，兩端不 F5，自動收斂同一 authoritative version/value。
- 停止：draft 消失、stale save 成功、兩端長期不同、重複 mutation、freshness 被錯誤提升。
- 禁止：清 cache、F5 補救、共用 session 模擬兩 client、直接 SQL、操作真實資料。
- 截圖/回貼：兩端操作前/後、衝突提示與最終值；兩個 session 標識（不含 token）、record ID、before/after version、RPC 次數。

## F. Pre-go-live 使用者問題批次

- 近期採購：分別複製單筆商品及整日帳目，貼入試算表；確認每列僅為「商品、數量、單價」三欄，quantity > 1 仍顯示單價而非小計，不同單價不被合併。再於拒絕 Clipboard API 的瀏覽器情境確認 fallback 或明確失敗提示。
- 部分點收：同一 Japan Package 放入兩筆測試 Item；只勾 A 時，Outbound 商品池只出現 A，B 不出現；勾完 B 後 Package confirmed；取消 A 後 A 退出商品池且 Package 回 arrived。確認可用數量沒有重複。
- 出庫列表 context：在每個狀態 tab 設定搜尋字及三種排序，進 Detail 再返回；確認 status/search/sort 均保留，重新整理列表也能由 URL 還原。
- 出庫排序：031/032 不需重套；033 完成 Staging apply/postflight 後，確認「最近狀態變更」依實際狀態時間排序，並分別驗「出庫日期 新→舊／舊→新」。缺少狀態時間的舊資料應穩定排在精確時間資料之後。
- 出庫摘要：確認「運送中」摘要卡已移除，但全部、草稿、打包中、已出貨、已到台灣 tabs、筆數、搜尋、排序及列表內容不變。
- 停止：任一複製內容錯誤、unchecked Item 進池、checked Item 未進池、可用量重複、返回 context 遺失、排序使用 updated_at 偽裝狀態時間，或出現任何非預期 business write。

## 簽核欄位

每項只能填 PASS / FAIL / NOT RUN。FAIL 或 NOT RUN 不得改寫為自動化 PASS；附日期、執行人、Deployment ID、HEAD、Staging ref、證據截圖及 authoritative readback。
