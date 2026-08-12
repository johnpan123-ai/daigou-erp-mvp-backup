# ERP 核心數據自動回歸

這組測試是修改同步、商品、Variant、Inventory、訂購紀錄表、採購總表或首頁前的安全網。

## 執行方式

```powershell
npm.cmd run test:core
```

測試會自動：

1. 啟動獨立 Vite 測試伺服器。
2. 使用獨立的無痕 Chrome 測試環境。
3. 強制設定為 Local Mode。
4. 將 `fixtures/core-regression.json` 寫入該測試環境的 IndexedDB。
5. 攔截全部 `*.supabase.co` 請求；測試期間若發生任何 Supabase 連線即失敗。
6. 從現行 Dashboard 與 PurchaseRecords UI 讀取 KPI、分類與分頁數量。
7. 在瀏覽器中直接匯入現行 `src/lib/db.ts` 的計算函式，計算買動漫、WACA、私下、已採購及缺口；測試沒有複製另一套數量公式。
8. 連續執行兩次並比較結果。
9. 比較執行前後完整 IndexedDB 固定資料，任何欄位不同即失敗。
10. 比對 `fixtures/core-regression.expected.json` 固定期望值，任何數字不同即失敗。

測試結束後會關閉獨立瀏覽器與伺服器，不會碰日常 Chrome、正式 Supabase 或正式資料。

## 涵蓋項目

- Dashboard：開單中、尚未下單、7 天內結單、已結單及分類 KPI。
- PurchaseRecords：商品群組總數、C108、Hololive、VSPO、代理版、其他分類。
- PurchaseRecords：進行中、已結單、未設定結單日、未設定日幣金額、待採購、全部。
- 核心數量：買動漫、WACA、私下、已採購、缺口。
- Local 資料不可被回歸測試改變。
- 測試期間不可連線 Supabase。
- `erp_proxy_agent_map` 隔離重現，完成後必須還原固定資料。

## 唯讀診斷

固定 fixture：

```powershell
npm.cmd run diagnose:core
```

對指定 JSON 備份：

```powershell
node tests/core-diagnostics.mjs "C:\path\to\workbench-backup.json"
```

診斷只讀 JSON，不會寫回檔案或雲端。
