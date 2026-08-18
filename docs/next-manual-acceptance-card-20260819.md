# Next Sandbox — Manual Acceptance Card

以下只列需要人工確認的項目；自動測試已證明的隔離、atomic rollback、P0-G fault guard 不需重複操作。

## 第一件：單價編輯

- 網址：`http://127.0.0.1:4192/purchase-records/<商品群組 ID>`
- 操作：進入編輯模式，修改一個 `default_jpy_cost`，離開欄位，重新整理。
- 預期：單價可輸入；寫入 `product_variants.default_jpy_cost`；F5 後保留；鎖定模式回到唯讀。
- 安全：只在 Next DB；確認沒有 Supabase request。

## 第二件：Product Identity / Supplier

- 網址：`http://127.0.0.1:4192/purchase-records`
- 準備：三個 Golden Case：橘雪莉 L Size、figma 路西法、峰月律 3121。
- 操作：只執行自動查詢結單日，不要批量儲存其他商品。
- 預期：先確認 Product Identity；同商品 Wanrong 優先；ambiguous/no-match 不寫入。

## 第三件：採購批次複製

- 網址：任一商品第二層 →「採購批次紀錄」。
- 操作：複製本批次帳目，貼到純文字或試算表；再到「近期採購」複製當日帳目。
- 預期：每列只有 `商品名稱<TAB>數量`，沒有批次標題、日期、成本、空白列；原始批次筆數不變。

## 第四件：Read Failure 行為

- 網址：Next 測試 origin 的 Test-only fault injection。
- 操作：注入 Variants 或 ProductGroups read failure，再打開 Purchasing／Product detail；不要按任何儲存、刪除、同步。
- 預期：顯示明確 Error，而不是「0 筆」；若進入 destructive flow，應直接禁止。

## 第五件：資料鎖定確認

- 操作：只做 Dashboard、PurchaseRecords 搜尋／排序、Japan Package 展開、Outbound 展開、F5 與路由切換。
- 預期：Golden Sample、Variant IDs、orphan 與 Test DB checksum 不變；Production Supabase request = 0。
