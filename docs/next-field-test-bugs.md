# Next Field Test Bugs

## Next Field Test Bug — Unit Price Editing Regression

- **Status:** Implementation Passed / Awaiting Manual Acceptance
- **Detected:** 2026-08-18（Asia/Taipei）
- **Scope:** PurchaseManagement 商品規格表的預設單價欄位
- **Production write:** 0
- **Data modification during diagnosis:** 0

### 目前診斷

目前 `PurchaseManagement.tsx` 的日幣／台幣單價欄位不是永久唯讀，而是依以下條件決定：

```tsx
editMode && canWrite
```

條件成立時 render numeric `<input>`；否則 render `¥ amount`、`NT$ amount` 或 `-` 的文字。

`editMode` 初始值來自 `localStorage['purchase_management_edit_mode']`，沒有記錄時預設為 `false`。頁面右下角的浮動按鈕在 `🔒 已鎖定` 與 `✏️ 編輯中` 間切換此狀態。`canWrite` 則由 `dataProvider.canWriteCloud()` 決定。

因此目前看到已有單價只顯示文字、沒有單價輸入框，最直接的原因是頁面仍處於鎖定模式，或 `canWrite` 未通過；目前沒有證據顯示單價資料被刪除或被改成唯讀資料欄位。

另有一個需要下一輪確認的顯示／編輯來源落差：鎖定模式的文字顯示順序是 `default_jpy_cost`／`default_twd_cost`，找不到時再 fallback 到最近採購批次的 `purchase_batch_items.cost`；但解鎖後 input 草稿只讀 `default_*_cost` 與 legacy localStorage map，不會把最近批次成本帶入 input。因此畫面曾顯示最近批次價格時，切換編輯後可能看到空白 input。這是 UI／ViewModel 來源一致性問題，不代表資料已被刪除。

### 截圖後的確定根因

截圖顯示底部已是「編輯中」，因此已排除單純未切換 edit mode。Next／Test 的 `dataProvider` 目前使用 `TestSandboxProvider`；它繼承可寫入隔離 Test DB 的 `LocalProvider`，但刻意將 `canWriteCloud()` 固定回傳 `false`，以避免被誤認為具有 Cloud 寫入權限。

`PurchaseManagement` 的 `loadData()` 卻把 `await dataProvider.canWriteCloud()` 結果存到 `canWrite`，並用 `editMode && canWrite` 控制所有單價 `<input>`。因此在 Test Mode：

- 編輯按鈕可以顯示「編輯中」；
- 本地 Test DB 實際具備 `updateProductVariantPatch()` 寫入能力；
- 但 `canWriteCloud() === false` 讓單價 input 不 render，改顯示文字；
- 這是「Cloud write capability」與「Sandbox local write capability」被混用造成的 UI 權限判斷錯誤。

Cloud Guard 沒有被繞過，因為本次沒有執行任何寫入。Production 的 `canWriteCloud()` 則依 owner／staff／helper role 判斷，故 Production 不會以同一原因隱藏 input。

### Production／歷史比對

- Production `c3756cd55e90658546a1936c6549411c540351f3` 仍保留相同的 `editMode && canWrite` 單價 input 分支。
- Next HEAD `658045f3120d594d23db254060d750b972476617` 的相關單價條件與 Production 基準一致；`git diff` 沒有發現本次整合把單價 input 移除的修改。
- `615c2ec` 首次加入預設日幣單價輸入與 `editMode ? input : display` 行為。
- `78d0239`、`a899fd8` 修改的是單價儲存／draft race 行為，不是移除 input。`a899fd8` 改為 draft 後 blur／Enter 儲存。
- 在 `615c2ec` 之前的 `615c2ec^`，主商品表尚未提供這個預設單價編輯入口；因此目前找不到「原本可編輯、後來被某一個 Commit 改成唯讀」的回歸 Commit。

### 資料欄位與影響

- 日本商品預設單價：`product_variants.default_jpy_cost`
- 代理版預設台幣單價：`product_variants.default_twd_cost`
- 儲存流程：`handleUpdateDefaultJpyCost`／`handleUpdateDefaultTwdCost` → `dataProvider.updateProductVariantPatch()`。
- `purchase_batch_items.cost` 是既有採購批次的實際採購單價，與 ProductVariant 預設單價分開。
- 修改預設單價不會回寫既有採購批次成本，也不會直接改變已採購數量、缺口或採購明細。
- 新增採購批次時，預設單價可能作為新 Modal 的初始值；運費分攤仍作用於目前 Modal draft 的採購單價。

### 初步判定

- **Root cause：** Test Mode 將 `canWriteCloud() === false` 錯誤當成不可編輯本地 Test DB，導致 `editMode && canWrite` 單價 input 被隱藏。
- **UI regression：** 尚未證明是某個 Commit 移除功能；較像使用者不知道要先切換 `🔒 已鎖定`，或目前頁面未提供足夠明顯的單價編輯入口。
- **資料遺失／被覆蓋：** 本次唯讀診斷未發現，也沒有執行任何寫入測試。
- **影響：** 目前主要是無法方便修改 ProductVariant 預設單價；不代表既有採購批次成本遺失。
- **最小待決方案：** 下一輪只改善單價欄位的編輯入口／提示，或明確讓商品單價欄位在可寫的編輯模式中直接顯示 input；需先確認是否要保留全頁編輯鎖定與 `canWrite` 權限規則。

### 本輪最小修正（等待人工驗收）

- `PurchaseManagement` 將「Cloud 寫入能力」與「目前資料模式可寫」分開判斷：`local`、`test`、`next`、`experimental` 允許編輯自己的本地資料；Cloud Mode 仍完全依 `canWriteCloud()`。
- 未修改 `TestSandboxProvider.canWriteCloud()`，因此 Sandbox 的 Production Supabase fail-closed 語意不變。
- 單價仍透過既有 `updateProductVariantPatch()` 寫入 `product_variants.default_jpy_cost`／`default_twd_cost`；數量、採購批次與核心計算未改動。
- 自動驗證已確認 Next 編輯模式會顯示單價輸入框；人工驗收需再確認實際修改、F5 保留、離開編輯模式回唯讀，以及 Cloud 訪客權限不變。
