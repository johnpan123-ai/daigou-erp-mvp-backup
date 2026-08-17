# Next Read Failure Matrix — 2026-08-18

範圍：`codex/next-sandbox`，只做唯讀盤點；本輪沒有修改 Provider、`db.ts` 或業務資料。

## 分級定義

- **A 安全 fallback**：讀取失敗不會把結果送進任何寫入、同步、刪除或重算流程。
- **B UI 誤導**：畫面可能顯示空資料／舊資料，但目前證據不足以證明會造成資料寫入。
- **C 高風險 write-adjacent**：讀取失敗被轉成空集合／fallback，後續同一頁存在 save、sync、delete 或可操作流程。
- **D P0 已證明**：已能重現讀取失敗導致 destructive write、identity replacement 或關聯破壞。

## 目前 Matrix

| 分類 | 位置／讀取集合 | 失敗處理 | 後續可達操作 | 判定 | 證據／備註 |
| --- | --- | --- | --- | --- | --- |
| D（已止血） | `src/lib/db.ts` `syncProductGroupsWithInventory()` → Variant source | 舊路徑曾把 Variant read failure 變成 `[]`；P0-G 已加入 strict readonly probe、Read Failure／Verified Empty 分流與 sanity gate | Inventory XLS／sync 後可能 save Variants | **D historical / guard now active** | `c08fe2e` 為 historical first bad；`b50a0a4` production-like fault injection 已證明現在 failure 會 0 write |
| C | `src/pages/Purchasing.tsx:309-317`；groups、variants、categories、private orders/items、inventory、batch items、sales items、batches | 多個 promise `.catch(() => [])`，state 仍被設定為空陣列 | 同頁有採購批次、私下登記與編輯流程 | **C** | 讀取失敗可能讓使用者以為沒有需求／採購；尚未在本輪自動寫入正式資料 |
| C | `src/pages/JapanPackageDetail.tsx:477-482`；groups、variants、categories、batches、batch items、bundle components | `.catch(() => [])` 將必要來源轉為空集合 | 有直接新增、匯入、編輯與 package item save | **C** | 套組／批次 resolver 可能不完整；應在下一個獨立 stage 加 Error state 與 write gate |
| C | `src/pages/PurchaseManagement.tsx:1139`；bundle components | bundle component read failure → `[]` | 套組設定與儲存流程在同頁 | **C** | UI 可能顯示沒有套組內容，接著操作會基於不完整讀取結果 |
| B | `src/pages/PurchaseRecords.tsx` fresh-load effect（約 1200 行附近） | fresh load rejection 沒有統一 effect-level Error state | 主要是列表編輯／導覽；目前未找到同一 rejection 直接進 destructive save 的證據 | **B** | 可能保留舊畫面或 loading 狀態，不能把 Error 當 Empty；需補 retry／stale badge |
| C | `src/lib/db.ts:2195-2240` IndexedDB generic `get()` | request/open failure fallback 到 localStorage 或 default value；localStorage migration 另起非同步 `set()` | 所有 IndexedDB adapter read、後續 save／sync／delete | **C** | 這是跨頁共用高風險邊界；P0-G 只覆蓋 Variant destructive sync，未涵蓋所有集合 |
| C | `src/providers/cloud/supabaseProvider.ts:587-614` pull timeout／pull error fallback，以及 `:2246` sync 後 `getProductVariants({ recalc: true })` | timeout 後標記 pulled 並使用 local cache；後續 Variant read 仍走一般 fallback | Cloud sync／push 後可能把不完整 Variant 結果送入後續處理 | **C** | 尚未在 Production 觸發；需 Production-like fault harness，不可用正式資料測試 |
| B | `src/pages/Dashboard_backup.tsx:28-34` | legacy route `.catch(() => [])` | 非目前 active route | **B/P2** | 目前只影響 legacy/backup 顯示；應標記 legacy，避免未來被重新接回主流程 |
| A | `src/pages/NextRawDbIntegrityProbe.tsx:26,38-53` | catch 後明確 `setError`，finally 結束 loading | 只讀診斷 | **A** | Error 與 Empty 分離，沒有 save path |
| A | `src/components/ErrorBoundary.tsx:59,67` | crash log／localStorage parse failure 被忽略或回空陣列 | 只影響診斷 log | **A/P2** | 不參與 ERP 集合或業務寫入 |
| A | `src/pages/UnlistedItems.tsx:246-248,373-392` | load／copy failure 有 console/error 或 alert；不以成功覆蓋失敗 | 未列入本輪核心 sync | **A/P2** | 需後續統一 toast，但沒有目前 destructive chain 證據 |

## 目前已確認的安全邊界

1. P0-G strict probe 直接使用 IndexedDB readonly transaction；Variant source 不能被一般 `get()` 的空值 fallback 取代。
2. Production-like Hotfix `b50a0a4` 正常同步後 Variant IDs、VSPO WACA／已採購、orphan counts 不變。
3. 同一 Hotfix 注入 Variant read failure 時，錯誤碼為 `VARIANT_DESTRUCTIVE_SYNC_GUARD`，錯誤訊息為「商品規格資料讀取失敗，為保護既有採購關聯，本次同步已取消。」；raw DB checksum 不變。
4. 本輪沒有在 Production 觸發 fault injection，也沒有修改 Production。

## 下一個最小安全順序

1. 先把 `JapanPackageDetail`、`PurchaseManagement` 的必要集合讀取改成 typed load error／停用相依寫入（另開 stage）。
2. 再處理 `Purchasing` 的空集合 fallback，保留既有資料與明確 Error state。
3. 最後才審查 generic `db.ts` fallback 與 Cloud post-sync；這兩項需要 Production-like fault injection 與人工驗收，不宜用局部 UI 修補。

本文件只記錄風險，不代表任何項目已修正或已達 Production Ready。
