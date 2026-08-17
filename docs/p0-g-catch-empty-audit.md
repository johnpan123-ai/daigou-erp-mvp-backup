# P0-G 延伸 Audit：讀取失敗偽裝成空資料

本文件只盤點，不修改列出的其他流程。

## P0 候選

| 位置 | 模式 | 風險 | 建議下一步 |
| --- | --- | --- | --- |
| `src/pages/Purchasing.tsx:309-317` | 9 個核心集合各自 `.catch(() => [])` | 任一讀取失敗會產生混合快照：部分新資料、部分空資料。畫面可能將錯誤當成 0 筆，若後續批量操作使用此 state，存在覆蓋／誤判風險 | 另開 Stage，改為全體 load failure 與 Error UI；先確認所有寫入 handler 是否使用這批 state |
| `src/pages/JapanPackageDetail.tsx:477-482` | Group／Variant／Category／Batch／BatchItem／Bundle 各自 `.catch(() => [])` | 包裹本體可能正常，但商品 metadata 失敗被顯示成未知／空；使用者仍可進行包裹操作，容易把資料故障誤判為資料不存在 | 另開 Stage，metadata load 必須有明確 Error 並封鎖依賴 metadata 的新增／批次匯入 |
| `src/pages/PurchaseManagement.tsx:1139` | Bundle Components 讀取失敗回 `[]` | 畫面會把「讀取失敗」當成「套組沒有內容」；若使用者接著儲存套組，可能誤覆蓋既有關聯 | 另開 Stage，Bundle load failure 應禁止開啟／儲存設定 Modal |

## P1

| 位置 | 模式 | 風險 |
| --- | --- | --- |
| `src/pages/JapanPackagesList.tsx:218-225` | 外層 catch 只寫 console，finally 關閉 loading | 讀取錯誤後可能顯示空清單，Error 與 Empty 未區分 |
| `src/pages/JapanPackageDetail.tsx:491-494` | 外層 catch 只寫 console，finally 關閉 loading | 依賴集合失敗後頁面可能繼續以部分 state 呈現 |
| `src/pages/Purchasing.tsx:330-333` | 外層 catch 無 UI Error | 若非內部 `.catch([])` 的錯誤發生，使用者仍只看到 loading 結束 |

## P2／非業務資料 fallback

- `variant_default_jpy_costs`／`variant_default_twd_costs` localStorage JSON parse failure 回 `{}`：不會直接破壞 DB，但沒有提示設定損壞。
- 日期顯示格式化 catch 回空字串：只影響顯示。

## 結論

本次事件證明 `.catch(() => [])` 不能再一律視為低風險。凡空集合會參與後續 write、sync、delete、replace 或關聯編輯，至少升為 P0 候選；先建立 fault injection 與 0-write Gate，再逐頁修正，不能在 P0-G 中一次大改。

