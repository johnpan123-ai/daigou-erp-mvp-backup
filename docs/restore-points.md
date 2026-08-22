# ERP Restore Point Index

最後更新：2026-08-21 09:01（Asia/Taipei，UTC+8）

本文件是 Git 回復點、資料快照與外部備份的集中索引。Feature readiness tag 仍由 `docs/test-sandbox-feature-registry.md` 管理；除非同時是可回復的完整狀態，否則不重複列為 Restore Point。

## 新 Tag 命名規範

自 2026-08-16 起，所有新 Backup Tag／Checkpoint Tag 固定使用台灣日期與時間：

- Production／環境備份：`backup-YYYYMMDD-HHMM-環境-用途`
- 一般 checkpoint：`checkpoint-YYYYMMDD-HHMM-用途`
- 時區固定：`Asia/Taipei`（UTC+8）
- 範例：`backup-20260816-2030-production-before-outbound-deploy`
- 範例：`checkpoint-20260816-2030-integration-before-xls-export`

新 Tag 應建立為 annotated tag，讓 Git 保存可驗證的 tagger timestamp。建立訊息至少記錄環境、原因、Build／Test 狀態與是否曾部署 Production。

既有 Tag 不 rename、不 delete。既有 lightweight tag 沒有 tagger timestamp；本文件只會把 Commit 時間列為參考，並標示「Tag 時間待確認」，不把 Commit 時間冒充 Tag 建立時間。

每次建立重要 checkpoint 的標準流程：

1. 確認環境、分支、Commit 與工作目錄狀態。
2. 完成適用的 Build／Test／資料回歸。
3. 使用台灣時間建立 annotated tag。
4. 立即在本文件新增一筆，包含 Commit、原因、功能、測試、部署與備份對應。
5. 未經明確授權，不 Push tag、不 Push branch、不 Deploy。

## 建議優先使用的回復點

| 台灣日期時間 | 環境 | Tag | Commit Hash | 建立原因／當時功能 | Build／Test | 曾部署 Production | JSON Snapshot | Database Dump | Storage Backup | 建議作為 Restore Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-15 00:32 | Production | `backup-production-before-outbound-purchase-records-20260815` | `716895ab0edf362259323bfef3759395a4199217` | 出庫／PurchaseRecords 正式部署前的舊 Production；包含當時正式「只看需要採購」組合修正 | 部署前檢查通過（既有紀錄） | 是，為舊 Production | 無直接對應 | `production-before-outbound-deploy-20260815-002417.dump`；SHA-256 `4a1cc105f68773f1e863d249760883a0d11f4cb0c975888259a7eda9f9cf3a21`；檔案位置待確認 | 已完成；檔名／Manifest／Hash 待補登 | **是：程式＋Database／Storage 保護最完整的舊 Production 節點** |
| 2026-08-14 15:27 | Production | `checkpoint-production-outbound-purchase-records-before-deploy-20260814` | `c3756cd55e90658546a1936c6549411c540351f3` | 出庫點收 UI、同 SKU 彙總與 PurchaseRecords proxy-agent／代理數量 draft 修正；之後成為正式 Production | Build、TypeScript、核心回歸與部署前檢查通過 | **是** | 無直接對應 | 上述 2026-08-15 部署前 Dump 保護其部署前資料 | 上述 Storage Backup 保護其部署前檔案 | **是：目前已知正式程式版本節點** |
| 2026-08-16 18:26 | Production-like | `checkpoint-production-like-outbound-p0-stress-passed-20260816` | `0d729c7a0a2df20491dcdc461d9324679abbb63f` | Production-like Sandbox；出庫 checked／checked_at save queue P0 修正與壓力測試完成 | Build、P0 race／stress、Sandbox isolation 通過 | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | **是：單獨抽取出庫 P0 修正的首選** |
| 2026-08-16 19:24 | Production-like | `checkpoint-production-like-outbound-p0-clean-before-feature-integration-20260816` | `0d729c7a0a2df20491dcdc461d9324679abbb63f` | 封存乾淨 P0 分支，準備建立 Integration Sandbox | 同上 | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | **是：P0 乾淨基準** |
| 2026-08-16 19:35 | Integration | `checkpoint-integration-sandbox-final-verified-20260816` | `687dae934b02ed5e2255a2242a2879c9ea9949b6` | P0＋第二層官網＋近期採購＋採購操作層級／歷史＋運費分攤＋Local Mode 入口 | Build、core、Sandbox isolation、P0 race regression 通過 | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | **是：進入後續 Integration UI 工作前的完整已驗證節點** |
| 2026-08-16 19:50 | Integration | `checkpoint-integration-before-inventory-backup-gate-20260816` | `687dae934b02ed5e2255a2242a2879c9ea9949b6` | Inventory「匯入 XLS 前自動 JSON 備份」開發前基準 | 與上一列相同 | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | 是：Inventory 備份流程變更前回復點 |
| 2026-08-16 20:50 | Integration | `checkpoint-20260816-2050-integration-before-stability-audit-v2` | `e24a6e8b191e95893be3bf5e72e20037996043cc` | Stability Audit v2 前封存；包含 Inventory JSON 備份 gate、Outbound 採購日幣單價空值輸出修正、對應測試與 Restore Point Index | 既有 Build、core、Sandbox guard、P0 race、Inventory gate、Outbound export 測試通過；Audit v2 於 21:05 完成分析 | 否 | `workbench-backup-2026-08-15.json` | 無新增對應 | 無新增對應 | **是：本輪 Audit 的乾淨起點** |
| 2026-08-16 21:17 | Integration | `checkpoint-20260816-2117-before-p0-a-atomic-import` | `3d203187e32a9d68a01b8d68231552dea1a73c2e` | P0-A `importData()` 原子化實作前；保留 Stability Audit v2 已完成狀態 | Audit v2 Build／regression／Sandbox isolation 已完成；P0-A 尚未開始 | 否 | `workbench-backup-2026-08-15.json` | 無新增對應 | 無新增對應 | **是：P0-A 乾淨回復點** |
| 2026-08-16 21:31 | Integration | `checkpoint-20260816-2131-p0-a-atomic-import-awaiting-acceptance` | `bc9fb120cda4f23c8ab2c5f9d6102b97b7b945de` | P0-A 一般 JSON `importData()` 完整驗證＋單一 IndexedDB transaction；含成功／損壞 fixture、rollback 專用測試與人工 SOP | Build、core、atomic import、Sandbox guard／architecture、Test Owner、Snapshot、Inventory gate、Outbound export／race、Recent Purchases 通過；Purchase Management 複製按鈕既有 UI 測試 navigation wait timeout，與 P0-A 無關；**等待人工驗收** | 否 | 人工驗收清理可重匯 `workbench-backup-2026-08-15.json` | 無新增對應 | 無新增對應 | **是：Implementation Passed / Awaiting Manual Acceptance；尚未 Accepted** |
| 2026-08-16 21:53 | Integration | `checkpoint-20260816-2153-p0-a-atomic-import-accepted` | `d53d7e6` | P0-A 人工成功匯入、F5、損壞第 8 集合失敗注入與失敗後 F5 全部通過；正式標記 Accepted | 延續上一列自動測試；使用者人工驗收通過 | 否 | 清理時可重匯 `workbench-backup-2026-08-15.json` | 無新增對應 | 無新增對應 | **是：P0-A Accepted Restore Point** |
| 2026-08-16 21:54 | Integration | `checkpoint-20260816-2154-before-p0-b-restore-atomicity` | `52ae720f94267492cb4ac40edf761f964a110819` | P0-B Production cloud restore 原子性分析前；P0-A Accepted 與 Restore Point 已登錄 | P0-A 自動＋人工驗收通過；P0-B 尚未修改 | 否 | `workbench-backup-2026-08-15.json` 僅供 Test | 無新增對應 | 無新增對應 | **是：P0-B 乾淨回復點** |
| 2026-08-16 22:18 | Integration | `checkpoint-20260816-2218-before-p0-b-cloud-restore-fail-closed` | `c9a9cb86d4d72475ae66e9deeeee57535773cab8` | 使用者核准 Cloud restore 安全止血方案後、實作前；含 P0-B 設計 Gate | P0-A Accepted；P0-B 尚未變更執行行為 | 否 | `workbench-backup-2026-08-15.json` 僅供 Test／Local atomic 驗收 | 無新增對應 | 無新增對應 | **是：P0-B 實作前乾淨回復點** |
| 2026-08-16 22:28 | Integration | `checkpoint-20260816-2228-p0-b-cloud-restore-awaiting-acceptance` | `d29b3dd43bcfa90350123a7d09abb8863079ac25` | Cloud／Fallback JSON restore UI 停用，`SupabaseProvider.restoreBackup()` 第一筆 read／write 前 fail-closed；Local／Test atomic restore 保留；含專用測試與人工 SOP | Build／TypeScript、core、P0-A atomic import、Cloud fail-closed、Sandbox guard／architecture、Test Owner、Snapshot、Inventory backup gate、Outbound export／race、Recent Purchases、Purchase Management 全部通過；本機 Test UI 與 Console 0 Error | 否 | 成功／失敗 fixture 與 `workbench-backup-2026-08-15.json` 僅供 Test／Local 驗收 | 無新增對應 | 無新增對應 | **是：Implementation Passed / Awaiting Manual Acceptance；尚未 Accepted** |
| 2026-08-17 00:07 | Integration | `checkpoint-20260817-0007-p0-b-cloud-restore-accepted` | `d71f7231ed8198d75d2c68038d0d5dcdcdad9952` | P0-B Cloud Restore 安全止血人工驗收通過；Cloud UI／Provider fail-closed，Local／Test Restore 與 F5 正常 | 既有 Build／專用自動測試通過；使用者人工確認 Cloud 阻擋、Local／Test Restore、F5；Production 0 write | 否 | 驗收使用 Test／Local fixture；無 Production Snapshot 寫入 | 無新增對應 | 無新增對應 | **是：P0-B Accepted Restore Point；真正 Cloud atomic restore 仍維持停用／Design Gate** |
| 2026-08-16 22:57 | Integration | `checkpoint-20260816-2257-bundle-component-display-consistency` | `b7e49019e391aa086204db01188291070209b297` | 套組子項統一顯示商品名稱、規格與 SKU；涵蓋採購 Modal、日本包裹與出庫唯讀 ViewModel | Build、core、Sandbox guard、outbound receiving race、WeatherPlanet 瀏覽器驗證通過 | 否 | `workbench-backup-2026-08-15.json`（唯讀基準） | 無新增對應 | 無新增對應 | **是：獨立低風險 UI 回復點；Production 尚未部署** |
| 2026-08-16 23:04 | Integration | `checkpoint-20260816-2304-recent-purchases-daily-ledger-verified` | `87120eba586f388fd867159d033f4719afcc80c8` | 近期採購日期列可複製當日所有原始批次帳目；與既有每批帳目共用 formatter | Build、core、Recent Purchases、Purchase Management actions、Sandbox guard及本機收合狀態複製驗證通過 | 否 | `workbench-backup-2026-08-15.json`（唯讀測試資料） | 無新增對應 | 無新增對應 | **是：Feature B 小修正的獨立本機回復點；Production 尚未部署** |
| 2026-08-16 23:08 | Integration | `checkpoint-20260816-2308-purchase-ledger-clipboard-format-verified` | `d153dc55c3dd0b13b6e8a064e9b8ebe8b312f4cf` | 每批／當日帳目統一為連續的「商品名稱＋數量」兩欄，不含批次、日期、成本、分隔線或空白列 | Build、core、Recent Purchases 與 Purchase Management clipboard tests 通過；本機 Test Sandbox 提示正常 | 否 | `workbench-backup-2026-08-15.json`（唯讀測試資料） | 無新增對應 | 無新增對應 | **是：剪貼簿格式修正回復點；Production 尚未部署** |
| 2026-08-16 23:10 | Integration | `checkpoint-20260816-2310-p0-c-purchase-batch-atomicity-design-gate` | `5ba1d1d4fc035d4898ac10ff9bcd63f3146844f0` | P0-C 採購批次＋明細原子保存分析；確認 Cloud 需要 server-side transaction／RPC，未以不可靠 compensation 假裝修正 | 靜態呼叫鏈與 Provider 邊界完成；無 runtime 修改、無寫入測試；附未來人工 SOP | 否 | 無新增對應 | 無新增對應 | 無新增對應 | **是：Design Gate 稽核節點；不是 Implementation Passed／Accepted** |
| 2026-08-16 23:14 | Integration | `checkpoint-20260816-2314-p0-d-inventory-sync-atomicity-design-gate` | `be3c0a0ef712f5fedd7461e2e1e117a8e29ef58f` | P0-D Inventory XLS 與訂購紀錄同步原子性分析；確認多個 Local／Cloud 提交需要複合 Provider 契約與 server-side transaction | 靜態資料流、Cloud delete／upsert／Product save 邊界完成；無 runtime 修改、無匯入寫入；附未來人工 SOP | 否 | 無新增對應 | 無新增對應 | 無新增對應 | **是：Design Gate 稽核節點；不是 Implementation Passed／Accepted** |
| 2026-08-16 23:16 | Integration | `checkpoint-20260816-2316-p0-e-outbound-delete-atomicity-design-gate` | `5784843ab228f385b8ff29e6b508dd0991d272aa` | P0-E 整張出庫單與明細刪除原子性分析；確認兩集合分開提交且 Cloud soft-delete error 會被吞掉 | 靜態刪除流程與 Cloud 錯誤路徑完成；無 runtime 修改、無刪除測試；附未來人工 SOP | 否 | 無新增對應 | 無新增對應 | 無新增對應 | **是：Design Gate 稽核節點；不是 Implementation Passed／Accepted** |
| 2026-08-16 23:21 | Integration | `checkpoint-20260816-2321-p0-f-bootstrap-failure-awaiting-acceptance` | `f390650aabcebbdeb1f9b9193738fc780d6abd89` | P0-F bootstrap 最外層 crash 保護；原生 DOM 錯誤頁、重新載入與僅 Test 生效的 failure injection | Build、core、bootstrap 專用測試、Sandbox guard／architecture、Test Owner 與本機 4192 正常／失敗頁驗證通過 | 否 | Test DB 資料未修改 | 無新增對應 | 無新增對應 | **是：Implementation Passed / Awaiting Manual Acceptance；尚未 Accepted** |
| 2026-08-16 23:23 | Integration | `checkpoint-20260816-2323-p0-f-bootstrap-failure-awaiting-acceptance-final` | `9e0690e7e3fb36b6959ca2f12ec51b896c09a699` | P0-F 最終本機節點；將 bootstrap 專用測試移至獨立 4196，避免與 Cloud restore test 的 4195 衝突 | Cloud restore 與 bootstrap test 並行重跑通過；其餘 P0-F Build／regression／Sandbox isolation 沿用上一節點並通過 | 否 | Test DB 資料未修改 | 無新增對應 | 無新增對應 | **是：P0-F 最終 Implementation Passed / Awaiting Manual Acceptance 節點；尚未 Accepted** |
| 2026-08-17 00:08 | Integration | `checkpoint-20260817-0008-p0-f-bootstrap-recovery-accepted` | `f94d03ff4b379fb4406e12559944e5c0ba0bcc77` | P0-F Bootstrap crash 保護人工驗收通過；錯誤頁、`BOOTSTRAP_FAILED`、重新載入、無白畫面及正常 URL 回復正常 | 既有 Build／bootstrap 專用測試／Sandbox isolation 通過；使用者完成實際故障 URL 與回復人工驗收 | 否 | Test DB 資料未修改 | 無新增對應 | 無新增對應 | **是：P0-F Accepted Restore Point** |
| 2026-08-16 23:26 | Integration | `checkpoint-20260816-2326-p0-stability-unattended-run-final` | `3e5b5ae7b01ad9f3f7c6ea48a5f6e5fff588c6eb` | P0 unattended run 最終本機總結；P0-A Accepted、P0-B／F 待人工驗收、P0-C／D／E Design Gate，並含 Bundle／近期採購獨立修正 | Build、全部適用 regression、Sandbox isolation、P0 race、Import／Restore／Backup／clipboard tests 通過；完整報告見 `docs/p0-stability-unattended-run-20260816.md` | 否 | `workbench-backup-2026-08-15.json`（Test 唯讀／重匯基準） | 無新增對應 | 無新增對應 | **是：本輪整體最完整回復點；未經人工驗收項目仍不可稱 Accepted** |
| 2026-08-16 18:02 | Test | `checkpoint-test-sandbox-before-production-like-p0-outbound-fix-20260816` | `a13721f83b763466ba19c32899f2011cfd8851c8` | 封存完整 Test Sandbox：Test Owner、Snapshot Import、近期採購、Stability Hardening、Feature Registry 與 Audit | Test Sandbox 完整測試／Audit 已完成 | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | **是：完整 Test Sandbox 封存點** |

## Production 歷史回復點

`時間待確認（Commit：...）` 表示該 Tag 是 lightweight tag，Git 未保存實際 Tag 建立時間；括號內只列 Commit 時間作追溯參考。

| 台灣日期時間 | 環境 | Tag | Commit Hash | 建立原因／當時功能 | Build／Test | 曾部署 Production | JSON／DB／Storage | 建議 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 時間待確認（Commit：2026-07-31 22:42） | Production | `production-backup-before-stability-20260801` | `113d9de3fee31229403680f723cfe6b2da9be434` | Catalog search endpoint hotfix；穩定性改版前正式點 | 當時 Build 通過；完整測試紀錄待確認 | 是 | 無已知直接對應 | 歷史 Production 回復點 |
| 時間待確認（Commit：2026-08-02 21:11） | Production | `production-backup-before-purchase-records-ui-20260805` | `da60016c200e79d38119d46824966880e3ac7c6c` | 採購缺口跨頁一致性；PurchaseRecords UI 改版前 | 紀錄待確認 | 是（依 Tag 用途；部署時間待確認） | 無已知直接對應 | 歷史回復點，使用前需重驗 |
| 時間待確認（Commit：2026-08-05 23:27） | Production | `production-backup-before-purchase-needed-filter-20260806` | `a3663218713035dc0bf4d4555be3722b9db2c712` | 手動出庫台幣價格 XLS 修正；需要採購篩選前 | 紀錄待確認 | 是（依 Tag 用途；部署時間待確認） | 無已知直接對應 | 歷史回復點，使用前需重驗 |
| 時間待確認（Commit：2026-08-06 21:21） | Production | `production-backup-before-manual-item-edit-20260806` | `407b1e8a0028c74a5e795b0c1e69665f65ba4efe` | 日本包裹／出庫商品處理；手動商品編輯前 | 紀錄待確認 | 是（依 Tag 用途；部署時間待確認） | 無已知直接對應 | 歷史回復點，使用前需重驗 |
| 時間待確認（Commit：2026-08-06 22:21） | Production | `production-backup-before-needs-purchase-filter-fix-20260806` | `cac2c42416ad4ed68f0afa48fd58457f6219e375` | 「只看需要採購」分頁組合修正前 | 紀錄待確認 | 是（依 Tag 用途；部署時間待確認） | 無已知直接對應 | 歷史回復點，使用前需重驗 |

## Test／Production-like／Integration 完整節點

| 台灣日期時間 | 環境 | Tag | Commit Hash | 建立原因／當時功能 | Build／Test | 曾部署 Production | Snapshot／外部備份 | 建議 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-12 23:05 | Test | `checkpoint-core-regression-baseline-20260812` | `e7358a47f2a53fb7e6a572bdefe781a177be31db` | 固定 Local fixture 與核心 ERP regression baseline | `test:core` baseline 建立完成 | 否 | 無 | 是：測試基準，不是正式程式回退點 |
| 時間待確認（Commit：2026-08-13 00:54） | Test | `checkpoint-test-sandbox-phase-a-before-a2` | `214f4d5a0ddbafe0012bded317cbbccc681d518d` | Test Mode、獨立 Test DB、初版 Guard／UI；A2 前 | Phase A 驗證完成 | 否 | 無 | 是：Phase A 回復點 |
| 2026-08-15 01:10 | Test | `checkpoint-test-sandbox-phase-a2-before-production-sync-20260815` | `b6e16d21dda5fd099236e61051d9c3bdc3ea65ab` | Test Owner、fail-closed network guard、Test storage 隔離；同步 Production 程式前 | A2 Build／Auth／Guard／Architecture 測試通過 | 否 | 無 | 是：Phase A2 回復點 |
| 2026-08-15 11:25 | Test | `checkpoint-test-sandbox-before-json-import-20260815` | `d907ea1b0577fe17a6bf390961c2ada9514ff3df` | Production JSON → Test DB importer 開發前 | Build、core、guard／architecture 通過 | 否 | 無 | 是：Snapshot Import 前回復點 |
| 2026-08-15 12:35 | Test | `checkpoint-test-sandbox-before-official-links-recent-purchases-20260815` | `084a2ebf8fedec0d9d66d8ba35c19e4b555bca9f` | Atomic Snapshot Import 完成；第二層官網／近期採購前 | Snapshot Import、Build、Sandbox isolation 通過 | 否 | `workbench-backup-2026-08-15.json` | 是：Snapshot Import 完成節點 |
| 時間待確認（Commit：2026-08-15 22:17） | Test | `checkpoint-test-sandbox-before-stability-hardening-20260816` | `97e3b9280d2f3df7693bdc66044e2d88e2956783` | Stability Hardening 批次前 | 先前 Feature 測試通過；Tag 時間待確認 | 否 | `workbench-backup-2026-08-15.json` | 是：Hardening 前回復點 |
| 時間待確認（Commit：2026-08-16 00:57） | Test | `checkpoint-before-import-performance-20260816` | `a5be3d987a7154535d337319e22eb5a2486e1ebe` | Snapshot／商品主檔匯入效能診斷前 | Sandbox lifecycle 診斷修正通過；完整紀錄見 Stability 文件 | 否 | `workbench-backup-2026-08-15.json` | 診斷用 |
| 時間待確認（Commit：2026-08-16 01:08） | Test | `checkpoint-test-sandbox-stability-hardening-complete-20260816` | `565c92c1627d5e98f7084cb16768a1e33eb97f9c` | Stability Hardening 與 regression 結果收尾 | Build／regression／isolation 通過 | 否 | `workbench-backup-2026-08-15.json` | 是：Hardening 完成節點 |
| 2026-08-16 18:09 | Production-like | `checkpoint-production-like-outbound-p0-sandbox-established-20260816` | `13a4f0db03faacad2aba787306d53d335cc1493c` | 最新 Production＋最小 Test isolation 建立完成 | Build／Sandbox architecture 通過 | 否 | 尚未匯入 | 是：P0 測試環境初始點 |
| 2026-08-16 18:14 | Production-like | `checkpoint-production-like-outbound-p0-snapshot-verified-20260816` | `e331f9ad27879231e9bee24f9eca43c6dbf3554b` | Production JSON Snapshot 已匯入獨立 Test DB 並驗證 | Snapshot 筆數／checksum／isolation 通過 | 否 | `workbench-backup-2026-08-15.json` | 是：可重現正式資料結構的測試點 |
| 2026-08-16 18:21 | Production-like | `checkpoint-production-like-outbound-p0-fix-complete-20260816` | `fe009d2403ab92710c3c16c09995e89b65bac1ae` | 出庫 checked save serialization P0 修正完成 | Build、針對性 race 測試通過 | 否 | `workbench-backup-2026-08-15.json` | 是：P0 修正程式節點 |
| 2026-08-16 19:26 | Integration | `checkpoint-integration-sandbox-base-p0-20260816` | `0d729c7a0a2df20491dcdc461d9324679abbb63f` | Integration Sandbox 起點：Production＋出庫 P0 | P0 stress／Sandbox isolation 通過 | 否 | `workbench-backup-2026-08-15.json` | 是：Integration 基準 |
| 2026-08-16 19:27 | Integration | `checkpoint-integration-after-official-link-20260816` | `b9e43c9ee047a298acccb766150dd64618378867` | 加入第二層既有 product_url 官網入口 | Build／core regression 通過 | 否 | 同上 | 可回退至單一 Feature 後狀態 |
| 2026-08-16 19:28 | Integration | `checkpoint-integration-after-recent-purchases-20260816` | `ae6815ede2de793babadaa0c3892a48771bed2df` | 加入獨立「近期採購」唯讀頁 | Build／core／recent-purchases 通過 | 否 | 同上 | 可回退至 Feature B 後狀態 |
| 2026-08-16 19:30 | Integration | `checkpoint-integration-after-purchase-actions-and-history-20260816` | `e722c90dadb248d2fc6580619557d81af4fe8029` | 加入採購操作防誤點與每批帳目複製恢復 | Build／targeted UI regression 通過 | 否 | 同上 | 可回退至採購 UI 節點 |
| 2026-08-16 19:31 | Integration | `checkpoint-integration-after-purchase-freight-20260816` | `031b47faaa3d473230dac350f9e0fc23677650b6` | 加入採購批次運費比例分攤（整數日圓） | Build／運費案例 A–G／core 通過 | 否 | 同上 | 可回退至運費 Feature 後狀態 |
| 2026-08-16 19:32 | Integration | `checkpoint-integration-after-local-mode-entry-20260816` | `d34b698944e1726c2cce820d02d9b46691b26c1e` | 加入 Cloud 訪客進入 Local Mode 入口 | Build／Cloud guest→Local OWNER regression 通過 | 否 | 同上 | 可回退至所有選定 Feature 已加入狀態 |
| 2026-08-16 19:33 | Integration | `checkpoint-integration-all-features-before-final-regression-20260816` | `687dae934b02ed5e2255a2242a2879c9ea9949b6` | 所有選定 Feature 整合完成、最終 regression 前 | 建立後開始 final regression | 否 | 同上 | 是：Final regression 前節點 |

## JSON Snapshot Index

| 檔案 | 本機位置 | 檔案時間（台灣） | 大小 | SHA-256 | 用途 | 是否建議保留 |
| --- | --- | --- | --- | --- | --- | --- |
| `workbench-backup-2026-08-15.json` | `C:\Users\小河馬\Downloads\workbench-backup-2026-08-15.json` | 2026-08-15 11:12:14（檔案時間；JSON 實際匯出時間以內容 metadata 為準） | 7,938,588 bytes | `E626E5A7A25A377072AA4358443D9D784EC772EF7BCE93349316D6339AD1A17F` | Test／Production-like Snapshot Import 與 P0 重現 | **是** |
| `workbench-backup-2026-08-15 (1).json` | `C:\Users\小河馬\Downloads\workbench-backup-2026-08-15 (1).json` | 2026-08-15 21:31:15（檔案時間；JSON 實際匯出時間以內容 metadata 為準） | 8,006,428 bytes | `FC3C642ACBE9C105333CDF7D2ABC58B7BCD3DB885A912A736C33B375358BF8C4` | 較晚的 Production ERP JSON 備份候選 | 是；使用前先核對內容 metadata |

## Database／Storage Backup Index

| 台灣日期時間 | 環境 | 類型 | 檔名／識別 | 驗證資訊 | 對應 Git 回復點 | 狀態 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-15 00:24:17（依檔名） | Production | PostgreSQL logical dump | `production-before-outbound-deploy-20260815-002417.dump` | SHA-256 `4a1cc105f68773f1e863d249760883a0d11f4cb0c975888259a7eda9f9cf3a21`；Schema／Data／核心表已驗證；實際檔案位置待補登 | `backup-production-before-outbound-purchase-records-20260815` → `716895ab...` | **保留，不覆蓋、不刪除** |
| 時間待確認 | Production | Supabase Storage backup | 檔名／Manifest／SHA-256 待補登 | 既有紀錄確認已完成；資料庫 dump 不包含 Storage 實體檔案 | `backup-production-before-outbound-purchase-records-20260815` → `716895ab...` | **保留；詳細資料待補登** |

## 歷史 Checkpoint 索引

以下節點保留供稽核／精準 bisect。除有 annotated tag 時間外，多數為 lightweight tag，因此 Tag 建立時間待確認。這些節點未找到完整 Build／Test、部署與外部備份對應紀錄，預設不建議直接覆蓋目前 Production；使用前必須另做完整回歸。

| 時間 | 環境 | Tag | Commit | 建立原因／功能 | 建議 |
| --- | --- | --- | --- | --- | --- |
| 時間待確認（Commit：2026-05-31 11:46） | 歷史開發 | `general-mode-v1` | `c08fe2eac25491e771e0378d71ef93d2c67cbeca` | Purchase Management general mode v1 | 僅追溯 |
| 時間待確認（Commit：2026-06-09 22:44） | 歷史開發 | `pre_phase1b_deploy` | `82ff802d4e7cda1c29aac17bb8a4e9c43144106b` | Sync 保留 purchased／private null 值 | 僅追溯 |
| 時間待確認（Commit：2026-06-22 00:53） | 歷史開發 | `backup-mobile-kpi-v1` | `7fbea19acffbf3d3065cac71f32d4a4f83672daa` | Mobile KPI layout | 僅追溯 |
| 時間待確認（Commit：2026-06-22 01:22） | 歷史開發 | `backup-mobile-layout-v3` | `e2b7506e041510952ca3b45de46bc4dd8bc7a423` | Mobile PurchaseRecords layout | 僅追溯 |
| 時間待確認（Commit：2026-06-22 01:30） | 歷史開發 | `backup-mobile-stable-v1` | `edc1300929dd1b0aece644287e8e25e287b41c86` | Mobile PurchaseRecords／numeric input polish | 僅追溯 |
| 時間待確認（Commit：2026-06-23 00:43） | 歷史開發 | `stable-gap-sync-20260623` | `aba157a7a742ae42f715fcd2469ff5270c07a363` | Demand／gap 計算一致性 | 重要歷史核心節點；使用前重驗 |
| 時間待確認（Commit：2026-07-06 21:57） | 歷史開發 | `backup-2026-07-07-before-purchasing-ui` | `8ee0b74ebf24f46becf68bbba654651288245b98` | Purchase batch Modal 排序同步 | 僅追溯 |
| 時間待確認（Commit：2026-07-09 01:22） | 歷史開發 | `checkpoint-pre-purchase-dedup-fix` | `450b4ee3172c06a9c0a6609ca21e72054938b6d1` | Pagination duplicate 防護 | 重要歷史資料一致性節點 |
| 時間待確認（Commit：2026-07-09 09:25） | 歷史開發 | `checkpoint-unknown-duplicate-fixed` | `68dab4ffb1210b30c9e67ddf1579e851a2d87ef2` | Variant dedupe／unknown orphan 修正 | 重要歷史資料一致性節點 |
| 時間待確認（Commit：2026-07-09 09:55） | 歷史開發 | `checkpoint-ui-perf-fixed` | `0f858212fed5992956cbe5451512747a01f2285d` | PurchaseRecords UI／render 效能 | 僅追溯 |
| 時間待確認（Commit：2026-07-09 10:12） | 歷史開發 | `checkpoint-router-state-fixed` | `4abceeeebbf3c2b01469784cae8677c15c645d28` | 返回時保留 filter／scroll | 僅追溯 |
| 時間待確認（Commit：2026-07-09 14:45） | 歷史開發 | `checkpoint-loading-cache-preview` | `b142fe6f8016e398da0e93021092ac76b4d72622` | PurchaseRecords cache preview | 僅追溯 |
| 時間待確認（Commit：2026-07-09 15:21） | 歷史開發 | `checkpoint-waca-manual-dedupe-fixed` | `d03c9bdf6b90c9f2becbbe794a75e83d95208f9b` | WACA manual adjustment dedupe | 重要歷史核心節點 |
| 時間待確認（Commit：2026-07-09 16:02） | 歷史開發 | `checkpoint-delete-sync-fixed` | `0b34aa58694d82dade8d3a49e9367aab167c8651` | Private order／category deletion sync | 重要歷史同步節點 |
| 時間待確認（Commit：2026-07-09 17:07） | 歷史開發 | `checkpoint-pending-purchase-gap-fixed` | `bf4197137deab9af49b60bb918ccfcb68c1c9dee` | Pending purchase per-variant gap | 重要歷史核心節點 |
| 時間待確認（Commit：2026-07-09 19:59） | 歷史開發 | `checkpoint-unlisted-items-finalized` | `fc460d391b0ff542cf36ae63b249f8432d24aef9` | UnlistedItems processed mark／layout | 僅追溯 |
| 2026-07-09 23:11 | 歷史開發 | `checkpoint-no-closing-date-filter` | `44dccbf6981a2c61acafe9786d4a9ddf9b727155` | PurchaseRecords 未設定結單日 filter | 僅追溯 |
| 2026-07-11 12:32 | 歷史開發 | `checkpoint-ui-fixes-scroll-columns` | `f62a47b568f169d49d6e40573241ae855ba60d21` | Resizable columns／scroll／date UX／save error | 僅追溯 |
| 2026-07-11 12:33 | 歷史開發 | `checkpoint-bundle-select-all` | `12352cce5d2e3989aeb4d0d82ec860e83a12c25d` | Bundle component select all | 僅追溯 |
| 2026-07-12 20:43 | 歷史開發 | `checkpoint-pullinventory-catalog-fields` | `2656745b772e2b27b337473e4dde8cda7c29f4bf` | pullInventory catalog fields | 重要歷史同步節點 |
| 2026-07-12 20:43 | 歷史開發 | `checkpoint-unlisted-gap-filter` | `a9b020d0e8cfb43413c413919837d5812c0d0f29` | UnlistedItems gap-only filter | 僅追溯 |
| 時間待確認（Commit：2026-07-16 23:31） | 歷史開發 | `backup-before-duplicate-manager` | `2f1470db82f6215db0b5f560a8ba3e680f25ff9d` | Duplicate-variant manager 前 | 僅追溯 |
| 時間待確認（Commit：2026-07-16 23:31） | 歷史開發 | `backup-before-purchase-record-update-20260719` | `2f1470db82f6215db0b5f560a8ba3e680f25ff9d` | PurchaseRecords update 前；與上一 Tag 同 Commit | 僅追溯 |
| 時間待確認（Commit：2026-07-19 20:57） | 歷史開發 | `checkpoint-before-purchase-record-column-reorder` | `64747c8200f7add6b08f02452c937f0fa54fdba9` | Batch auto-name／release-month sort | 僅追溯 |
| 時間待確認（Commit：2026-07-29 12:02） | 歷史開發 | `backup-20260729-auto-lookup-export` | `74d65f401ed3976db657c6334d034778b570a648` | Deadline auto lookup／Excel／Outbound | 歷史大功能節點；使用前重驗 |
| 時間待確認（Commit：2026-07-31 12:09） | 歷史開發 | `backup-992840f-20260731` | `992840fc252379846f7e8c42f5737663282569c0` | Crash resilience／outbound pool／auth timeout | 歷史穩定性節點 |
| 時間待確認（Commit：2026-07-31 13:54） | 歷史開發 | `backup-20260731-fix-profile-loading` | `186f059bb763eed0fac95175d4066ce113052cc6` | Profile load gating | 歷史 Auth 節點 |
| 時間待確認（Commit：2026-07-31 14:21） | 歷史開發 | `checkpoint-auth-session-helper-write-fixed` | `61485c9a067c65db2cba79a8167d59988ad90ed4` | Auth session／helper status writes | 歷史 Auth 節點 |
| 時間待確認（Commit：2026-07-31 20:07） | 歷史開發 | `checkpoint-storage-guard-stage-1b1` | `f71d2d8d865b8053fa5b17ecc8f5ecc69d878dd4` | Browser storage failure warning | 歷史穩定性節點 |
| 時間待確認（Commit：2026-08-01 10:21） | 歷史開發 | `checkpoint-dashboard-image-storage-stage-1b2` | `db4cf38c606f84ef0db1330283bd5aa944f18791` | Dashboard images → IndexedDB | 歷史儲存節點 |
| 時間待確認（Commit：2026-08-01 11:12） | 歷史開發 | `checkpoint-dashboard-load-error-stage-3a` | `a2c6967be0c804d42d5690c4decc14c42a8cefca` | Dashboard load failure／empty 分離 | 歷史穩定性節點 |
| 時間待確認（Commit：2026-08-01 20:53） | 歷史開發 | `checkpoint-c108-category` | `e753158fe3593c88a332a3c23406d997d6a9925a` | C108 priority category | 僅追溯 |
| 時間待確認（Commit：2026-08-02 16:38） | 歷史開發 | `checkpoint-purchasing-group-batch-scope` | `1a3b31916f3ffd165fc5fdaa5beb5e17d4a569fa` | Purchasing totals group scope | 重要歷史核心節點 |
| 時間待確認（Commit：2026-08-02 17:12） | 歷史開發 | `checkpoint-group-scoped-purchase-calculations` | `30d7a1d0a94c53366990bcc9a1f87c45f77498e4` | Purchase calculations group scope | 重要歷史核心節點 |
| 時間待確認（Commit：2026-08-02 21:11） | 歷史開發 | `checkpoint-purchase-shortage-parity` | `da60016c200e79d38119d46824966880e3ac7c6c` | Shortage calculation parity | 重要歷史核心節點 |
| 時間待確認（Commit：2026-08-05 22:15） | 歷史開發 | `checkpoint-erp-ui-enhancements-20260805` | `9926197eb8eda070903fccb93f210fa1328abbf7` | SKU、missing JPY、deadline views、WACA updater | 歷史 ERP UI 節點 |
| 時間待確認（Commit：2026-08-05 22:32） | 歷史開發 | `checkpoint-purchase-records-sticky-header-20260805` | `95c4370c8e50ee50d0693a47404a6995fab184ee` | Sticky header | 僅追溯 |
| 時間待確認（Commit：2026-08-05 22:46） | 歷史開發 | `checkpoint-column-resize-performance-20260805` | `9aacd961ca3e30f2943e6d5ea0979866514db711` | Column resize performance／delete header | 僅追溯 |
| 時間待確認（Commit：2026-08-05 23:04） | 歷史開發 | `checkpoint-purchase-records-resize-guide-20260805` | `0539d3496106b585e7b3000346718c0fe6c672db` | Lightweight resize guide | 僅追溯 |
| 時間待確認（Commit：2026-08-05 23:18） | 歷史開發 | `checkpoint-manual-outbound-twd-price-20260805` | `8ce9db5e4adac1d148ca74eb85753e74b45306d9` | Manual outbound TWD price | 歷史出庫節點 |
| 時間待確認（Commit：2026-08-05 23:27） | 歷史開發 | `checkpoint-outbound-xls-manual-twd-price-20260805` | `a3663218713035dc0bf4d4555be3722b9db2c712` | XLS manual TWD price | 歷史出庫節點 |
| 時間待確認（Commit：2026-08-06 20:13） | 歷史開發 | `checkpoint-japan-package-item-handling-20260806` | `5914542a826468bcf8a7cdc51ff6637a7434a28b` | Japan package／outbound item handling | 歷史日本包裹／出庫節點 |
| 時間待確認（Commit：2026-08-06 22:18） | 歷史開發 | `checkpoint-manual-item-edit-20260806` | `5787a08343fda10649b486c0d58fc37466f29658` | Manual package／outbound item edit | 歷史日本包裹／出庫節點 |
| 時間待確認（Commit：2026-08-06 23:14） | Production | `checkpoint-needs-purchase-filter-composition-20260806` | `716895ab0edf362259323bfef3759395a4199217` | Purchase-needed filter 與狀態分頁疊加 | 後續曾作為正式基準 | 是 | **已由 2026-08-15 Production backup tag 取代為更完整索引** |

## 稽核文件

本次 Stability Audit v2 報告：`docs/system-stability-audit-v2.md`。報告只記錄風險與測試結果，不代表任何 P0／P1 已修正；後續修正必須另建帶台灣日期時間的 checkpoint。

## Dual Sandbox Checkpoint Index（2026-08-17）

以下節點屬本地 Test Infrastructure，Production 不得使用。Tag 均使用
Asia/Taipei 時間；既有 Tag 保留不改名、不刪除。

| 台灣日期時間 | 環境 | Tag | Commit | 建立原因／內容 | Build／Test | Production 部署 | Snapshot／Backup | 建議作為 Restore Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-17 00:22 | Integration | `checkpoint-20260817-0022-dual-sandbox-before` | `d6b412c` | 建立雙 Sandbox 前保存 Integration 狀態 | 建立前節點 | 否 | 無新增 | 是：雙 Sandbox 前回復點 |
| 2026-08-17 00:44 | Next Sandbox | `checkpoint-20260817-0044-next-sandbox-isolated` | `961ec41` | Next 固定 DB、storage namespace、Test Owner、fail-closed guard 與模式 UI | Build／architecture／dual isolation 通過 | 否 | 無新增 | 是：Next 隔離完成點 |
| 2026-08-17 00:46 | Experimental Sandbox | `checkpoint-20260817-0046-experimental-sandbox-isolated` | `0c61828` | Experimental 以獨立 worktree 建立同等隔離基準 | Build／dual isolation 通過 | 否 | 無新增 | 是：Experimental 隔離完成點 |
| 2026-08-17 01:01 | Next + Experimental | `checkpoint-20260817-0101-dual-sandbox-snapshot-parity` | `7b740f9`（Next；Experimental 後續 cherry-pick） | 同一 Production JSON Snapshot 兩環境匯入、筆數與 collection hash parity | Next／Experimental parity test 通過；Production request 0 | 否 | `workbench-backup-2026-08-15.json` | 是：Snapshot parity 完成點 |
| 2026-08-17 01:01 | Next + Experimental | `checkpoint-20260817-0101-dual-sandbox-baseline-complete` | `7b740f9`（Next；Experimental 後續 cherry-pick） | 固定資料規模的載入／搜尋／排序／Inventory parser 效能 baseline | Next／Experimental baseline test 通過；Production request 0 | 否 | 同上 | 是：人工驗收前基準 |
| 2026-08-17 01:03 | Experimental | `checkpoint-20260817-0103-experimental-sandbox-snapshot-parity` | `b13def4` | Experimental 套用同一 parity／baseline 測試與文件節點 | parity test 通過；Production request 0 | 否 | `workbench-backup-2026-08-15.json` | 是：Experimental parity 回復點 |
| 2026-08-17 01:03 | Experimental | `checkpoint-20260817-0103-experimental-sandbox-baseline-complete` | `b13def4` | Experimental 固定資料規模 baseline 節點 | baseline test 通過；Production request 0 | 否 | 同上 | 是：Experimental 人工驗收前基準 |
| 2026-08-17 11:03 | Next + Experimental | `checkpoint-20260817-1103-stage-00-before-unattended-validation` | `37f8c50`（Next；Experimental `180348f`） | Unattended validation 起始基準；兩個持久 Sandbox 尚未匯入 Snapshot | Stage 0 記錄完成 | 否 | Snapshot reference only；未自動匯入 | 是：Stage 0 回復點 |
| 2026-08-17 11:12 | Next Sandbox | `checkpoint-20260817-1112-stage-02-dual-sandbox-lifecycle` | `344801a` | 雙 Sandbox 匯入／重整／獨立清空／重新匯入生命週期測試工具與通過節點 | Lifecycle test 通過；Production request 0 | 否 | `workbench-backup-2026-08-15.json`（僅本機測試） | 是：Next Stage 2 回復點 |
| 2026-08-17 11:15 | Experimental Sandbox | `checkpoint-20260817-1115-experimental-stage-02-dual-sandbox-lifecycle` | `d647278` | 同一生命週期隔離測試套用至 Experimental 的通過節點 | Lifecycle test 通過；Production request 0 | 否 | `workbench-backup-2026-08-15.json`（僅本機測試） | 是：Experimental Stage 2 回復點 |

## Dual Sandbox unattended validation stages (2026-08-17)

The following stages are local audit checkpoints. They are not Production
release points. All times use Asia/Taipei and all tags created for this run
include the Taiwan date and time. Manual acceptance remains pending unless
the operator explicitly completes the relevant SOP.

| 台灣日期時間 | 環境 | Tag | Commit | Stage / reason | Build / test | Production deploy | Restore-point guidance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-03-feature-regression` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | Selected feature regression | Targeted tests passed | 否 | Manual acceptance pending |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-04-purchaserecords-race-audit` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | PurchaseRecords / save-race regression record | Core and outbound race checks passed | 否 | Manual acceptance pending |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-05-purchase-workspace-regression` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | Purchase workspace, freight and ledger checks | Targeted tests passed | 否 | Manual acceptance pending |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-06-japan-package-ui-regression` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | Japan Package / bundle visual review | Field testing pending | 否 | Manual acceptance pending |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-07-outbound-regression` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | Outbound export and receiving regression | Targeted tests passed | 否 | Manual acceptance pending |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-08-p0-abf-regression` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | P0-A / P0-B / P0-F automated regression | Automated checks passed; manual SOP pending | 否 | Do not mark Accepted automatically |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-09-p0-design-gate` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | P0-C / P0-D / P0-E design gate | No implementation | 否 | Design reference only |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-10-experimental-baseline` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | Fixed Snapshot performance baseline | Measurement passed | 否 | Benchmark reference |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-11-purchaserecords-performance-analysis` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | PurchaseRecords performance analysis | No stable optimization claim | 否 | Analysis reference |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-12-import-performance-analysis` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | Product/Variant import bottleneck analysis | No code change | 否 | Analysis reference |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-13-stability-audit-v3` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | Stability Audit v3 report | Build/tests documented | 否 | Audit restore point |
| 2026-08-17 11:38 | Next + Experimental | `checkpoint-20260817-1138-stage-14-feature-registry-audit` | `7673cfa57f43fdaf9de8ea364988e07338d3e3ca` | Feature Registry status audit | No feature promoted | 否 | Registry audit point |

## P0-G / P0-H Production Snapshot parity diagnostic (2026-08-17)

| 台灣日期時間 | 環境 | Tag | Commit | 建立原因／內容 | Build／Test | Production 部署 | Snapshot／Backup | 建議作為 Restore Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-17 20:50 | Next Sandbox | `checkpoint-20260817-2050-p0-gh-production-snapshot-diagnostic` | `c9072d4` | P0-G Production Business Parity 與 P0-H PurchaseBatch Item Referential Integrity 唯讀診斷；未修資料與程式 | 未執行完整 Build；診斷證據已記錄 | 否 | `workbench-backup-2026-08-15.json`；無新增備份 | 否：只作診斷回復點，完成 raw Next 四層驗證前不可作資料修復基準 |
| 2026-08-17 20:55 | Next Sandbox | `checkpoint-20260817-2055-before-p0-gh-phase2-raw-db-probe` | `d6eb39d389d76f26d5da7f7f7749e4ad849f690c` | P0-G/H Phase 2 Next raw readonly probe 實作前乾淨點 | 前一階段診斷完成；工作目錄 clean | 否 | `workbench-backup-2026-08-15.json` 僅唯讀對照 | **是：Phase 2 前乾淨回復點** |
| 2026-08-17 21:18 | Next Sandbox | `checkpoint-20260817-2118-p0-gh-phase2-root-cause` | `0530749bba3bdb4b8651e39017f1da605afc0c9b` | Next-only raw readonly probe、5 筆 VSPO 四層對照、完整 orphan audit 與隔離暫存 DB importer 重現；確認持久 Next Variant identity 已由 catalog 重建路徑替換 | Build、core、Sandbox guard／architecture、專用 `test:p0-gh-next-raw-integrity` 全通過；Production Supabase request 0 | 否 | `workbench-backup-2026-08-15.json` 僅唯讀／隔離暫存 DB | **是：P0-G/H Phase 2 root-cause 診斷點；不是資料修復點** |
| 2026-08-17 21:40 | Next Sandbox | `checkpoint-20260817-2140-before-sync-variant-regression-bisect` | `16be600cebd39c8b20fd6d6d1b3cb1b7f33f0099` | 建立跨 Commit Variant identity／WACA／FK regression test 與 git bisect 前乾淨點 | 建立前工作目錄 clean；後續 bisect 確認 `c08fe2e` 為 First Bad | 否 | `workbench-backup-2026-08-15.json` 僅在全新隔離 DB 測試 | **是：sync regression bisect 前回復點** |
| 2026-08-17 20:50 | Experimental Sandbox | `checkpoint-20260817-2050-experimental-performance-paused` | `1bd7faf30b2ec1381514a63696ad61f758285c9a` | 暫停 Experimental Performance 工作，保留原狀 | 原節點狀態不變 | 否 | 無新增 | 是：保留實驗分支停工前狀態 |
| 2026-08-17 23:26 | Next Sandbox | `checkpoint-20260817-2326-before-p0-g-variant-destructive-sync-guard` | `50709bd88a5ceb699a654283f1eb91f088ee0c28` | P0-G Variant destructive sync fail-closed guard 實作前；已確認 `c08fe2e` 為 Historical First Bad Commit | 實作前工作目錄 clean；Production 0 write／0 deploy | 否 | `workbench-backup-2026-08-15.json` 僅供隔離回歸 | **是：P0-G 防護實作前乾淨回復點** |
| 2026-08-17 23:45 | Next + Experimental | `checkpoint-20260817-2345-p0-g-variant-sync-guard-awaiting-manual-acceptance` | Next `edbac2f8d72b408c9fb2e1321cbad5d9707f801e`；Experimental `f0699bbdcd15b6cb04684fcee0686cf4f471db4f` | P0-G fail-closed guard：嚴格 readonly source probe、Verified Empty 分流、Variant identity／manual adjustment／大量建立 sanity gate、Test-only failure injection | Next／Experimental Build；core；Sandbox guard／architecture；舊 sync regression；新正常／讀取失敗／異常 0／Verified Empty 專用測試通過；Production Supabase request 0 | 否 | `workbench-backup-2026-08-15.json` 僅供隔離回歸；未修改來源檔 | **是：Implementation Passed / Awaiting Manual Acceptance；尚未 Accepted** |
| 2026-08-18 00:18 | Next Sandbox | `checkpoint-20260818-0018-p0-g-variant-sync-guard-accepted` | 待建立（Accepted docs checkpoint） | P0-G 正常同步、Variant Read Failure 故障注入、F5 後固定 VSPO 業務數字與採購批次解析人工驗收通過 | Build／core／sandbox guard／architecture／P0-G 專用測試通過；人工 SOP 通過 | 否 | `workbench-backup-2026-08-15.json` 僅供隔離驗收；無 Production 寫入 | **是：P0-G Accepted 回復點** |

## Next Sandbox Nightly Stability (2026-08-18)

| 台灣日期時間 | 環境 | Tag | Commit | 建立原因／內容 | Build／Test | Production 部署 | Snapshot／Backup | 建議作為 Restore Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-18 00:36 | Next Sandbox | `checkpoint-20260818-0036-next-nightly-start` | `f0d08f2` | Nightly Stability 起始；保存 P0-G Accepted 後的乾淨 Next | 起始前 clean | 否 | `workbench-backup-2026-08-15.json` | 是：Nightly 前回復點 |
| 2026-08-18 00:48 | Next Sandbox | `checkpoint-20260818-0048-next-data-integrity` | `0791069` | Next-only raw Snapshot parity、Golden Business Regression、完整 orphan probe 與測試工具 | raw counts/hash/orphan/golden PASS；Build PASS | 否 | 同上；Snapshot SHA-256 已記錄於 Nightly Report | 是：資料完整性回復點 |
| 2026-08-18 00:48 | Next Sandbox | `checkpoint-20260818-0055-next-data-integrity` | `0791069` | 同 `0048` 內容的預估命名 alias；保留以避免破壞既有引用 | 同上 | 否 | 同上 | 可追溯，不作首選 |

Nightly stage 的自動測試不等同人工 Accepted。

| 2026-08-18 00:53 | Next Sandbox | `checkpoint-20260818-0053-next-business-parity` | `135e086` | Raw counts/hash 與 VSPO Golden business parity | raw probe PASS；Production request 0 | 否 | `workbench-backup-2026-08-15.json` | 是：business parity 回復點 |
| 2026-08-18 00:53 | Next Sandbox | `checkpoint-20260818-0053-next-relational-integrity` | `135e086` | Snapshot orphan 與 Next raw orphan 對照 | orphan 未增加 | 否 | 同上 | 是：關聯完整性回復點 |
| 2026-08-18 00:53 | Next Sandbox | `checkpoint-20260818-0053-next-p0g-regression` | `135e086` | P0-G 正常／故障／Verified Empty regression | P0-G 專用測試 PASS | 否 | 同上 | 是：P0-G nightly 回復點 |
| 2026-08-18 00:53 | Next Sandbox | `checkpoint-20260818-0053-next-feature-regression` | `135e086` | Recent Purchases、Purchase Management、Outbound regression | targeted tests PASS；人工驗收待做 | 否 | 同上 | 是：feature regression 回復點 |
| 2026-08-18 00:53 | Next Sandbox | `checkpoint-20260818-0053-next-soak-complete` | `135e086` | 100 route cycles、30 reload、performance baseline | console/page error 0；heap 需後續 trend | 否 | 同上 | 是：soak 完成回復點 |

## Next Extended Stability (2026-08-18)

以下均為 `codex/next-sandbox` 的本地 checkpoint；沒有 Push、Deploy 或 Production write。時間以 annotated tag metadata 為準；若 Tag 名稱中的時間與實際 tagger time 不一致，保留原 Tag、不 rename/delete，並以 metadata 記錄。

| 台灣日期時間 | 環境 | Tag | Commit Hash | 建立原因／當時功能 | Build／Test | 曾部署 Production | JSON Snapshot | Database Dump | Storage Backup | 是否建議 Restore Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-18 04:50:04 | Next | `checkpoint-20260818-0449-next-extended-start` | `0ac087a2f5ba35987870ac3b0801bda4e3edf728` | 數據鎖定後的 Extended Stability 起始；建立 baseline 前乾淨點 | 起始 clean；後續 baseline integrity PASS | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | 是：本輪起始回復點 |
| 2026-08-18 04:57:03（Tag 名稱為 0508） | Production-like／Next test tool | `checkpoint-20260818-0508-p0g-hotfix-productionlike-verified` | `7750b0804b707f0cdfa95f0c1d80fcd6b5d596f7` | b50a0a4 Production-like P0-G Hotfix 正常／Variant read failure zero-write 驗證器 | `test:p0-g-hotfix-productionlike` PASS | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | 是：P0-G 人工驗收前回復點 |
| 2026-08-18 05:00:43 | Next | `checkpoint-20260818-0500-next-readonly-soak` | `627c0028f4653cada2b942876cafa42388e8c47d` | 10 輪、60 路由、10 F5 的純讀取 checksum soak | checksum／Console／Page Error／Supabase request PASS | 否 | 同上 | 無 | 無 | 是：read-only soak 回復點 |
| 2026-08-18 05:01:42 | Next | `checkpoint-20260818-0501-p1-read-failure-audit` | `c95248e76bab3095f6a13e7a29d714019616ea62` | P1 Read Failure Matrix；未改 runtime | 文件 audit 完成 | 否 | 同上 | 無 | 無 | 是：P1 audit reference |
| 2026-08-18 05:04:00 | Next | `checkpoint-20260818-0504-p1-read-failure-harness` | `2346edd7bbc45492a10097d89a19c79076ebc267` | 7 類 read fault injection；failure 不寫 Test DB | `test:read-failure-harness` PASS | 否 | 同上 | 無 | 無 | 是：Read Failure harness 回復點 |
| 2026-08-18 05:04:38 | Next | `checkpoint-20260818-0504-test-harness-fixed` | `af38849c9c7ea67e991079f65071eed7408b3ec8` | `test:atomic-import-data` 改用 neutral port 4253；只改 test harness | `test:atomic-import-data` PASS | 否 | fixtures／同上 | 無 | 無 | 是：test harness 回復點 |
| 2026-08-18 05:05:09 | Next | `checkpoint-20260818-0505-next-feature-registry-reviewed` | `a701fc2ecbf53b532f5da9734ca41a9d7ff1d264` | Feature Registry 健康度盤點；未提升 Production Ready | 文件 review 完成 | 否 | 同上 | 無 | 無 | 是：Registry review reference |
| 2026-08-18 05:08:25 | Next | `checkpoint-20260818-0508-next-fixture-regression` | `29992ce26f2bedd5959abc61cd62579f251965e9` | Test fixture writing flows、Outbound、Inventory、freight helper regression | targeted tests PASS | 否 | 同上 | 無 | 無 | 是：fixture regression 回復點 |
| 2026-08-18 05:10:05 | Next | `checkpoint-20260818-0510-next-performance-measured` | `29992ce26f2bedd5959abc61cd62579f251965e9` | 三輪 Next-only 效能量測；沒有優化 | 3 runs PASS；console/page error 0 | 否 | 同上 | 無 | 無 | 是：measurement reference |
| 2026-08-18 05:19（Tag metadata） | Next | `checkpoint-20260818-0519-next-extended-complete` | `1073e360aeaaf9b5e26738c58e149f8c5edda8a1` | Extended Stability 報告、P0-G report、人工驗收卡與 final automated gate 完成 | Build／TypeScript、選定全套 tests、diff check PASS；等待人工驗收 | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | **是：本輪最終 Next 回復點；尚未人工 Accepted** |

## Next Functional Exploration (2026-08-19)

| 台灣日期時間 | 環境 | Tag | Commit Hash | 建立原因／當時功能 | Build／Test | 曾部署 Production | JSON Snapshot | Database Dump | Storage Backup | 是否建議 Restore Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-19 00:41 | Next | `checkpoint-20260819-0041-next-before-functional-exploration` | `f6f7f32994b2261ccd4d0b0a82e16c418e20accb` | Functional Exploration、Real-world Catalog Regression、Stability Audit 前基準；保存既有單價 permission fix 與 Field Test Bug 記錄 | `test:next-nightly-integrity` PASS；完整 nightly gate 待本輪完成 | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | 是：本輪起始回復點 |
| 2026-08-19 01:01 | Next | `checkpoint-20260819-0101-next-functional-exploration-complete` | `b19889d` | Functional Exploration、Catalog read-only probe、唯讀 route/F5 soak、P0/atomic/import/backup regression 與 Stability Audit v4 完成；未新增 runtime code | Build、core、Sandbox guard/architecture、snapshot/atomic、P0-G、readonly soak 等 PASS；`purchase-management-actions` clipboard automation timeout；lint 維持既有 baseline failure；人工驗收待做 | 否 | `workbench-backup-2026-08-15.json` | 無 | 無 | 是：本輪 Next 報告回復點；尚未人工 Accepted |
| 2026-08-19 12:36 | Next | `checkpoint-20260819-1236-next-closing-date-evaluation-harness` | `ace8f9b56a983c119aac5f4bbf73f1978060d0f3` | 暫停單一商品 Matching 修改；建立 Catalog Candidate Capture、固定 Golden fixture、Offline Matching Replay、Next-only 診斷面板與已知失敗報告 | `build:next`、offline evaluation、Product Identity、core、Sandbox guard／architecture、Next integrity 通過；Catalog availability 在允許公開 upstream 的環境通過 | 否 | `tests/fixtures/closing-date/dataset.json`；不讀 ERP DB | 無 | 無 | 是：Next Field Test / Evaluation Harness 回復點；Matching v2 尚未開始 |
| 2026-08-19 12:17 | Next | `checkpoint-20260819-1217-next-before-catalog-matching-integration` | 待建立 | 自動查詢結單日大規模 Field Test 前乾淨基準；準備整合已完成的 Product Identity Matching、Supplier Selection 與 Catalog API 可用性修正；不提升 Production 狀態 | 建立前工作目錄 clean；整合後 gate 待執行 | 否 | `workbench-backup-2026-08-15.json` 僅作隔離回歸資料 | 無 | 無 | 是：整合前回復點；尚未人工 Field Accepted |
| 2026-08-19 12:51 | Next | `checkpoint-20260819-1251-closing-date-dataset-expanded` | `69984a8` | Evaluation Dataset 從 8 擴充至 44 筆真實代理商品；新增分層 coverage、OBSERVE replay 分類與 failure-cluster 報告；Matching v1/v2 均未修改 | `build:next`、44-case offline evaluation、Product Identity、core、Sandbox guard／architecture、`git diff --check` 通過；offline replay 0 Catalog／Supabase request；Golden regression 0 | 否 | `tests/fixtures/closing-date/dataset.json`；來源固定 Production JSON，僅讀取 Catalog candidate | 無 | 無 | 是：Dataset Expanded / Awaiting Matching v2 Design；尚未 Production Ready |
| 2026-08-19 13:08 | Next | `checkpoint-20260819-1308-before-retrieval-v2` | `496384ba99e2b1839af651398845b65a231ef9c2` | Retrieval v2 + Identity Parsing Foundation 實作前乾淨節點；44 筆 Dataset 與 Matching v1 固定不動 | 起始 `git status` clean；前一節點完整 gate 已通過 | 否 | `tests/fixtures/closing-date/dataset.json`；不讀寫 ERP DB | 無 | 無 | 是：Retrieval v2 實作前回復點 |
| 2026-08-19 13:33 | Next | `checkpoint-20260819-1333-retrieval-v2-automated-tested` | `683f2a0f26e717a03a5f007afefe47a474004eeb` | Retrieval v2、Identity Candidates、Product Line metadata、Progressive Query/cache、Runtime/Capture 共用 Planner 與 44-case fixture 更新 | `build:next`、core、Product Identity、44-case offline evaluation、Sandbox guard／architecture、Next nightly integrity、diff check 全通過；Production Supabase request 0 | 否 | `tests/fixtures/closing-date/dataset.json`；Catalog READ ONLY | 無 | 無 | 是：Implemented + Automated Tested / Awaiting Evaluation Review；不是 Production Ready |
| 2026-08-19 21:49 | Next | `checkpoint-20260819-2149-closing-date-v2-field-test-candidate` | `9f97f6d0675391ff737ec42685841367dcad7102` | Parser v2 結構化 Query fallback、Next Runtime Query 診斷、真實 4192 Catalog safety probe；v1 仍優先且非 Next 模式完全不啟用 | `build:next`、Parser v1/v2、Query v2、Pilot、44-case、core、Sandbox guard／architecture、diff check PASS；真實 4192：5 correct、0 false positive、4 safe reject；Production Supabase request 0 | 否 | 44-case fixture 與公開 Catalog READ ONLY；未寫 ERP Snapshot | 無 | 無 | 是：Closing Date Lookup v2 Field-Test Candidate / Awaiting Human Acceptance；不是 Production Ready |
| 2026-08-19 22:04 | Next | `checkpoint-20260819-2204-closing-date-v2-version-compatibility-awaiting-manual` | `510b24dc8f57730724ea194a94018bf1f1996c21` | Matching v2 Pilot 的一般／普通／通常／Standard 版本缺省相容性；新增 fail-closed 證據門檻與 V2 fallback 診斷 | `build:next`、Parser v1/v2、Query v2、Pilot、44-case、core、Sandbox guard／architecture、diff check PASS；真實 4192 赫蘿一般版選 Wanrong，raw 9/7、ERP 9/5；false positive 0；Production Supabase request 0 | 否 | 44-case fixture 與公開 Catalog READ ONLY；未寫 ERP Snapshot | 無 | 無 | 是：Awaiting Human Field Test；不是 Production Ready |
| 2026-08-19 23:17 | Next | `checkpoint-20260819-2317-before-plamatea-version-safety-veto` | `1ff4ddf7dc88a770e254a75356035520a274e194` | P21-11 已確認 PLAMATEA 一般版可被 v1 誤配 Black Barrel Edition；建立 Next-only v2 version safety veto 前乾淨點 | 建立前 `git status` clean；前一節點測試證據保留；未觸發 ERP 寫入 | 否 | 既有 44-case fixture 與人工研究資料；無 Snapshot 寫入 | 無 | 無 | **是：Confirmed Version False Positive 修正前回復點** |
| 2026-08-19 23:33 | Next | `checkpoint-20260819-2333-closing-date-version-safety-veto-awaiting-manual` | `7407525a385c35092f6727bbdc7a48ab2e0de644` | Next-only v2 Safety Veto：同商品家族只有一側帶明確 identity-bearing version 時，阻止 v1 MATCH 寫入錯誤結單日；新增 Field Test 診斷與 PLAMATEA 一般版／Black Barrel 回歸 | `build:next`、v1/v2/Shadow/Query/Pilot、44-case evaluation、core、Sandbox guard／architecture、Next raw integrity 全通過；Production Supabase request 0；等待人工驗收 | 否 | 既有 44-case fixture 與唯讀 PLAMATEA regression；Next／Production DB 皆無批次修改 | 無 | 無 | **是：Implementation Passed / Awaiting Manual Acceptance；尚未 Accepted** |
| 2026-08-19 23:41 | Next | `checkpoint-20260819-2341-before-parser-v21-subject-rewrite` | `582014893e0b8d43183eebd7288d43402649d773` | Parser v2.1 Subject Extraction Rewrite 前乾淨點；凍結 Matching v2、Supplier、Query 與 closing-date 行為 | 建立前 `git status` clean；既有 Version Safety Veto 與測試證據完整保留 | 否 | 無新增 Snapshot／DB 操作 | 無 | 無 | **是：Parser v2.1 Shadow Foundation 實作前回復點** |
| 2026-08-19 23:52 | Next | `checkpoint-20260819-2352-parser-v21-subject-rewrite-awaiting-manual` | `c979ccc5449dd87343e2eecbdbd1c950e0e15dd3` | Parser v2.1 Subject Extraction Rewrite：移除 v2.1 generic last-token fallback，以明確 semantic evidence 解析 Subject；Next-only Shadow，不參與 Matching／Query／Supplier／deadline／write | `build:next`、v1/v2/v2.1/Shadow/Query/Pilot、44-case evaluation、core、Sandbox guard／architecture、Next raw integrity、diff check 全通過；Production Supabase request 0 | 否 | 固定 44-case fixture 與五組 Subject Golden；Next raw collection hash 與 orphan counts 一致 | 無 | 無 | **是：Implementation Passed / Awaiting Manual Acceptance；尚未 Accepted** |

## Closing Date Resolution Workbench Domain Foundation（2026-08-21）

| 台灣日期時間 | 環境 | Tag | Commit Hash | 建立原因／當時功能 | Build／Test | 曾部署 Production | JSON Snapshot | Database Dump | Storage Backup | 是否建議 Restore Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-21 06:58（Tag 名稱為 0657） | Next-only development | `checkpoint-20260821-0657-closing-date-domain-foundation-awaiting-storage` | `1d7bc27b194f7c645543ae95ed44585cd642ebf3` | 從 recovery 基準 `a5bd05a` 建立獨立 Domain Foundation；新增 Verified Mapping、Resolution Batch／Result、Top 3、Job state、Apply audit／conflict／rollback、supplier-scoped source identity、rule／snapshot／idempotency 純 TypeScript contracts；未接 UI、Provider、DB 或 API runtime | `build:next`、專用 offline contract、v1/v2/v2.1/Shadow/Pilot/Query、44-case evaluation、core、Sandbox guard／architecture、Next raw integrity、`git diff --check` 全通過；Production Supabase request 0 | 否 | 無新增；Next integrity 僅使用既有 `workbench-backup-2026-08-15.json` 隔離驗證 | 無 | 無 | **是：Domain Foundation 回復點；Storage Integration Not Started，非 Production Ready** |

## Closing Date Resolution Workbench Sidecar Storage（2026-08-21）

| 台灣日期時間 | 環境 | Tag | Commit Hash | 建立原因／當時功能 | Build／Test | 曾部署 Production | JSON Snapshot | Database Dump | Storage Backup | 是否建議 Restore Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-21 07:28:39 | Next-only development | `checkpoint-20260821-0728-closing-date-sidecar-storage-awaiting-batch-gateway` | `326a3d853aa6b7d1ce4d16c0956711f9caa77fb9` | Migration 2：新增獨立 `daigou-erp-closing-date-sidecar-next-v1` v1 與六個初始空集合、repository／adapter、supplier-scoped Mapping、Resolution／Candidate round-trip、Apply audit-only plan、idempotency 與 atomic rollback；feature flag 預設關閉，未接 UI、Provider、Catalog、closing_date apply 或 Production | `build:next`、TypeScript、sidecar atomic/fault-injection、Domain、core、Sandbox guard／architecture、Snapshot Import、Next↔Experimental parity、44-case Closing Date、Next nightly integrity、`git diff --check` 全通過；559 Groups／2438 Variants、collection hashes、Golden VSPO、orphan counts 不變；Production Supabase request 0 | 否 | 無格式升級；僅以既有 `workbench-backup-2026-08-15.json` 做隔離 readback／parity 驗證 | 無 | 無 | **是：Sidecar Storage 自動測試完成回復點；Batch Gateway Not Started，非 Production Ready** |

## Closing Date Resolution Workbench Batch Gateway / UI（2026-08-21）

| 台灣日期時間 | 環境 | Tag | Commit Hash | 建立原因／當時功能 | Build／Test | 曾部署 Production | JSON Snapshot | Database Dump | Storage Backup | 是否建議 Restore Point |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-21 08:06:32 | Next-only development | `checkpoint-20260821-0806-closing-date-batch-gateway-awaiting-workbench-ui` | `1d796057a993c5781abac765b85e351705e8d46d` | Migration 3：Next-only read-only Batch Gateway；Batch Job＋polling、Catalog snapshot/cache、query dedupe、single-flight、limited concurrency、cancel/retry；結果僅寫 Sidecar，尚未接 Workbench UI 或 closing_date apply | `build:next`、Gateway／Domain／Sidecar、core、Sandbox guard／architecture、Next integrity、10／50／100 cold/warm performance 與 diff check 通過；warm upstream 0；Production Supabase request 0 | 否 | 既有 `workbench-backup-2026-08-15.json` 僅供 Next integrity；無格式變更 | 無 | 無 | **是：Migration 4 的乾淨基準；Workbench UI Not Started** |
| 2026-08-21 08:14（本地建立紀錄；lightweight tag 無 tagger timestamp） | Next-only development | `checkpoint-20260821-0814-before-closing-date-workbench-ui` | `1d796057a993c5781abac765b85e351705e8d46d` | Migration 4 實作前 checkpoint；內容與 08:06 Batch Gateway 基準相同，未加入 UI、apply 或其他功能 | 起始 branch／worktree clean；沿用 Migration 3 全部通過證據 | 否 | 同上 | 無 | 無 | 是：Migration 4 實作前回復點；Tag 本身為 lightweight，後續 checkpoint 已改回 annotated |
| 2026-08-21 09:01 | Next-only development | `checkpoint-20260821-0901-closing-date-workbench-ui-awaiting-manual` | `ddbfed40957595d619516e50dcb80bb2d08a5346` | Migration 4：PurchaseRecords lazy-loaded Workbench、Batch progress、GREEN／YELLOW／RED Review、Top 3、選擇並記住、completed review reload、cancel/retry、interrupted runner recovery 與 Next-only atomic closing_date apply；未接 Cloud／Production | `build:next`、Domain／Sidecar／Gateway／Workbench、core、Sandbox guard／architecture、Next integrity、atomic conflict/rollback、10／50／100 deterministic benchmark 與真正 4192 Browser field test通過；Console 0；Production Supabase request 0。詳見 `docs/closing-date-workbench-migration4.md` | 否 | 無格式升級；Main collection hashes／Golden VSPO／orphans 不變；4192 僅新增 Sidecar Batch 與一筆人工確認 Mapping，未執行 final apply | 無 | 無 | **是：Closing Date Workbench UI Implemented + Automated Tested / Awaiting Manual Acceptance；不是 Production Ready** |
| 2026-08-21 10:19 | Next-only development | `checkpoint-20260821-1019-closing-date-candidate-retrieval-v2-awaiting-manual` | `5e70bff` | Workbench Candidate Retrieval v2：Catalog native `limit=5`、最多四個高資訊 query、progressive Top 3 stop、supplier-scoped dedupe、native rank/query evidence 與低分不按 UUID 重排；Parser／threshold／ambiguity／Wanrong priority 不變 | `build:next`、Candidate Retrieval、10／50／100 cold/warm、Domain／Sidecar／Gateway／Workbench、44-case、core、Sandbox guard／architecture、Next integrity、diff check 通過；公開 Catalog 最終 live gate 因 upstream `/api/search` HTTP 500 待人工前重測；Production Supabase request 0 | 否 | 無 Snapshot 格式或 Schema 變更；559 Groups／2438 Variants／Golden VSPO／orphan baselines 不變 | 無 | 無 | **是：Candidate Retrieval v2 Awaiting Manual Acceptance；不是 Production Ready** |
| 2026-08-22 11:06 | Next-only development | `checkpoint-20260822-1106-closing-date-candidate-retrieval-v2-runtime-awaiting-manual` | `0807d1390e67ecc07a82e65453bd8ef39ca943dd` | Candidate Retrieval v2 runtime refinement：用 v2.1 metadata 做 conflict-only safety filter、只以可靠候選觸發 progressive stop、保留 Native Rank／Query／JAN／Model Code evidence；4192 透過隔離 Catalog Hotfix Preview 驗證露易絲／索菲亞／Omaneko／SMP，不修改 Parser、threshold、ambiguity、Wanrong Priority 或 Production | `build:next`、Candidate Retrieval fixture/live、Batch Gateway、Workbench、core、Sandbox guard／architecture、Next nightly integrity、10／50／100 fixture cold/warm、diff check 全通過；559 Groups／2438 Variants、Golden VSPO、orphans、Production IndexedDB 不變；Production Supabase request 0 | 否 | 無 Snapshot／Schema 變更；Analysis 僅寫既有 Next Sidecar，ProductGroup write 0 | 無 | 無 | **是：真正 4192 Runtime Tested／Awaiting Manual Acceptance；不是 Production Ready** |
