# NEXT FUNCTIONAL EXPLORATION REPORT

建立時間：2026-08-19（Asia/Taipei）  
環境：Next Sandbox，`http://127.0.0.1:4192/`  
分支：`codex/next-sandbox`  
起始 checkpoint：`checkpoint-20260819-0041-next-before-functional-exploration`  
起始 Commit：`f6f7f32994b2261ccd4d0b0a82e16c418e20accb`  
固定 Snapshot：`C:\Users\小河馬\Downloads\workbench-backup-2026-08-15.json`

## 資料安全 Gate

本輪只使用 Next Sandbox 與隔離測試 origin。沒有 Push、Deploy、Migration、Restore、Local → Cloud 或 Production 操作。

固定 Snapshot 的 raw baseline：

| Collection | Rows |
| --- | ---: |
| productGroups | 559 |
| productCategories | 305 |
| productVariants | 2,438 |
| inventory | 4,096 |
| purchaseBatches | 467 |
| purchaseBatchItems | 1,407 |
| privateOrders / privateOrderItems | 93 / 120 |
| bundleComponents | 284 |
| japanPackages / japanPackageItems | 36 / 225 |
| outboundShipments / outboundShipmentItems | 9 / 210 |

`test:next-nightly-integrity` 確認匯入後各集合 hash 完全一致，Variant ID hash 不變，既有 orphan 沒有增加，Production IndexedDB/localStorage 未變，Production Supabase request = 0。

VSPO Golden raw probe（固定 ID 順序）：

| Group | WACA | 已採購 |
| --- | ---: | ---: |
| `18bcdaae-52a2-47a4-9aec-6f7c9b5897cc` | 4 | 9 |
| `4a584e43-8478-47fd-ae1d-618ad37223f4` | 0 | 0 |
| `52e277f7-18c5-4694-99af-d2a6d34ddf56` | 3 | 19 |
| `549ef9a3-e106-41c8-ac51-ae9dd218c0f3` | 0 | 2 |
| `cf9ccf77-5c84-4afc-8f23-d51e7475d5ce` | 2 | 13 |

這與使用者指定的 VSPO 商品順序 `4 / 3 / 0 / 0 / 2`、`9 / 19 / 0 / 2 / 13` 相同；本表只是依固定 ID 輸出。`未知商品` 沒有新增。

注意：目前 4192 使用者既有 origin 的畫面數字約為 Inventory 4,199、Product Groups 575、Variants 2,542，與固定 Snapshot 不同。本輪沒有覆蓋 4192，這是既有本地狀態，不判定為測試失敗。

## 自動測試

| Test | 結果 |
| --- | --- |
| `npm run build:next` / TypeScript | PASS |
| `test:core` | PASS |
| `test:sandbox-guard` | PASS；CRUD 寫入只到 Next/Test DB，Production IndexedDB/localStorage 不變，Supabase request = 0 |
| `test:sandbox-architecture` | PASS；單一 approved client、無硬編碼 Production host、無 pre-guard bypass |
| `test:test-owner-auth` | PASS；Auth/profile/network request = 0 |
| `test:read-failure-harness` | PASS；7 類 read failure reject，不偽裝成空陣列，Variant sync 0 write |
| `test:test-snapshot-import` | PASS；驗證、atomic transaction、rollback、readback、orphan warning |
| `test:atomic-import-data` | PASS；失敗保留 A，成功完整替換 B |
| `test:inventory-backup-gate` | PASS；備份失敗阻止 XLS 匯入 |
| `test:cloud-restore-fail-closed` | PASS；Cloud restore 在第一筆 Supabase write 前拒絕，Local/Test restore 保留 |
| `test:bootstrap-error` | PASS；Test-only bootstrap error 有錯誤頁與 reload |
| `test:p0-g-hotfix-productionlike` | PASS；正常 sync／Variant read failure zero-write |
| `test:outbound-purchase-cost-export` | PASS；來源關聯與空白價格規則 |
| `test:purchase-batch-freight` | PASS；整數日圓、deterministic、不可重複加算 |
| `test:recent-purchases`（直接執行 test file） | PASS；分組、收合、每日複製、URL、proxy label |
| `test:purchase-management-actions` | FAIL；在 per-batch clipboard click 的 Playwright dialog/clipboard step timeout，尚未證明是產品資料問題；需獨立修測試環境或人工確認 |
| `npm run lint` | FAIL（既有 baseline：580 errors、47 warnings，包含 backup/dead-code tree）；本輪未修改 lint |

## 真人式唯讀巡覽

以下頁面均完成載入／F5 smoke check，`main` 存在，沒有白畫面、卡死或 stuck loading，該頁 Console error/warning 為 0：

- Dashboard
- Inventory
- PurchaseRecords 與商品第二層
- Recent Purchases
- Purchasing / Purchase Management
- Japan Packages 與明細
- Outbound Shipments 與明細
- Unlisted Items
- Duplicate Variants
- Settings

已實際確認：

- 近期採購日期區塊預設收合、獨立展開，重新切換頁面後可正常重建。
- 收合狀態可直接複製當日原始批次帳目；本輪讀到 9 rows，沒有空白行、批次標題、日期或分隔線，每列為兩個 TSV 欄位。
- Japan Package 套組展開顯示 `商品名稱｜規格名稱` 與 `SKU`。
- Outbound 同 SKU 顯示總數，來源明細展開後仍有兩個獨立 `×2` 控制；沒有新增或合併 raw item。
- Purchase Management bundle modal 顯示 Product Group、Variant 與 SKU，取消 modal 沒有寫入。
- Outbound 群組摘要、套組展開、各單品收合、來源明細收合均可見。

## Catalog / Product Identity Regression

目前 `codex/next-sandbox` 的 `PurchaseRecords.tsx` 仍使用 inline 舊 matcher，證據包括：

- `stripProxyTitle()` 會移除 `POP UP PARADE`、`figma`、`Nendoroid`、`黏土人` 等 Product Type。
- `matchScore()` 主要是 `token hits / strippedSegments.length`，沒有 Product Type metadata、強衝突 Reject、5% ambiguity guard 或第二階段 Supplier Selection。
- `lookupProxy()` 以最高分候選直接選取，沒有 Wanrong priority。

因此今晚沒有把 Product Identity v1 或 Wanrong 分階段選擇誤標成 Next 已驗收功能；以下仍是待整合／待人工驗證的 Golden Cases：

| Case | Catalog read-only evidence | Next 判定 |
| --- | --- | --- |
| POP UP PARADE 橘雪莉 L Size | API 有正確候選，raw deadline `2026-09-18T08:00:00Z`、release `2027-02-01`、Wanrong | 目前分支仍可能受舊 normalize/scoring 影響；未寫回 |
| figma 路西法 | API 有 `figma 路西法`，release `2027-04-01`、deadline `2026-09-18T08:00:00Z` | False Negative 仍需 Product Identity v1 |
| 黏土人 3121 峰月律 | API 回傳 Wanrong `2026-09-07` 與 Dreamlink `2026-09-09` 同商品 listing | 目前分支沒有 Supplier Selection；不可自動宣稱 Wanrong 優先 |

本地 `/api/catalog/search`、`/api/hololive/products.json`、`/api/vspo/products.json` 以 PowerShell read-only probe 均回 200；瀏覽器控制面直接導向 API 時回報 client blocked，沒有因此放寬 Supabase Guard。Catalog API 與 Production Supabase 仍分離。

## Supplier Priority

目前 Next 分支未看到 Wanrong/Dreamlink 第二階段 selection code。既有規則應維持：先判定同一 Product Identity，再在同商品 listing 中依 proxy agent／預設規則選 Wanrong；不能以不同商品的角色名相同取代 Identity，也不能用 API 順序當 Supplier decision。這是 **Needs Manual / 待整合**，不是本輪修正。

## Permission

`PurchaseManagement.tsx` 已將 local/test/next/experimental 的 local-write UI permission 與 `canWriteCloud()` 分開，沒有把 `TestSandboxProvider.canWriteCloud()` 改成 true；自動測試確認 Sandbox DB 可寫、Production Supabase request = 0。

但 4192 live tab 的「其他操作」人工檢查只看到「私下登記」，沒有看到預期的「新增規格」。這與 isolated `purchase-management-actions` 測試預期不一致，暫列 **P1 Field Test / permission-surface regression**；尚未修改，需用 fresh origin／確定 editMode 與 build mode 後再重現。Cloud visitor / Cloud permission 沒有因本輪測試放寬。

## Read Failure / Error Handling Matrix

### P1 High

- `src/pages/Purchasing.tsx`：ProductGroups、Variants、Categories、PrivateOrders、Inventory、PurchaseBatchItems、SalesOrderItems、PurchaseBatches 多個讀取 `.catch(() => [])`，之後仍建立可操作 UI。讀取失敗可能被誤認成「沒有符合條件」，需要 Error state 與 write gate。
- `src/pages/JapanPackageDetail.tsx`：商品、分類、批次與 bundle metadata 失敗時 fallback `[]`；後續 bundle/包裹編輯可能在關聯不完整時繼續。
- `src/pages/PurchaseManagement.tsx`：bundle components 讀取 fallback `[]`；保存前應區分 verified empty 與 read failure。
- `src/pages/PurchaseRecords.tsx`：部分 useMemo failure 回傳 `[]`，雖有 console/logCrash，但 UI 仍可能落到空表；目前沒有在本輪證明會直接寫資料，列 P1。
- 多數 Provider save 仍為 full-array save；跨頁／並行 request 可能出現舊 snapshot 覆蓋新值。Outbound checked queue 已序列化，不能外推到所有集合。

### P1／P0 Design Gate（本輪不修）

- 採購批次與明細 sequential save：可能出現單頭有、明細不完整。
- Inventory XLS 與 ProductGroup/Variant sync 分開寫入：跨集合非 transaction；目前 P0-G Variant read failure guard 已能阻止一類 destructive sync，但不等於整體 atomic。
- 出庫單刪除先保存單頭再保存 items：失敗時可能留下 orphan。
- Japan Package 手動編輯與 Outbound 描述跨集合 sequential save。

### P2

- `Dashboard_backup.tsx` dead/backup tree 仍含 catch-to-empty。
- PurchaseBatchModal metadata parse failure 回傳空 map；目前未證明 destructive write。
- clipboard action 的 headless test timeout；需 separate test harness diagnosis。
- lint baseline 含 backup/dead code，降低稽核信噪比。

## Race / Async Audit

- Outbound checked／checked_at 已有 serial queue，既有 race regression 與本輪 P0-G/readonly checks 通過。
- Outbound header/status、PurchaseManagement full-array saves、Japan Package multi-collection saves、Settings/clear actions 仍有 optimistic 或 sequential save 風險；本輪沒有對使用者既有 4192 DB 做寫入壓測。
- `void applyAndSaveItems(...)` 是 UI handler fire-and-forget，但 queue 與離頁保護已涵蓋 checked path；不應把此項直接等同 P0 checked 遺失。
- Settings delayed signOut 與 PurchaseBatchModal long-press timer cleanup 仍是 P1/P2 lifecycle backlog。

## Soak / Performance

`test:next-nightly-performance`（固定 Snapshot、隔離 origin）結果：

| Metric | Result |
| --- | ---: |
| Snapshot import | 1,572 ms |
| reload | 812 ms |
| Dashboard route | 4,380 ms |
| PurchaseRecords first load | 48 ms |
| Search ×100 | 14,526 ms |
| Sort ×25 | 2,339 ms |
| XLS parser 1,300 rows | 19 ms |
| Route cycles | 100 |
| Reload cycles | 30 |
| Console/page errors | 0 / 0 |
| Production Supabase requests | 0 |

Browser readonly soak 10 rounds／60 route visits／10 reloads：Test DB checksum unchanged，Console、Warning、Page Error 均為 0。

記憶體量測由 87,973,871 bytes 上升到 189,935,172 bytes（約 +102 MB），但沒有 forced GC，不能據此判定 memory leak；列為效能趨勢觀察，不在本輪優化。

## Feature completeness

- **PASS（自動／唯讀證據）**：Recent Purchases 日期收合與每日複製、bundle display consistency、Outbound merged source display、Sandbox guard、Snapshot atomic import、Cloud restore fail-closed、Bootstrap error boundary。
- **Implementation Passed / Awaiting Manual Acceptance**：Unit price editing permission fix、P0-G hotfix、P0-A/P0-B/P0-F 等既有節點；本輪沒有自行標 Accepted。
- **NEEDS MANUAL**：實際修改 default_jpy_cost 後 F5、採購批次「複製本批次帳目」在真實瀏覽器貼到 Excel、Cloud visitor／Local/Sandbox permission 逐模式確認、Catalog Identity/Wanrong priority。
- **Design Gate**：P0-C、P0-D、P0-E；本輪沒有用前端補償方式硬修。

## 本輪修正

沒有新增 runtime code 修正。只新增 baseline／本報告／stability audit 文件；既有單價 permission fix 保留在起始 checkpoint，狀態仍是 `Implementation Passed / Awaiting Manual Acceptance`。

## 明日建議前三件事

1. 先人工驗收 Unit Price Editing：Next 編輯模式修改 `default_jpy_cost`，F5 後確認保留，並確認 Cloud visitor 不獲得寫權限。
2. 再人工驗收 Product Identity v1／Wanrong Supplier Selection 三個 Golden Cases；確認同商品判定先於 supplier deadline，且 no-match/ambiguous 0 write。
3. 最後決定是否處理 Read Failure P1 Matrix；優先 `Purchasing`、`JapanPackageDetail`、`PurchaseManagement` 的 catch-to-empty + write gate，不要先做效能重構。

## Final gate

Production write = 0；Production Supabase request = 0；Push = NO；Deploy = NO。Next 工作樹尚待本輪報告 checkpoint，頁面應保持可開於 `http://127.0.0.1:4192/`。
