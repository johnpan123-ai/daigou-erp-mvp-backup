# ERP Release Candidate Blocker Matrix

| Blocker | Status | Evidence | Action before Production |
|---|---|---|---|
| F3 Japan Package A1/A2/B atomic transaction | NEEDS STAGING APPLY | 031 static SQL, provider/UI/model regression；PostgreSQL 尚未 apply | 核對固定 031 hash，套用 Staging，跑 postflight 與人工 C |
| F4 Outbound delete header/items partial commit | NEEDS STAGING APPLY | 032 atomic delete、exact child scope、CAS/idempotency、two-store cache tests | 核對固定 032 hash，依 031 後套用 Staging，跑 postflight 與人工 D |
| F4 create/items/status single-table mutations | NEEDS HUMAN ACCEPTANCE | 既有 field-CAS；RC sweep 確認無 inventory/order/member 隱藏寫入 | 依人工 D 正向流程驗收；禁止桌面狀態列跳步 |
| F5 Draft preservation / stale CAS / final convergence | NEEDS HUMAN ACCEPTANCE | `cloud-multi-user-sync`、`cloud-realtime-draft-catchup` PASS | 用兩個獨立登入 session 完成人工 E |
| Group/Category/Variant cross-table create/sync | BACKLOG / NON-BLOCKING | 新 Catalog 可保持未加入；既有 Group/Variant 可完成採購；單表 Variant/Group CAS 可用 | 初期禁止 Cloud 跨表自動同步、批次建立/重掛；需要時另做 server transaction |
| Restore/backup portability and audit-null policy | RESOLVED | 023–030 contracts、portable candidate/hash/idempotency/fail-closed regressions | Production 前固定 source/candidate hash；不得重用不同 policy/target intent |
| Post-Restore same-page convergence Live | NEEDS HUMAN ACCEPTANCE | code/offline accepted；既有 Live Restore 後曾需 F5，修正版未用新 Restore 重驗 | 下次有必要且另授權的 Staging Restore 順便驗證；不得為補證據重跑 |
| Production freeze / dual-write prevention / cutover | NEEDS HUMAN ACCEPTANCE | `production-cutover-runbook-candidate.md` | 由營運者盤點所有 writer、執行 freeze、簽核第一筆寫入與 rollback point |
| RecentPurchases date locator timeout | BACKLOG / NON-BLOCKING | 已有 parent baseline，與 RC runtime diff 無直接因果 | 修 fixture/date locator，不阻擋 RC |
| `erp_healthcheck` missing | BACKLOG / NON-BLOCKING | Legacy POC，不參與 Auth/fresh/read/write guard | 不新增 RPC；移除/隔離 POC 另案處理 |
| `product_variants` 3150/3000 advisory | BACKLOG / NON-BLOCKING | advisory，未證明 query truncation 或業務失敗 | 監控容量與 pagination，出現直接因果再升級 |

## Group/Category/Variant initial-production restriction

初期可：匯入未加入 Catalog Inventory、使用既有 Group/Variant 採購、對單一既有 Group 或 Variant 做既有 CAS 欄位更新。初期不可：在 Cloud 以一次使用者操作跨表新建 Group+Category+Variant、把未加入 Inventory 自動併入 Group、或執行 `syncProductGroupsWithInventory()`。UI guard 必須保留；任何需要跨表同步的操作應停止並另案授權，不能以多次 client write 代替 transaction。
