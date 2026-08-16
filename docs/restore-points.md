# ERP Restore Point Index

最後更新：2026-08-16 21:31（Asia/Taipei，UTC+8）

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
