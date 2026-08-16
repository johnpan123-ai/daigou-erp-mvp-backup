# P0 Stability Unattended Run 報告

執行日期：2026-08-16（Asia/Taipei）  
分支：`codex/integration-sandbox-20260816`  
安全限制：不 Push、不 Deploy、Production 0 write

## 階段總覽

| Stage | 狀態 | Implementation／分析 Commit | Checkpoint | 結論 |
| --- | --- | --- | --- | --- |
| P0-A `importData()` 原子化 | **Accepted** | `bc9fb120cda4f23c8ab2c5f9d6102b97b7b945de` | `checkpoint-20260816-2153-p0-a-atomic-import-accepted` | 單一 IndexedDB transaction；成功全換、失敗完整 rollback；使用者已完成成功／失敗／F5 人工驗收。 |
| P0-B Restore 原子性 | **Accepted（2026-08-17）** | `d29b3dd43bcfa90350123a7d09abb8863079ac25` | Accepted checkpoint 於本次驗收後建立 | Cloud restore UI／Provider fail-closed，Local／Test atomic restore 與 F5 已人工驗收通過。真正 Cloud restore 仍維持停用。 |
| P0-C 採購批次＋明細 | **Design Gate / Blocked** | `5ba1d1d4fc035d4898ac10ff9bcd63f3146844f0` | `checkpoint-20260816-2310-p0-c-purchase-batch-atomicity-design-gate` | Cloud 需要 server-side transaction／RPC 與複合 Provider 契約；未用 compensation 假裝 atomic。 |
| P0-D Inventory XLS＋訂購紀錄同步 | **Design Gate / Blocked** | `be3c0a0ef712f5fedd7461e2e1e117a8e29ef58f` | `checkpoint-20260816-2314-p0-d-inventory-sync-atomicity-design-gate` | Inventory、residue delete/upsert、Category、Variant 是多次提交；需要 staged plan＋server transaction。 |
| P0-E 出庫單＋明細刪除 | **Design Gate / Blocked** | `5784843ab228f385b8ff29e6b508dd0991d272aa` | `checkpoint-20260816-2316-p0-e-outbound-delete-atomicity-design-gate` | 單頭與明細分兩次提交；Cloud soft-delete error 另會被內層 catch 吞掉；需要 atomic delete endpoint。 |
| P0-F Bootstrap crash 保護 | **Implementation Passed / Awaiting Manual Acceptance** | `f390650aabcebbdeb1f9b9193738fc780d6abd89`、test fix `9e0690e7e3fb36b6959ca2f12ec51b896c09a699` | `checkpoint-20260816-2323-p0-f-bootstrap-failure-awaiting-acceptance-final` | 最外層 catch 以原生 DOM 顯示錯誤頁；Test-only failure injection 通過；尚待使用者依 SOP 人工 Acceptance。 |

## 本輪同時完成的獨立低風險 UI／唯讀功能

### Bundle Component 顯示一致性

- Commit：`b7e49019e391aa086204db01188291070209b297`
- 顯示 ProductGroup 商品名、Variant 規格與 SKU。
- 只改採購 Modal、日本包裹與出庫的 ViewModel／UI；沒有改套組關聯或數量。

### 近期採購複製當日帳目

- 功能 Commit：`87120eba586f388fd867159d033f4719afcc80c8`
- 格式修正 Commit：`d153dc55c3dd0b13b6e8a064e9b8ebe8b312f4cf`
- 每批與每日共用 formatter；以原始 batches/items 產生連續的「商品名稱＋數量」兩欄，不含批次、日期、成本、分隔線或空白列。
- 複製只讀，不修改 purchase_batches／purchase_batch_items。

## P0-F 自動與本機驗證

- `npm run build`：通過，TypeScript 0 error。
- `npm run test:bootstrap-error`：通過。
- Test failure URL 顯示「系統啟動失敗」「錯誤代碼：BOOTSTRAP_FAILED」「重新載入」。
- 原始 `TEST_ONLY_BOOTSTRAP_FAILURE` 不出現在 UI。
- 移除 query 後 4192 正常回到 `[TEST] 小河馬 ERP`。
- 故障注入在 Local Mode 不生效。
- Production Supabase request：0。

## 核心回歸

`npm run test:core` 固定 fixture 仍完全一致：

- Dashboard KPI：進行中 6、尚未下單 1、7 天內 1、已結單 3。
- Dashboard 分類：全部 9、Hololive 1、VSPO 1、代理 1、其他 6。
- PurchaseRecords 分類：全部 8、C108 1、Hololive 1、VSPO 1、代理 1、其他 4。
- 分頁：進行中 6、已結單 2、未設定結單日 1、未設定日幣 2、待採購 2、全部 8。
- 總量：買動漫 18、WACA 6、私人 2、已採購 16、缺口 14。
- 舊 `erp_proxy_agent_map` 仍被忽略且不會改資料。

## 完整測試結果

通過：

- `npm run build`
- `npm run test:core`
- `npm run test:atomic-import-data`
- `npm run test:cloud-restore-fail-closed`
- `npm run test:test-snapshot-import`
- `npm run test:bootstrap-error`
- `npm run test:sandbox-guard`
- `npm run test:sandbox-architecture`
- `npm run test:test-owner-auth`
- `npm run test:inventory-backup-gate`
- `npm run test:outbound-purchase-cost-export`
- `npm run test:outbound-receiving-race`
- `node tests/recent-purchases.mjs`
- `node tests/purchase-management-actions.mjs`
- `git diff --check`

測試工具修正：Cloud restore 與初版 bootstrap test 曾共用 4195；並行測試造成一次 navigation timeout。這不是 App failure。Bootstrap test 已改到獨立 4196，兩者並行重跑後均通過。

## Sandbox isolation

- Test business CRUD 只寫 `daigou-erp-db-test-v1`。
- Test Auth／profiles／Supabase business network request：0。
- Production IndexedDB、app localStorage checksum 在 Guard／Snapshot／Import／Outbound tests 前後一致。
- REST／Auth／RPC／Storage／Functions／XHR／sendBeacon／WebSocket／第二 client path 仍 fail-closed。
- 本輪沒有 Production write、Supabase migration、Schema、RLS、Restore、Push 或 Deploy。

## 人工驗收佇列

### P0-B

**Accepted。** 使用者已確認 Cloud Restore 安全阻擋、Local／Test Restore 與 F5 正常。

### P0-F

依 `docs/p0-f-bootstrap-failure-manual-acceptance.md` 驗證正常啟動、Test-only 故障頁、F5、移除 query 後恢復與 Test DB checksum。

P0-C／D／E 尚未有可驗收 implementation；其 SOP 只能在 server-side transaction 設計獲准後執行。

## 停止點

- P0-A：Accepted。
- P0-B：Accepted；P0-F：Awaiting Manual Acceptance。
- P0-C、P0-D、P0-E：Design Gate / Blocked。
- 沒有任何其他 P0 被自行修補。
- 不 Push、不 Deploy、Production 0 write。
