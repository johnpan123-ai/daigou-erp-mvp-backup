# NEXT SANDBOX NIGHTLY STABILITY REPORT

建立時間：2026-08-18（Asia/Taipei）  
執行範圍：只限 `codex/next-sandbox`。  
Production write：**0**；Production Supabase request：**0**；Push：**NO**；Deploy：**NO**。

## 版本與回復點

| 項目 | 結果 |
| --- | --- |
| Branch | `codex/next-sandbox` |
| Nightly 起始 HEAD | `f0d08f236dc41eb12e90d9cd5a9b089a03d21560` |
| Nightly 測試工具 HEAD | `07910697a892e803a3243db726fb8f4cdb548a78` |
| DB | `daigou-erp-db-next-v1` |
| Storage namespace | `__hippo_next_sandbox__::` |
| Snapshot | `C:\Users\小河馬\Downloads\workbench-backup-2026-08-15.json` |
| Snapshot SHA-256 | `e626e5a7a25a377072aa4358443d9d784ec772ef7bce93349316d6339ad1a17f` |
| 起始 checkpoint | `checkpoint-20260818-0036-next-nightly-start` |
| 資料完整性 checkpoint | `checkpoint-20260818-0048-next-data-integrity`（另有同內容的預估命名 alias `checkpoint-20260818-0055-next-data-integrity`） |

本輪新增的唯一程式碼是兩支 Next-only 測試 probe 與兩個 package scripts；沒有修改 ERP runtime、Provider、db.ts、Schema、Migration 或資料。

## Raw Snapshot → Next DB

測試方式：全新隔離瀏覽器、Next server、atomic Snapshot importer；匯入後 reload，再直接以 IndexedDB readonly probe 讀取 `kv`。所有集合的 count 與 stable collection hash 均一致。

| 集合 | Snapshot | Next raw |
| --- | ---: | ---: |
| inventory | 4096 | 4096 |
| salesOrders | 0 | 0 |
| salesOrderItems | 0 | 0 |
| productGroups | 559 | 559 |
| productCategories | 305 | 305 |
| productVariants | 2438 | 2438 |
| purchaseBatches | 467 | 467 |
| purchaseBatchItems | 1407 | 1407 |
| privateOrders | 93 | 93 |
| privateOrderItems | 120 | 120 |
| bundleComponents | 284 | 284 |
| japanPackages | 36 | 36 |
| japanPackageItems | 225 | 225 |
| outboundShipments | 9 | 9 |
| outboundShipmentItems | 210 | 210 |
| importBatches | 0 | 0 |

**判定：PASS。** 這證明本輪固定 Snapshot 的 raw import parity；不等同 Production live parity。

## Referential Integrity

來源 orphan 與 Next raw orphan 完全相同，沒有任何關聯數增加。

| 關聯 | Snapshot | Next raw |
| --- | ---: | ---: |
| purchaseBatchItem → Batch | 3 | 3 |
| purchaseBatchItem → Variant | 145 | 145 |
| Batch → Group | 25 | 25 |
| Variant → Group | 0 | 0 |
| PrivateOrder → Group | 10 | 10 |
| PrivateOrderItem → PrivateOrder | 0 | 0 |
| PrivateOrderItem → Variant | 17 | 17 |
| Bundle parent → Variant | 32 | 32 |
| Bundle child → Variant | 34 | 34 |
| JapanPackageItem → Package | 0 | 0 |
| JapanPackageItem → Variant | 41 | 41 |
| JapanPackageItem → Batch | 0 | 0 |
| JapanPackageItem → BatchItem | 0 | 0 |
| OutboundItem → Shipment | 0 | 0 |
| OutboundItem → JapanPackageItem | 1 | 1 |
| OutboundItem → Group | 35 | 35 |
| OutboundItem → Variant | 0 | 0 |

這些是 Snapshot 原本的歷史 orphan，不是本輪新增；不自動修復。

## Golden Business Regression

固定 VSPO 五筆與 raw Variant IDs 已通過：

| Group | WACA | 已採購 | Variant count | Variant IDs |
| --- | ---: | ---: | ---: | --- |
| `18bcdaae-52a2-47a4-9aec-6f7c9b5897cc` | 4 | 9 | 7 | 與 Snapshot 相同 |
| `4a584e43-8478-47fd-ae1d-618ad37223f4` | 0 | 0 | 5 | 與 Snapshot 相同 |
| `52e277f7-18c5-4694-99af-d2a6d34ddf56` | 3 | 19 | 9 | 與 Snapshot 相同 |
| `549ef9a3-e106-41c8-ac51-ae9dd218c0f3` | 0 | 2 | 16 | 與 Snapshot 相同 |
| `cf9ccf77-5c84-4afc-8f23-d51e7475d5ce` | 2 | 13 | 8 | 與 Snapshot 相同 |

固定順序為 WACA `4 / 3 / 0 / 0 / 2`、已採購 `9 / 19 / 0 / 2 / 13`。raw 批次／明細關聯與商品名稱所需 ID 均存在；既有 `test:core` 與 Purchase Management regression 也通過。未知商品未在本輪自動測試中出現。

## P0 regression

| P0 | 結果 | 證據／限制 |
| --- | --- | --- |
| P0-A Snapshot atomic import | **PASS** | `test:test-snapshot-import` 驗證完整驗證、單一 transaction、故障 rollback、readback 與 Production sentinel。 |
| P0-A legacy `importData()` harness | **BLOCKED / TEST HARNESS** | `test:atomic-import-data` 失敗在 port 4193 的既有 harness：該 port 會被 dedicated Experimental bootstrap 強制設為 experimental，測試後讀取 test DB 為 `{}`。沒有把此結果誤判為 Snapshot importer 損壞；需另開 test-mode port 修正測試入口。 |
| P0-B Cloud restore | **PASS** | Cloud UI disabled、`SupabaseProvider.restoreBackup()` 在第一筆寫入前 fail-closed；Local/Test restore rollback 測試通過。 |
| P0-F bootstrap | **PASS** | Test-only `simulateBootstrapError` 顯示 recovery screen、reload action、`BOOTSTRAP_FAILED`；無白畫面。 |
| P0-G Variant destructive sync | **PASS / Accepted** | 正常、Read Failure、anomalous empty、Verified Empty；2438 IDs、WACA、orphan baseline 不變，Production request 0。 |
| P0-C | **Design Gate** | 採購批次 header/items 尚未有 server-side atomic boundary。 |
| P0-D | **Design Gate** | Inventory import 與需求同步仍是多步寫入。 |
| P0-E | **Design Gate** | 出庫單頭與明細刪除仍未有 server-side atomic boundary。 |

## 已整合功能回歸

| 功能 | 狀態 |
| --- | --- |
| 第二層官網連結 | NEEDS MANUAL；Registry 已有 ready node，未自動提升 Production Ready |
| 近期採購／日期摺疊／proxy_agent badge／複製帳目 | **PASS automated / NEEDS MANUAL**；`tests/recent-purchases.mjs` 通過，唯讀 |
| 採購操作防誤點／批次帳目保留 | **PASS automated / NEEDS MANUAL**；`tests/purchase-management-actions.mjs` 通過 |
| 採購批次運費分攤 | Registry ready；本輪未改 runtime，仍需人工長期驗收 |
| 套組顯示一致化 | raw 關聯完整；視覺全頁 sweep 仍 NEEDS MANUAL |
| 出庫 P0 receiving queue | **PASS**；10-item queue、F5、離頁、failure、同 SKU 來源測試通過 |
| 出庫 XLS／採購日幣成本 | **PASS automated**；資料來源與空值規則測試通過 |
| Local Mode 未登入入口 | Registry ready；本輪未重做 Production Auth 驗收，NEEDS MANUAL |

## Error / Promise / write-path audit

詳細表見 `docs/p1-read-failure-audit-20260818.md`。本輪只盤點，不修改：

- `Purchasing.tsx`、`JapanPackageDetail.tsx`、`PurchaseManagement.tsx` 有 `.catch(() => [])`，可能把 Read Failure 偽裝成 Empty。
- `PurchaseRecords` fresh load 的 effect 邊界沒有統一 Error state。
- `db.ts` 一般 `get()` 仍有 localStorage／empty fallback；P0-G 只保護 Variant destructive sync，不能宣稱全 db.ts 已 fail-closed。
- Outbound checked／checked_at serial queue regression 通過；`void` 只是 UI 入口，queue 自己負責 await、failure、離頁與 F5 保護。
- P0-C/D/E 的多步寫入風險仍在 Design Gate，未用前端補償硬修。
- Dashboard image fire-and-forget 有 rejection handler，列 P2 observability。

## Crash / white screen / soak

- 100 次 route cycles：PASS。
- 30 次 F5 reload：PASS。
- routes：Dashboard、PurchaseRecords、Purchasing、Japan Packages、Outbound、Recent Purchases。
- page error：0；console error：0；console warning：0；unhandled page error：0。
- P0-F fault injection：PASS。
- Loading 卡死／白畫面：本輪 bounded soak 未觀察到。
- heap：可取得；單次 run 從約 90.98MB 增至 250.87MB（+159.89MB）。尚未強制 GC，也沒有多輪 trend，因此只能列 **效能觀察／需重測**，不能直接宣告 memory leak。

## Next performance baseline

這是本輪 Next-only、全新隔離資料、直接沿用相同 Snapshot importer 的 baseline；未做優化。

| 指標 | 本輪測量 |
| --- | ---: |
| Snapshot import | 715 ms |
| reload | 652 ms |
| Dashboard route | 1393 ms |
| PurchaseRecords first route | 44 ms |
| Purchasing route | 50 ms |
| Japan Packages route | 88 ms |
| Outbound route | 46 ms |
| Recent Purchases route | 53 ms |
| 100 次搜尋 | 10,681 ms |
| 25 次排序 | 1,853 ms |
| 分類切換 | 146 ms |
| 1300-row XLS parser | 17 ms |
| 100 route cycles | 4,723 ms |
| 30 reload cycles | 672 ms |
| Production Supabase requests | 0 |

這組數字不可直接與舊雙 Sandbox baseline 的不同測試流程互比；下一次效能實驗必須重用同一支 Next-only probe。

## Git / scope

- 本輪唯一新增 runtime-adjacent 內容是測試工具：`tests/next-nightly-integrity.mjs`、`tests/next-nightly-performance-soak.mjs`，以及 package scripts。
- 未修改 `src/`、Provider、`db.ts`、Schema、Migration、RLS、Production data。
- 未碰 Experimental worktree、Legacy Test Sandbox、Production Hotfix、main。
- 最終 Git status 應保持 clean。

## Stage status

所有自動測試 stage 均只能標示 **Implementation Passed / Awaiting Manual Acceptance**；本報告沒有把自動測試當成人工 Accepted。P0-G 除外，因為它在本輪前已由使用者完成 SOP 並標記 Accepted。
