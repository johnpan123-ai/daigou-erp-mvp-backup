# NEXT EXTENDED STABILITY REPORT

建立時間：2026-08-18（Asia/Taipei）  
Branch：`codex/next-sandbox`  
Production write：**0**；Production Supabase write：**0**；Push：**NO**；Deploy：**NO**；Experimental modification：**NO**。

## 版本與範圍

- 起始 HEAD：`0ac087a2f5ba35987870ac3b0801bda4e3edf728`。
- 起始 checkpoint：`checkpoint-20260818-0449-next-extended-start`。
- Next DB：`daigou-erp-db-next-v1`。
- Snapshot：`C:\Users\小河馬\Downloads\workbench-backup-2026-08-15.json`。
- Snapshot SHA-256：`e626e5a7a25a377072aa4358443d9d784ec772ef7bce93349316d6339ad1a17f`。
- 本輪沒有修改 Production main、Production-like hotfix worktree、Experimental worktree 或 Legacy Test Sandbox。

## 資料正確性：Next Baseline vs Final

Baseline 由 `test:next-nightly-integrity` 在全新 Next DB 匯入後 raw-read 建立；Final 由 10 輪 read-only route/F5 soak 後 raw-read 建立。所有集合 checksum、row count 與既有 Snapshot orphan count 相同。

| Collection | Baseline | Final | Difference |
| --- | ---: | ---: | ---: |
| inventory | 4096 | 4096 | 0 |
| salesOrders | 0 | 0 | 0 |
| salesOrderItems | 0 | 0 | 0 |
| productGroups | 559 | 559 | 0 |
| productCategories | 305 | 305 | 0 |
| productVariants | 2438 | 2438 | 0 |
| purchaseBatches | 467 | 467 | 0 |
| purchaseBatchItems | 1407 | 1407 | 0 |
| privateOrders | 93 | 93 | 0 |
| privateOrderItems | 120 | 120 | 0 |
| bundleComponents | 284 | 284 | 0 |
| japanPackages | 36 | 36 | 0 |
| japanPackageItems | 225 | 225 | 0 |
| outboundShipments | 9 | 9 | 0 |
| outboundShipmentItems | 210 | 210 | 0 |
| importBatches | 0 | 0 | 0 |

### Golden VSPO

| Sample order | WACA | 已採購 | Variant IDs |
| ---: | ---: | ---: | --- |
| 1 | 4 | 9 | unchanged |
| 2 | 3 | 19 | unchanged |
| 3 | 0 | 0 | unchanged |
| 4 | 0 | 2 | unchanged |
| 5 | 2 | 13 | unchanged |

固定 Golden 為 WACA `4 / 3 / 0 / 0 / 2`、已採購 `9 / 19 / 0 / 2 / 13`。批次明細關聯沒有新增 orphan，商品名稱不因本輪 read-only soak 變成未知商品。

### Orphan counts

來源與 Next raw baseline／final 維持相同歷史值：BatchItem→Batch 3、BatchItem→Variant 145、Batch→Group 25、PrivateOrder→Group 10、PrivateOrderItem→Variant 17、Bundle parent/child→Variant 32/34、JapanPackageItem→Variant 41、OutboundItem→JapanPackageItem 1、OutboundItem→Group 35；其餘已驗證關聯為 0。這些是 Snapshot 原有 orphan，沒有自動修復或掩蓋。

## P0-G Production Hotfix

Production-like hotfix：`b50a0a4`，基準 Production：`c3756cd55e90658546a1936c6549411c540351f3`。

- 正常 `upsertInventory → sync → F5`：2438 Variant IDs、Golden、orphan 不變。
- Variant read failure：sync 直接拒絕；錯誤碼 `VARIANT_DESTRUCTIVE_SYNC_GUARD`；raw checksum 不變。
- Supabase request：0。
- 報告：`docs/p0-g-production-hotfix-acceptance-report-20260818.md`。
- 狀態：**Implementation Passed / Awaiting Manual Acceptance**；不能由自動測試改成 Accepted。

## P1 Read Failure Matrix

完整清單：`docs/next-read-failure-matrix-20260818.md`。

- D historical／已止血：Variant read failure → destructive sync；P0-G guard 現在 0 write。
- C：Purchasing、JapanPackageDetail、PurchaseManagement 的 `catch(() => [])`，以及 `db.ts` generic fallback、Cloud post-sync Variant read。
- B：PurchaseRecords fresh-load effect 沒有統一 Error state。
- A：只讀診斷／ErrorBoundary／不進業務寫入的低風險 fallback。

本輪沒有把 C 類問題大改；只新增 fault harness 及文件。

## Test-only Read Failure Harness

`npm run test:read-failure-harness` 對 ProductGroups、Variants、PurchaseBatches、PurchaseBatchItems、JapanPackages、OutboundShipments、Inventory 做 read-failure injection。各 getter failure 都被記錄為 rejection，沒有成功資料；Variant sync 額外回 P0-G guard。每項後 raw Test DB checksum 不變、Supabase request = 0。

這個結果表示：Provider 層不是安全地把所有 error 當作合法空集合；但頁面層的 `.catch(() => [])` 仍可能把 rejection 改成 UI 空集合，因此 C 類 backlog 保留。

## Import／Backup／Restore

- `test:atomic-import-data`：原本因 4193 Experimental port mapping 失敗；本輪只把 test harness 移到 neutral port 4253，成功驗證 malformed collection、forced put failure rollback、F5 replacement、Production sentinel 不變。
- Snapshot importer：16 collections、raw counts/hashes、orphan parity、Production IDB/localStorage 不變。
- Inventory backup gate：手動 JSON 可 parse、XLS 前會先備份、backup failure 會阻止 import。
- Cloud restore：仍由 P0-B fail-closed 停用；沒有重新開放。

## Feature cross-regression

既有 `tests/recent-purchases.mjs`、`tests/purchase-management-actions.mjs`、`test:bootstrap-error` 通過：近期採購、日期收合、proxy 標籤、每日帳目、官網／查看、採購操作層級、Bootstrap recovery 及 Test isolation 沒有退化。功能仍是 Field Testing／Awaiting Manual Acceptance，不推升 Production Ready。

## Test fixture writes

只使用隔離 Test fixture：

- Outbound receiving queue：10 item、同 SKU 來源、勾→取消→再勾、F5、離頁、failure path 通過。
- Outbound purchase-cost export：來源價格、空值不輸出 0、checked／checked_at 不變。
- Inventory backup gate：成功／失敗備份 gate 通過。
- Sandbox CRUD／clear：Test DB 寫入，Production IDB/localStorage 不變。
- Freight helper：eligible rows、整數日圓 rounding、重複 deterministic、invalid input 通過；只測 modal helper，不寫 DB。

每個測試使用 fixture／全新 DB 或既有隔離清理流程；沒有 Production write。

## Performance：三輪量測（未優化）

單位：ms；每輪使用相同 Snapshot／Next-only fresh server。

| 指標 | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Snapshot import | 686.38 | 686.51 | 698.40 |
| Reload | 640.81 | 641.09 | 649.99 |
| Dashboard route | 1270.93 | 1302.52 | 1303.26 |
| PurchaseRecords route | 37.97 | 40.01 | 40.74 |
| Search 100 次 | 9508.41 | 10050.08 | 10220.19 |
| Sort 25 次 | 1801.93 | 1918.80 | 1921.77 |
| Category switch | 104.69 | 111.43 | 126.65 |
| XLS parse 1300 rows | 15.70 | 15.80 | 16.60 |
| 100 route cycles | 4404.16 | 4442.27 | 4475.15 |
| 30 reload cycles | 498.49 | 528.15 | 577.37 |

Heap delta observations：173.72–177.22 MB。沒有 forced GC，不能宣稱 memory leak；只列為效能／可觀測性 backlog。三輪 Console error、warning、page error 都是 0，Supabase request 都是 0。

## 新問題與風險排序

### P0

- 本輪沒有新增 P0。
- Historical P0-G 已有 Production risk，Hotfix 已在 Production-like 通過自動驗證，仍需人工 acceptance；禁止在 Production 觸發 fault injection。

### P1

1. `db.ts` generic read fallback 與 Cloud post-sync Variant read：可能將 Read Failure 帶到 write-adjacent 流程；需 Production-like fault injection。
2. Purchasing／JapanPackageDetail／PurchaseManagement `.catch(() => [])`：可能把必要資料 read failure 顯示成空集合並允許後續操作。
3. PurchaseRecords fresh load Error state 不完整：可能顯示 stale／空畫面而無法辨認讀取失敗。
4. P0-C／D／E 多步寫入仍是 Design Gate，不用前端 compensation 假裝 atomic。

### P2／效能

- Heap trend 尚未可證明 leak。
- PurchaseRecords search 100 次約 9.5–10.2s，先量測，不在本輪優化。
- Dashboard 首載約 1.27–1.30s，先保留 baseline。

## Checkpoints

| Stage | Commit | Checkpoint／Tag | Status |
| --- | --- | --- | --- |
| Start | `0ac087a` | `checkpoint-20260818-0449-next-extended-start` | Baseline locked |
| P0-G Production-like | `7750b08` | `checkpoint-20260818-0508-p0g-hotfix-productionlike-verified`（Git tagger 04:57，名稱時間與建立時間不一致，依 metadata 記錄） | Implementation Passed / Awaiting Manual Acceptance |
| Read-only soak | `627c002` | `checkpoint-20260818-0500-next-readonly-soak` | Automated Tested / Awaiting Manual Acceptance |
| Read Failure Matrix | `c95248e` | `checkpoint-20260818-0501-p1-read-failure-audit` | Analysis Complete |
| Read Failure Harness | `2346edd` | `checkpoint-20260818-0504-p1-read-failure-harness` | Automated Tested |
| Atomic test harness | `af38849` | `checkpoint-20260818-0504-test-harness-fixed` | Automated Tested |
| Feature Registry | `a701fc2` | `checkpoint-20260818-0505-next-feature-registry-reviewed` | Evidence reviewed |
| Fixture regression | `29992ce` | `checkpoint-20260818-0508-next-fixture-regression` | Automated Tested |
| Performance | `29992ce` | `checkpoint-20260818-0510-next-performance-measured` | Measurement only |

錯誤時間命名的既有 tag 不刪除；依 Git annotated tag metadata 判讀實際時間，符合既有 restore-point 規則。

## 最終限制確認

- Production Supabase：0 write；沒有對 Production 觸發故障注入。
- Production IndexedDB／localStorage：只在既有測試 sentinel／raw probe 中驗證 unchanged，未寫入 Production。
- Push：NO。
- Deploy：NO。
- main：未修改。
- Experimental：未修改。
- Snapshot、Schema、Migration、RLS、Provider core、`db.ts` runtime：本輪未修改；新增的是 tests／docs。

## 明日建議前三件事

1. P0-G Production Hotfix 最終人工驗收；若未通過，先不要任何 Production release。
2. 為 `db.ts` generic fallback／Cloud post-sync 建立 Production-like fault harness 設計，先不碰 Production。
3. 由使用者人工 Field Test 近期採購、套組顯示、採購操作與出庫，完成後才考慮 Production candidate。

本報告完成後停止，不自行執行上述明日工作。
