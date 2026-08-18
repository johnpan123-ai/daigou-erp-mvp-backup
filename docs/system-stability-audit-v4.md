# System Stability Audit v4 — Next Sandbox

建立時間：2026-08-19（Asia/Taipei）  
範圍：`codex/next-sandbox`，固定 Snapshot 的隔離 origin 與 4192 唯讀巡覽。

## Resolved / verified

- Next/Test Sandbox network guard：Production Supabase REST/Auth/RPC/Storage/Functions/XHR/beacon/WebSocket/client path fail-closed；本輪 request = 0。
- Test Owner/Auth isolation：不讀正式 session/profile；Auth request = 0。
- Snapshot importer atomicity：格式驗證、單一 transaction、rollback、readback/hash 通過。
- P0-G Variant read failure guard：failure 不會變成 `[]`，sync 0 write；Production-like fixture checksum/orphan 不變。
- Bootstrap error boundary：Test-only fault injection 顯示 recovery screen，不白畫面。
- Outbound checked queue：既有 serial queue regression 通過；本輪唯讀資料沒有變動。
- Recent Purchases、bundle display、outbound cost export、freight helper 的既有 targeted tests 通過。

## Still open — P0 / Design Gate

- P0-C：purchase batch + items 仍需資料層 atomic operation。
- P0-D：Inventory XLS 與 ProductGroup/Variant sync 仍跨集合分開寫入。
- P0-E：Outbound shipment + items delete 仍非 atomic。
- Cloud JSON restore 仍停用；真正 server-side atomic restore 尚未做。

## P1 — data correctness / state

- Purchasing/JapanPackageDetail/PurchaseManagement 的 read failure fallback to `[]`／`{}` 仍可能將讀取失敗誤導成空資料，且部分路徑仍可進入後續操作。
- Full-array saves、optimistic UI、multi-collection sequential saves 缺少一致的 serialization/stale guard。
- Outbound header/status save 的 rollback/error UI 不如 checked queue 完整。
- Purchase Management unit-price fix 已實作但未人工 Accepted；4192 live menu 的 `新增規格` visibility 與 isolated test 結果不一致，需 fresh-origin reproduction。
- Catalog Product Identity v1／Supplier Selection 未包含在目前 Next branch；Product Type、Character、Size、Wanrong priority 仍需獨立整合與 Golden regression。

## P1 — error handling / lifecycle

- Settings delayed signOut timer 缺少明確 cleanup。
- PurchaseBatchModal long-press timer/interval 在快速卸載時需再確認 cleanup。
- 部分 error 只有 console，未能在 UI 明確區分 Loading／Empty／Error。
- per-batch clipboard Playwright timeout 需獨立釐清，不能以測試 timeout 判定資料錯誤。

## P2 / UX / maintenance

- `Dashboard_backup.tsx` dead tree 含 fallback-to-empty，應與 active source 分離或移除掃描範圍。
- lint baseline 580 errors/47 warnings，未在本輪清理。
- Search ×100 與 Dashboard initial route 有可觀察成本；memory trend 需在可 forced-GC 的環境再判斷。
- Settings 文案仍使用泛稱「瀏覽器本地端」，Next 實際資料由獨立 IndexedDB/namespace 路由；目前不影響隔離，但可改善說明。

## Evidence

- `npm run build:next`、core、sandbox guard/architecture、Test Owner、read-failure、snapshot/atomic import、backup gate、restore gate、bootstrap、P0-G、recent purchases、freight、outbound export：PASS。
- readonly soak：10 rounds / 60 routes / 10 reloads，checksum unchanged，Console/Warning/Page Error 0。
- performance soak：100 route cycles / 30 reloads，Console/Page Error 0，Production Supabase request 0。
- `npm run lint`：baseline failure；本輪沒有修改以掩蓋該結果。
