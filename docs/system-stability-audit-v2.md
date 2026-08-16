# ERP Stability Audit v2

稽核時間：2026-08-16 21:05（Asia/Taipei，UTC+8）
環境：`codex/integration-sandbox-20260816`／Test Sandbox，Production-like 程式基準
稽核前 checkpoint：`e24a6e8b191e95893be3bf5e72e20037996043cc`
稽核前 Tag：`checkpoint-20260816-2050-integration-before-stability-audit-v2`

## 結論摘要

本輪只做分析、測試與文件整理，沒有修改 ERP 程式、沒有寫入 Production、沒有 Push／Deploy。現有 Test Sandbox isolation 測試全部通過；Production Supabase request 維持 0。沒有在壓測中觀察到新增資料遺失，但靜態追蹤確認有幾條「失敗後可能留下半套資料」的高風險路徑，應在下一輪以獨立修正處理。

風險數量（同一根因只計一次）：

| 等級 | 數量 | 判定 |
| --- | ---: | --- |
| P0 資料遺失／污染 | 5 | 具體程式路徑存在；本輪未對 Production 重現 |
| P0 程式 crash／白畫面 | 1 | bootstrap rejection 未被最外層接住；本輪未重現 |
| P1 race／狀態錯誤 | 7 | 可能顯示舊資料、空資料或跨表不同步 |
| P1 錯誤提示／生命週期 | 5 | 失敗提示不足或 timer／Promise 生命週期不完整 |
| P2 UX／測試基礎 | 4 | 不直接改資料，但降低診斷與回歸可信度 |
| 日期一致性 | 3 | 不同頁面使用不同解析規則 |
| 效能 | 2 | 大資料搜尋長尾；heap 指標無法由目前 Browser API 取得 |
| Sandbox 隔離 | 0 個新漏洞 | 既有 guard／architecture 測試通過 |

## 1. Build／Tests／靜態掃描

### 通過

- `npm run build`：通過，TypeScript 0 error；Vite 僅提示 chunk 大於 500 kB。
- `npm run test:core`：通過。
- `npm run test:test-owner-auth`：通過；Test Owner 不讀 Production Auth／profiles。
- `npm run test:sandbox-guard`：通過；REST、RPC、Storage、Functions、XHR、beacon、WebSocket、第二 client 均被阻擋。
- `npm run test:sandbox-architecture`：通過；`createClient()` 集中、正式 host 不在 src 硬編碼、無 guard 前 fetch bypass。
- `npm run test:test-snapshot-import`：通過；驗證前不寫入、單一 atomic transaction、失敗 rollback、Production browser data 不變。
- `npm run test:outbound-receiving-race`：通過；點收 queue concurrency = 1，快速操作、離頁／F5、失敗與亂序模擬均保留最後狀態。
- `npm run test:inventory-backup-gate`：通過；備份失敗會阻止 XLS 匯入。
- `npm run test:outbound-purchase-cost-export`：通過；採購日幣價格只取可靠關聯，缺值輸出空白。
- `node tests/recent-purchases.mjs`：9/9 通過。
- `node tests/purchase-management-actions.mjs`：3/3 通過。
- `git diff --check`：通過。

### 未通過／不是本輪功能失敗

- `npm run test:recent-purchases`：失敗，`package.json` 沒有這個 script；同一測試檔直接執行 `node tests/recent-purchases.mjs` 為 9/9 通過。這是測試入口缺漏，列 P2。
- `npm run lint`：失敗，既有全專案約 598 errors／47 warnings，包含 backup 目錄與現有頁面；本輪不修改 lint 基線。

## 2. P0 資料遺失／污染

### P0-1：Production restore 不是原子操作

- 問題：`SupabaseProvider.restoreBackup()` 先逐表刪除雲端資料，再逐表 upsert；沒有資料庫 transaction 或 server-side restore job。
- 位置：`src/providers/cloud/supabaseProvider.ts:2421` 附近。
- 重現／推論：在任一 delete chunk、local import 或後續 save 失敗時，前面已完成的雲端刪除／寫入不會自動回復。
- 影響：Production restore 中途失敗可能留下部分舊資料被刪除、部分新資料已寫入的狀態。
- 本輪結果：未執行 restore，未修改 Production；Test Snapshot importer 沒有使用此路徑且 atomic 測試通過。
- 最小修法：將 restore 移至受控 server-side transaction／明確的 staged restore；不要在前端逐表 delete＋save。
- 涉及：SupabaseProvider、後端／資料庫交易邊界；可能需要架構決策，不能只靠 UI 修。

### P0-2：一般 `importData()` 逐集合寫入，可能半套匯入

- Stage 狀態：**Accepted**（2026-08-16 人工驗收通過）。
- 問題：`IndexedDbAdapter.importData()` 依序呼叫多個 `saveXXX()`，不是單一 transaction；任一集合失敗時只回傳 `false`，前面已完成的集合不會 rollback。
- 位置：`src/lib/db.ts:3185` 附近；LocalAdapter 也有同樣的逐項流程。
- 影響：Local／Production-like 的一般設定還原或舊匯入流程可能留下混合新舊資料。Test-only `importTestSnapshot()` 是另一條 atomic 路徑，本輪測試通過，不代表一般 `importData()` 安全。
- 最小修法：只允許 validated Test importer，或為一般 import 建立真正單一 IndexedDB transaction；不要用目前回傳 boolean 的方式假裝 atomic。
- 涉及：db.ts，屬高風險；依使用情境決定是否拆批處理。

### P0-3：新增／編輯採購批次先存批次、再存明細

- 問題：`PurchaseBatchModal.handleAddBatchSubmit()` 先 `savePurchaseBatches()`，再 `savePurchaseBatchItems()`。
- 位置：`src/components/PurchaseBatchModal.tsx:488-540`。
- 影響：第二次寫入失敗時可能留下沒有明細的批次；編輯時也可能出現批次 metadata 與明細不一致。
- 失敗提示：錯誤會往外 throw，呼叫端不一定提供一致的表單錯誤／rollback。
- 最小修法：在資料層提供批次＋明細原子寫入，或先做完整 draft 驗證再以單一 transaction 提交。
- 涉及：Provider／db transaction；不能只在 Modal 加 loading。

### P0-4：Inventory XLS 匯入與訂購紀錄同步分成兩次寫入

- 問題：`Inventory.handleFileChange()` 先 `upsertInventory()`，再 `syncProductGroupsWithInventory()`，最後 reload；兩者沒有跨集合 transaction。
- 位置：`src/pages/Inventory.tsx:115-165`。
- 影響：Catalog 已寫入但 ProductGroup／Variant 同步失敗時，主檔與訂購紀錄可能短暫或持續不一致。匯入前 JSON 備份 gate 能提供人工回復點，但不是 automatic rollback。
- 本輪結果：備份 gate 測試通過；未執行正式資料匯入。
- 最小修法：先做 staged import／transactional sync，或在同步失敗時以同一份 pre-import snapshot 明確 rollback 並驗證 checksum。
- 涉及：Inventory、Provider、db transaction；需另立功能批次。

### P0-5：刪除出庫單先存 shipment、再存 items

- 問題：`deleteShipment()` 先 `saveOutboundShipments(updated)`，再 `saveOutboundShipmentItems(updatedItems)`，中途失敗沒有 rollback。
- 位置：`src/pages/OutboundShipmentDetail.tsx:816-827`。
- 影響：可能留下 orphan outbound items，或 shipment 已消失但 items 尚存。這與已修好的 checked save queue 是不同風險。
- 最小修法：提供 shipment＋items 的原子刪除入口；至少先加失敗狀態與重新讀取，不可把 UI rollback 當成資料 rollback。
- 涉及：Provider／db transaction；本輪不修改。

## 3. P0 程式 crash／白畫面

### P0-C1：bootstrap rejection 沒有最外層 catch

- 位置：`src/main.tsx:109` 的 `void bootstrap()`。
- 根因：動態 import、`createRoot` 或 Test Sandbox 初始化若 reject，沒有最外層 error boundary 可接住；可能只留下空 root／白畫面與 unhandled rejection。
- 本輪結果：Build 與 50 次有效路由切換均正常，未重現；這是故障路徑風險，不是本輪觀察到的 crash。
- 最小修法：在 bootstrap 最外層顯示不可依賴 React 的啟動錯誤畫面並記錄錯誤。
- 涉及：`src/main.tsx`；低改動但需單獨測試。

## 4. P1 race／狀態錯誤

### P1-R1：讀取失敗被當成空資料

- `src/pages/Purchasing.tsx:308-317`：9 個 fetch 使用 `.catch(() => [])`，之後照常 set state，畫面可能顯示沒有符合條件。
- `src/pages/JapanPackageDetail.tsx:450-455`：商品／批次／bundle metadata 失敗時變成空集合。
- `src/pages/PurchaseManagement.tsx:1169`：bundle components 讀取失敗時當成空選取。
- 影響：使用者可能在「資料真的不存在」與「讀取失敗」之間做錯誤操作；bundle 編輯尤其需要禁止在 metadata 不完整時保存。
- 分級理由：目前沒有證據顯示每一處都會直接刪資料，先列 P1；若確認空集合可直接覆蓋完整關聯，升級為 P0。

### P1-R2：PurchaseManagement optimistic state 失敗不 rollback

- 位置：`src/pages/Purchasing.tsx:364-430`。
- 流程：先 `setGroups(nextGroups)`，再 await `saveProductGroups()`；失敗時只 alert，沒有立即 restore 或 reload。
- 影響：畫面暫時看起來已成功，F5 後才回到舊值；若使用者在此期間繼續操作，可能以錯誤 UI 為基礎再送出寫入。

### P1-R3：dataProvider 部分寫入口沒有 stale guard／write registration

- 目前有 guard 的主要入口包含 product groups／variants、purchase batches／items、Japan packages／items、outbound items、bundle。
- 未一致納入的入口包括 `saveSalesOrders`、`saveSalesOrderItems`、`saveProductCategories`、`deleteProductVariant`、`updateProductVariantPatch`／bulk、private orders／items、import batches、clear／delete group、`saveLastImportBackup` 等。
- 位置：`src/providers/dataProvider.ts:124-290`。
- 影響：跨分頁 full-array save 或 patch 操作缺少同一套 stale／write marker，存在舊快照覆蓋新值的風險；本輪沒有對 Production 做競態寫入。

### P1-R4：日本包裹手動編輯跨兩個集合 sequential save

- 位置：`src/pages/JapanPackageDetail.tsx:~1000-1050`。
- 流程：先保存 `japan_package_items`，再保存相關 `outbound_shipment_items` 描述欄位。
- 影響：第二步失敗時，日本包裹已是新名稱／SKU，出庫描述仍是舊值；數量不會因此自動覆蓋，但跨表描述會不一致。

### P1-R5：Outbound header／status 沒有統一失敗 UI

- 位置：`src/pages/OutboundShipmentDetail.tsx:904-938`。
- 流程：先 optimistic set state，再 await `saveOutboundShipments()`；沒有 catch／saving lock／失敗 rollback。
- 影響：標題或狀態保存失敗可能顯示成已更新，離開頁面後才發現未保存。checked item queue 本身已由既有 P0 修正保護，與此不同。

### P1-R6：重複提交／連續修改的入口不全都有 lock

- 已確認 outbound checked `saveItems()` 以 queue 串行化，既有 race 測試通過。
- 但採購批次、私下訂單、出庫 header、刪除等入口各自管理 async 狀態，沒有全域提交序列；快速 double-click 可能發送重複或相互覆蓋的 full-array save。
- 位置例：`PurchaseManagement.tsx:1313-1408`、`PurchaseManagement.tsx:197-208`、`OutboundShipmentDetail.tsx:816-935`。

### P1-R7：`save` 全量陣列與 background reload 的組合仍有舊 snapshot 風險

- `dataProvider` 多數 save API 接受整份集合，而不是 row-level patch；頁面先讀集合、修改一筆、再整份寫回。
- 若另一頁／另一 request 在中間先保存，後完成的舊集合可能覆蓋前一筆變更。既有 outbound checked queue 只涵蓋點收 item，不涵蓋所有集合。

## 5. P1 錯誤提示／生命週期

- `src/pages/Settings.tsx:~126`：`loadCounts()` 在 effect 中直接呼叫，沒有 await／catch；讀取失敗可能形成 unhandled rejection 或錯誤的 0 筆狀態。
- `src/pages/Settings.tsx:77`：密碼更新成功後以 `setTimeout(async () => signOut())` 延遲登出，沒有保存 timer ref／unmount cleanup。
- `src/components/PurchaseBatchModal.tsx:~161`：分類 metadata 失敗只 `console.error`，Modal 沒有 error state。
- `src/components/PurchaseBatchModal.tsx:377-422`：長按 quantity 使用 timer／interval；按鈕 mouseup／mouseleave 會清理，但 Modal 卸載沒有集中 cleanup，路由快速切換時存在 timer 殘留風險。
- `src/lib/db.ts` migration／fallback 有 fire-and-forget `set(...).catch(...)`，失敗後只記錄 console；可能讓 cache migration 部分完成但 UI 不知道。

## 6. P2 UX／測試基礎

- `npm run test:recent-purchases` 沒有 package script；直接 node 執行通過，但 CI／交接容易誤判為測試不存在。
- `npm run lint` 全專案基線失敗（約 598 errors／47 warnings），backup 目錄與 active source 混在一起，降低靜態稽核信噪比。
- `Dashboard_backup.tsx` 是死碼，但仍命中 `.catch(() => [])`；目前不在路由，應移出掃描範圍或標示 dead code。
- 多個 copy／toast／modal transition 使用裸 `setTimeout`；目前未觀察到功能錯誤，但路由快速卸載時可能更新已卸載元件。

## 7. 日期／狀態一致性 Audit

### 已確認的差異

| 資料形式 | Dashboard | PurchaseRecords | RecentPurchases | 風險 |
| --- | --- | --- | --- | --- |
| `YYYY-MM-DD`／`YYYY/MM/DD` | 支援並補零 | 支援並補零 | batch `date` 僅 replace `/`，優先使用 `created_at` | 同一 batch 若無 created_at，非零補零格式可能解析差異 |
| `YYYY年MM月` | closing date 不支援；release month 僅嚴格 `YYYY-MM` | closing date 不支援；release month parser 支援 `年`、`.`、`/`、`-` | 不解析 release month | Dashboard 月份統計可能漏掉人工輸入的 `2026年08月`，PurchaseRecords 排序仍看得到 |
| `MM/DD` | `normalizeDateStr` 不接受 | `normalizeDate` 不接受 | 只有 batch `date` fallback 會交給 `Date.parse`，年份依瀏覽器推斷 | 近期採購可能有日期、主表卻視為空／未知；年份推斷不穩定 |
| `上旬／中旬／下旬` | release month strict match 不接受後綴 | parser 接受年＋月並忽略旬別 | 不處理 | 月份排序可一致，但 Dashboard release stats 可能漏列；closing date 不應混用自由文字 |
| `未定`／空白 | closing date 視為無結單日；release month 不計 | closing date 視為無結單日；release month tier 2 | batch invalid date 變 timestamp 0，會被日期篩選排除 | 狀態本身大致一致，近期採購 invalid date 行為不同 |

### 時區差異

- Dashboard／PurchaseRecords 使用瀏覽器本機 `new Date()` 的年月日。
- RecentPurchases 明確使用 `Asia/Taipei`。
- 在電腦時區不是台灣、或台灣午夜前後，今天／昨天、7 天範圍與首頁狀態可能出現一天差異。

本輪沒有修改任何日期規則；建議下一輪先建立共用唯讀 parser 與固定時區測試，再由業務確認自由文字 closing date 是否允許。

## 8. 全 ERP 資料寫入入口表

| 頁面／操作 | 觸發 | 主要 save/provider | draft／optimistic | 失敗／競態觀察 |
| --- | --- | --- | --- | --- |
| Inventory XLS | file change；先 backup，再 `upsertInventory`、sync | `upsertInventory` → `syncProductGroupsWithInventory` | 有 importing flag；非跨集合 transaction | P0-4 |
| Inventory JSON restore | file change／rollback click | cloud `restoreBackup` 或 local `importData` | 有 confirm；非 atomic generic path | P0-1／P0-2 |
| Inventory 建立訂購紀錄 | submit | `createPurchaseRecordFromInventory` | await；成功後 reload | 多集合寫入，需另測 transaction |
| PurchaseRecords 採購人／結單日／URL | select、blur、batch action | `saveProductGroups` | 部分 draft；多數 optimistic | stale guard 有，但 full-array save；錯誤依 handler 顯示 |
| PurchaseRecords 需求數字 | input change → blur | `updateProductVariantPatch` | draft；blur async | patch 入口未完整納入 stale/write guard；P1-R3 |
| Purchasing 移出採購總表 | click | `saveProductGroups` | 先 setGroups | 失敗不 rollback；P1-R2 |
| PurchaseManagement 規格／成本 | blur | `updateProductVariantPatch` | draft／blur；無每欄 global queue | 快速多欄修改可能並行；P1-R3/R7 |
| PurchaseManagement bundle | modal save | `saveBundleComponentsForVariant` | modal draft | metadata 失敗被當空；P1-R1 |
| PurchaseManagement 採購批次 | modal submit | `savePurchaseBatches` → `savePurchaseBatchItems` | modal draft；await 但非 transaction | P0-3 |
| PurchaseManagement 私下訂單 | modal submit／edit | `savePrivateOrders` → `savePrivateOrderItems` | modal draft；await | sequential，第二步失敗可能半套；P1，需另立 transaction 修正 |
| JapanPackage | add/import/edit/check | package/items save；編輯時另 save outbound items | local state 先更新部分流程 | 跨集合非 transaction；P1-R4；批次占用有重新檢查 |
| Outbound item point check | checkbox／整組／來源明細 | `saveOutboundShipmentItems` | optimistic＋serial queue | 既有 P0 queue 測試通過；本輪不改 |
| Outbound header/status | save／status click | `saveOutboundShipments` | optimistic；無明確 lock | P1-R5 |
| Outbound delete | delete click | `saveOutboundShipments` → `saveOutboundShipmentItems` | await；無 rollback | P0-5 |
| UnlistedItems 已處理 | click | localStorage helper | set state＋local write | storage failure 提示不足；P1/P2 |
| Settings password | submit | Supabase Auth update → delayed signOut | loading；timer | timer 無 cleanup；P1 |
| Settings clear | confirmed click | `clearData`／`clearPurchaseRecords` | double confirm | db method catches internally，錯誤可能被視為成功；P1 |
| Test Snapshot Import | confirm file import | `importTestSnapshot`，固定 Test DB transaction | preparing/importing；驗證＋rollback | 本輪測試通過，隔離安全 |

## 9. 破壞性／長時間壓測結果

### Browser read-only stress

- Test Sandbox title：`[TEST] 小河馬 ERP`；頁面顯示 Test Banner。
- 有效路由 10 個 × 5 輪 = 50 次切換：0 failure、0 loading 殘留、0 crash／white screen。
- 單次有效路由耗時：中位數約 369 ms，最快約 250 ms；最慢約 6.9 s，長尾主要出現在 `PurchaseRecords`。
- 搜尋 100 次、排序 25 次：操作完成，頁面仍可正常 render；總耗時約 83.7 s，表示大資料下每次搜尋／排序的更新成本偏高，列為效能風險，不在本輪修改。
- PurchaseRecords 使用 Snapshot 規模畫面可正常顯示 Test Banner 與資料；沒有用錯誤頁面「0 筆」掩蓋瀏覽器壓測中的失敗。
- `/purchase-management` 不是有效 route；第一次腳本誤測該 URL 造成一筆預期的 route failure，已改用正確 `/purchasing` 重跑，50 次全通過。

### Heap／listener／timer 限制

- 目前 Browser control API 沒有暴露 `performance.memory`，不能把 heap 數字冒充成測量結果。
- 沒有可安全讀取的 listener／timer registry；以 static audit 檢查 cleanup。已確認 Viewport、欄寬拖曳、JapanPackage outside-click、Outbound pending navigation 等主要 listeners 有 cleanup；timer／interval 仍有上方 P1/P2 風險。
- destructive save、slow save、failure、亂序已由既有 isolated tests 覆蓋，且使用 Test DB／Supabase request 0；本輪沒有對使用者現有 Snapshot 進行批量破壞性寫入。

## 10. Import／Backup／Restore 健檢

| 流程 | 結果 | 判定 |
| --- | --- | --- |
| Test Snapshot JSON | atomic transaction、count／checksum／rollback 通過 | 安全；保留現有 importer |
| Inventory XLS 前自動 JSON backup | backup gate 通過；失敗會中止 XLS | 安全但跨 inventory／group sync 非 transaction（P0-4） |
| 手動 JSON export | serializer parse／非空／集合完整測試通過 | 安全，仍需保留檔案驗證 |
| 一般 `importData()` | 已改為完整格式驗證＋單一 IndexedDB transaction；專用 rollback 測試與人工成功／失敗／F5 驗收通過 | P0-2：Accepted |
| Production cloud restore | 逐表 delete＋逐表 push，沒有 transaction | P0-1；本輪禁止執行 |

## 11. Sandbox 隔離結果

- Test Owner、Test DB `daigou-erp-db-test-v1`、Test localStorage namespace 均由既有測試確認。
- `test:sandbox-guard`：Production IndexedDB／localStorage checksum 不變；Production Supabase write request = 0。
- `test:test-owner-auth`：Test Mode Auth／profile request = 0。
- `test:sandbox-architecture`：單一 approved `createClient()`、未知 Supabase path fail-closed、無 pre-guard fetch bypass。
- `test:test-snapshot-import`：正式 JSON → Test DB，Production browser data checksum 不變。
- 本輪沒有修改 Supabase、Production IndexedDB、Production localStorage、Schema、RLS 或 Migration。

## 12. 建議下一輪順序

1. **先處理 P0-1／P0-2／P0-3／P0-4／P0-5**：先把所有跨表 destructive／import 流程的 transaction 邊界定清楚；禁止用 UI loading 取代資料原子性。
2. **再處理 P1-R3／P1-R7**：統一 dataProvider stale guard、write registration、row-level patch 或 per-entity serialization。
3. **修正 P1-R1／P1-R2／P1-R5**：Error／Empty 分離、optimistic rollback、header/status save 錯誤提示。
4. **建立日期共用 parser 與時區測試**：先由業務確認 closing date 與 release month 的允許格式。
5. **補齊測試入口與效能基準**：註冊 `test:recent-purchases`，把大資料搜尋／排序拆成可重複 benchmark；再決定是否需要 memo／節流。
6. **最後處理 timer cleanup／bootstrap catch／lint 基線**：這些低風險但應有獨立修正與回歸。

## 13. 本輪停止條件與狀態

- 本輪沒有修正上述 P0／P1／P2。
- 沒有 Push、Deploy、Migration、Restore、Import Production 或 Local → Cloud。
- 稽核文件與 Restore Point Index 是唯一預計新增的工作樹變更。
- 完成文件提交後應保持 Git clean；Production-like／Integration 分支仍可從本輪 checkpoint 回退。
