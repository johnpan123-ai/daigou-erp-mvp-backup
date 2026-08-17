# Next Sandbox Manual Acceptance Card

狀態：自動驗證完成，等待人工驗收。  
網址：`http://127.0.0.1:4192/`  
環境：Next Sandbox；不是 Production。所有操作只允許使用 Next DB。

## 第一件：P0-G Production-like Hotfix

**要驗什麼：** Hotfix 正常流程與 Variant Read Failure fail-closed。  
**網址：** Production-like 本機 `/inventory`（依 `docs/p0-g-production-hotfix-acceptance-report-20260818.md` 啟動，不要用正式網站）。  
**操作：** 用固定 Snapshot 建立全新資料；執行一次 Inventory XLS → sync → F5；再啟用 Test-only Variant read failure → sync → F5。  
**預期：** 正常時 IDs／WACA／已採購不變；故障時顯示「商品規格資料讀取失敗，為保護既有採購關聯，本次同步已取消。」且沒有資料變動。  
**需要幾分鐘：** 10–15 分鐘。

## 第二件：Next 純讀取資料鎖定

**要驗什麼：** 純瀏覽、搜尋、切頁、F5 不會自行改變 Next 資料。  
**網址：** `http://127.0.0.1:4192/`。  
**操作：** 依序查看 Dashboard、訂購紀錄、採購總表、日本包裹、出庫、近期採購；在訂購紀錄搜尋一次；F5 兩次。  
**預期：** Test banner 保持；VSPO Golden 仍為 WACA `4/3/0/0/2`、已採購 `9/19/0/2/13`；批次商品不變成未知商品。  
**需要幾分鐘：** 5 分鐘。

## 第三件：Read Failure 不得被誤認為空資料

**要驗什麼：** 已知 Variant fault path 的錯誤呈現與資料保護。  
**網址：** `http://127.0.0.1:4192/inventory?simulateVariantReadFailure=1`。  
**操作：** 在 Test Sandbox 執行會觸發 Variant sync 的測試入口；不要在 Production 開啟或操作。  
**預期：** 顯示明確錯誤／取消同步，不顯示「0 筆」來代替既有 2438 Variants；F5 後 Golden 與批次名稱不變。  
**需要幾分鐘：** 3 分鐘。

## 第四件：已完成 UI 功能交叉查看

**要驗什麼：** 既有功能沒有因穩定性測試退化。  
**網址：** `/purchase-records`、`/recent-purchases`、`/purchasing`、`/japan-packages`、`/outbound-shipments`。  
**操作：** 查看第二層官網、近期採購日期收合／proxy 標籤、採購按鈕層級、套組「商品名稱｜規格／SKU」、出庫 SKU／點收與匯出入口。  
**預期：** 只讀功能可用；不建立、不修改、不刪除測試資料。  
**需要幾分鐘：** 10 分鐘。

## 第五件：Sandbox 隔離確認

**要驗什麼：** Test 操作不碰 Production。  
**網址：** `/settings`（只在 Test banner 下）。  
**操作：** 確認 Test Owner、Test DB 名稱與 Test banner；不要執行 Cloud restore。  
**預期：** Test Mode 顯示「測試模式｜所有修改只存在本機，不會寫入正式雲端」；Production Supabase request = 0；不得出現 Production 資料被改動。  
**需要幾分鐘：** 3 分鐘。

人工驗收完成前，所有 Stage 只能標示 `Implementation Passed / Awaiting Manual Acceptance`，不可自行標 Accepted。
