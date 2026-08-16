# P0-F Bootstrap crash 保護人工驗收 SOP

目前狀態：**Accepted（2026-08-17，Asia/Taipei）**
使用者已確認 Test-only 故障頁、錯誤代碼、重新載入入口、無白畫面，以及回正常網址後 ERP 可正常使用。

## 驗收頁面

- 正常頁：`http://127.0.0.1:4192/`
- Test-only 故障頁：`http://127.0.0.1:4192/?simulateBootstrapError=1`

## 測試前準備

1. 確認目前模式為 Test，頂部有 Test Sandbox 警示。
2. 記錄 Test DB 核心集合筆數與 checksum。
3. 確認 Network 內 Production Supabase request 為 0。

## 正常案例

1. 開啟正常頁。
2. 預期 Dashboard 正常顯示，不出現錯誤頁。
3. F5 後仍正常；Test Owner 與 Test DB 資料保留。
4. Console 不得有 bootstrap error。

## Failure Injection

1. 開啟 `/?simulateBootstrapError=1`。
2. 預期不白畫面，顯示：
   - `系統啟動失敗`
   - `錯誤代碼：BOOTSTRAP_FAILED`
   - `重新載入`按鈕
3. 畫面不得顯示原始 exception、Token、URL key 或其他敏感資訊。
4. Console 可以看到預期的 `[Bootstrap Fatal]`，但不得有未處理的 blank-screen rejection。
5. 移除 query string 後開啟正常頁，應立即恢復。

## F5 與重新載入

- 在故障 URL 按 F5，仍應顯示可操作錯誤頁。
- 「重新載入」會重載同一 URL，因此測試故障仍存在時會再次顯示錯誤頁，這是預期結果。
- 移除 `simulateBootstrapError=1` 後重新載入，ERP 應正常。

## Test DB 與核心數據

- 此故障發生在 App／Provider 載入前，不得執行 save、clear 或 import。
- 測試前後 Test DB 所有集合筆數與 checksum 必須完全一致。
- Production IndexedDB／localStorage／Supabase 必須完全不變。

## 清理與回退

- 清理：關閉故障分頁或移除 query string；不需要清資料。
- 程式回退：`checkpoint-20260816-2317-before-p0-f-bootstrap-failure-boundary`。
- Production：0 write／0 deploy。

## 人工驗收紀錄

- `?simulateBootstrapError=1`：成功顯示「系統啟動失敗」。
- 錯誤代碼：`BOOTSTRAP_FAILED` 正常。
- 「重新載入」入口存在。
- 沒有白畫面。
- 回到正常網址後 ERP 可正常使用。
- 結論：**Accepted**。
