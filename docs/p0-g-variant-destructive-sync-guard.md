# P0-G：Variant Destructive Sync Guard

狀態：**Implementation Passed / Awaiting Manual Acceptance**

適用環境：Next Sandbox、Experimental Sandbox。Production 未修改、未部署、未執行同步測試。

## 根因與止血範圍

Historical First Bad Commit `c08fe2eac25491e771e0378d71ef93d2c67cbeca` 的危險鏈為：

1. Variant 讀取失敗被一般 `get(..., [])` 降級為空陣列。
2. `syncProductGroupsWithInventory()` 將空陣列視為「系統真的沒有 Variant」。
3. 依 Inventory 全量建立新 UUID。
4. 原 Variant ID、WACA manual adjustment 與 Purchase／Private／Bundle／Japan Package FK 不再能解析。

本階段只做 fail-closed 防護：不重寫同步、不修舊 orphan、不補 WACA、不猜 FK。

## 實作保證

- 同步前使用單一 IndexedDB `readonly` transaction 嚴格讀取 Variant 與 Variant 關聯集合。
- 讀取 request／transaction 失敗、型別錯誤或來源無法確認時，拋出 `VARIANT_DESTRUCTIVE_SYNC_GUARD`。
- Variant 為 0 但存在任何 Variant FK 時，視為異常並中止。
- 只有 DB 完全沒有 Product Group／Variant FK，或明確存在 `erp_product_variants: []` 且仍是最多 10 個 Group、0 Variant FK 的小型初始化狀態，才算 `Verified Empty`；大量既有 Group 配上 0 Variant 一律中止。
- 寫入前比對候選結果：既有 ID 不得消失、manual adjustment 不得改變。
- 非空基準若單次預計新增至少 `max(50, baseline × 25%)`，視為大量重建並中止。
- guard 完成前不執行 Product Category／Variant write。
- 統一顯示：`商品規格資料讀取失敗，為保護既有採購關聯，本次同步已取消。`

## 自動測試

命令：

```text
npm run test:p0-g-variant-sync-guard
```

Next 與 Experimental 各自使用全新 browser context／獨立 DB，固定驗證：

- 正常組：2438 Variants；同步後 ID、WACA／manual adjustment、orphan baseline 不變。
- 故障組：強制 Variant strict read failure；整個 IndexedDB snapshot 前後完全相同。
- Verified Empty 組：明確空 Variant 的全新 DB 可以合法建立第一筆 Variant。
- Production Supabase request = 0。

固定 Snapshot orphan baseline：

- BatchItem → Variant：145
- PrivateOrderItem → Variant：17
- Bundle parent／child → Variant：32／34
- JapanPackageItem → Variant：41

這些是來源 JSON 已存在的歷史 orphan；本修正的 Gate 是「不得增加」，不是自動修復。

## 人工驗收 SOP

### 驗收前準備

1. 只啟動 Next：`npm run dev:next`。
2. 在 Settings 將 `workbench-backup-2026-08-15.json` 匯入 Next Sandbox。
3. 等自動 reload 完成。
4. 記錄 Test DB 基準：Variants 2438；BatchItem／Private／Bundle／Japan orphan 分別為 145／17／32、34／41。
5. 在 PurchaseRecords 記錄固定五筆 VSPO 的 WACA `4 / 3 / 0 / 0 / 2`、已採購 `9 / 19 / 0 / 2 / 13`，並記錄 Variant ID。

### 成功案例：正常同步

1. 進入 `/inventory?p0GGuardAcceptance=1`。
2. 點「執行 P0-G 正常同步驗證」。
3. 正常結果：顯示「正常同步完成」，不得出現 guard 錯誤。
4. F5。
5. 回 PurchaseRecords 驗證五筆 VSPO 的 WACA、已採購、Variant ID 與批次商品名稱不變。
6. Test DB 仍為 2438 Variants；既有 orphan 數不得增加。
7. Product Groups、Purchase Batches／Items、Private Orders／Items、Bundle、Japan Package、Outbound 筆數不得改變。

### 失敗案例：Variant read failure

1. 進入 `/inventory?p0GGuardAcceptance=1&simulateVariantReadFailure=1`。
2. 點「執行 P0-G 規格讀取故障注入」。
3. 必須看到：`商品規格資料讀取失敗，為保護既有採購關聯，本次同步已取消。`
4. 不得看到同步成功訊息。
5. F5 後重新檢查：Variants 2438 → 2438；orphan 145／17／32、34／41 完全不變。
6. 五筆 VSPO 的 WACA、已採購與 Variant ID 必須不變；採購批次仍顯示商品名稱。
7. Test DB 完整 checksum 必須與故障注入前相同；Production Supabase request 必須為 0。

### Verified Empty 案例

此案例由專用自動測試建立全新 DB，避免人工誤清目前 Snapshot。若要人工驗收，必須使用新的 browser profile／隔離 origin：

1. 建立一個 Product Group、一個匹配 Inventory SKU，並明確保存 `erp_product_variants: []`。
2. 執行正常同步。
3. 應只建立 1 筆 Variant，且連到該 Group；不得觸發 guard。
4. F5 後仍為 1 筆，不得重複建立。

### 清理／回退

- 人工故障注入本身為 0 write，不需刪資料。
- 如測試資料需要恢復，重新匯入 `workbench-backup-2026-08-15.json`。
- 程式回退：checkout/tag `checkpoint-20260817-2326-before-p0-g-variant-destructive-sync-guard`。

## 驗收狀態規則

在操作者完成正常同步、F5、故障注入、F5 與 DB／業務數字比對前，不得標記 Accepted。
