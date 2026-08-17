# P0-G Production Hotfix Acceptance Report

日期：2026-08-18（Asia/Taipei）  
狀態：**Implementation Passed / Awaiting Manual Acceptance**  
Production：0 write；Push：NO；Deploy：NO

## Scope

- Production-like code base：`b50a0a4`。
- Production reference：`c3756cd55e90658546a1936c6549411c540351f3`。
- Hotfix diff：只包含 Variant destructive-sync runtime guard；沒有 Test Owner、Test DB、Snapshot UI、故障注入 UI 或其他 Next feature。
- Test database：Production-like local IndexedDB `daigou-erp-db`，每個案例由固定 Snapshot 重新 seed。
- Snapshot：`C:\Users\小河馬\Downloads\workbench-backup-2026-08-15.json`。

## Normal flow

流程：固定 Snapshot seed → `upsertInventory()`（對應 Inventory 匯入後的資料寫入）→ `syncProductGroupsWithInventory()` → F5 → raw IndexedDB read。

| 項目 | 結果 |
| --- | --- |
| Product Variants | 2438 → 2438 |
| Variant IDs | 完全一致 |
| VSPO WACA | `4 / 3 / 0 / 0 / 2`，不變 |
| VSPO 已採購 | `9 / 19 / 0 / 2 / 13`，不變 |
| PurchaseBatchItem → Variant orphan | 145 → 145 |
| PrivateOrderItem → Variant orphan | 17 → 17 |
| Bundle parent／child Variant orphan | 32 / 34 → 32 / 34 |
| JapanPackageItem → Variant orphan | 41 → 41 |
| OutboundItem → Group / PackageItem orphan | 35 / 1 → 35 / 1 |
| Supabase requests | 0 |

## Variant read-failure flow

以 Test-only browser fault injection 讓 `erp_product_variants` IndexedDB read 失敗，再呼叫同一個 sync entry point。

- Sync rejected：是。
- Error code：`VARIANT_DESTRUCTIVE_SYNC_GUARD`。
- Error：`商品規格資料讀取失敗，為保護既有採購關聯，本次同步已取消。`
- Variant count／IDs：不變。
- WACA／已採購：不變。
- Orphans：不變。
- Raw IndexedDB checksum：不變。
- Supabase requests：0。

## Automated evidence

`npm run test:p0-g-hotfix-productionlike` 通過。這只證明 Production-like 自動驗證完成；依 SOP，在使用者逐步操作正常流程與故障注入前，本 Stage 不標記 Accepted。

## Manual acceptance SOP

1. 啟動 `b50a0a4` Production-like worktree，確認不是 `codex/test-sandbox`、Experimental 或 Production。
2. 使用固定 Snapshot 建立全新 local DB，確認 2438 Variants 與五筆 VSPO Golden。
3. 進 `/inventory`，執行一次固定的 Inventory XLS 流程，完成 sync，F5 後確認 IDs、WACA、已採購與批次商品名稱。
4. 在同一 Production-like 本機啟用 Variant Read Failure fault injection，再執行 sync。
5. 確認顯示上述錯誤，F5 後資料仍完整；raw counts、IDs、orphan 與 Golden 不變。
6. 結束後清除 Production-like local DB；不連 Production、不執行 Cloud write。

## Rollback

回到 `checkpoint-20260818-0449-next-extended-start` 可回到本輪前 Next 文件／測試狀態；Production hotfix 本身的既有回復點為 `checkpoint-20260818-0021-p0-g-production-hotfix-awaiting-manual-acceptance`。本報告不授權 cherry-pick、Push 或部署。
