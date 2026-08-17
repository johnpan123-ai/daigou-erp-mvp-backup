# P0-G/H Phase 2：Next Raw DB Integrity Probe

建立時間：2026-08-17（Asia/Taipei）  
範圍：Next Sandbox 唯讀診斷；Production 0 write；未修復任何資料。

## 安全邊界

- 診斷頁只允許 `erp_provider_mode=next`。
- 直接開啟 `daigou-erp-db-next-v1`。
- IndexedDB transaction 固定為 `readonly`。
- 不經 `dataProvider`、LocalProvider、ViewModel、dedupe／merge 或 Supabase。
- 隔離重現使用全新 headless browser profile；不修改使用者目前的 Next DB。

## 目前持久化 Next raw DB

來源對照：`workbench-backup-2026-08-15.json`。

| 集合 | JSON | Next raw | SHA-256 |
|---|---:|---:|---|
| Product Groups | 559 | 569 | 不同 |
| Product Variants | 2438 | 2485 | 不同 |
| Purchase Batches | 467 | 484 | 不同 |
| Purchase Batch Items | 1407 | 1458 | 不同 |
| Private Order Items | 120 | 122 | 不同 |
| Bundle Components | 284 | 292 | 不同 |
| Japan Package Items | 225 | 247 | 不同 |
| Outbound Shipment Items | 210 | 210 | **一致** |

目前 DB 沒有 `erp_test_snapshot_metadata`。因此它無法證明是由 8/15 JSON 經 Test-only Snapshot importer 建立；至少後續曾由不記錄 Snapshot metadata 的流程取代／改寫。

## 5 筆 VSPO raw 對照

| Product Group | JSON WACA／已採購 | Next raw WACA／已採購 | Variant 狀態 |
|---|---:|---:|---|
| 猫汰つな | 4／9 | 0／0 | JSON 7 IDs；raw 6 個全新 IDs |
| 空澄セナ | 0／0 | 0／0 | JSON 5 IDs；raw 5 個全新 IDs |
| 八雲べに | 3／19 | 0／0 | JSON 9 IDs；raw 8 個全新 IDs |
| 小雀とと | 0／2 | 0／0 | JSON 16 IDs；raw 16 個全新 IDs |
| 一ノ瀬うるは | 2／13 | 0／0 | JSON 8 IDs；raw 7 個全新 IDs |

五組原始 batch／batch item IDs 仍存在，但所有 `purchase_batch_items.product_variant_id` 仍指向 JSON 的舊 Variant IDs。raw `product_variants` 已換成另一組 UUID，因此 UI 顯示「未知商品」、WACA 0、已採購 0 是 raw 資料的直接結果，不是 UI 單獨算錯。

八雲べに可辨識的 row fingerprint：

- JSON Variant 有 `created_at`／`updated_at`／`waca_manual_adjustment`，並含無 SKU 的「複製簽」。
- Next raw Variant 只有 catalog 衍生欄位，沒有上述手動／時間欄位；無 SKU 的 Variant 消失。
- Next raw row 欄位形狀與 `IndexedDbAdapter.syncProductGroupsWithInventory()` 的 `newVariant` 完全一致：新 UUID、SKU／title／variant_name、auto quantity、sort order、`catalog_missing=false`；其後 `getProductVariants({ recalc: true })` 補上 `waca_auto_quantity=0`。

## Referential Integrity

| Relation | JSON orphan | Next raw orphan | 判定 |
|---|---:|---:|---|
| BatchItem → Batch | 3 | 3 | 未增加 |
| BatchItem → Variant | 145 | **1458** | **增加；目前全部 batch items 都失聯** |
| Batch → Group | 25 | 25 | 未增加 |
| Variant → Group | 0 | 0 | 未增加 |
| PrivateOrderItem → Variant | 17 | **122** | **增加；目前全部 private items 都失聯** |
| Bundle → bundle Variant | 32 | **292** | **增加** |
| Bundle → component Variant | 34 | **292** | **增加** |
| JapanPackageItem → Variant | 41 | **213** | **增加** |
| OutboundItem → Group | 35 | 35 | 未增加 |
| OutboundItem → PackageItem | 1 | 1 | 未增加 |

這個分布只破壞 Variant identity；Group、Batch、Outbound group/package 關聯維持來源狀態。

## 隔離暫存 DB 重現

專用測試：`npm run test:p0-gh-next-raw-integrity`

流程：同一份 JSON → `prepareTestSnapshotFile()` → `importTestSnapshot()` → raw readonly read → F5 → raw readonly read。

結果：

- 8 個 probe 集合筆數全部與 JSON 相同。
- 8 個集合 SHA-256 立即讀回全部相同。
- F5 後 8 個集合 SHA-256 仍全部相同。
- 5 筆 VSPO WACA／已採購分別為 4/9、0/0、3/19、0/2、2/13。
- Import 後 orphan 沒有比來源增加。
- Production Supabase request = 0。

因此 `writeSnapshotAtomically()` 的 raw object `store.put(candidate.data[field], key)` 沒有改 ID、漏 WACA 或做 dedupe；目前 importer 與 App reload 均不是破壞點。

## 四個核心答案

1. **JSON → 目前持久化 Next raw DB：不一致。** 但同 JSON → 全新隔離 DB 經目前 importer：完全一致。
2. **目前 Next raw DB → Next UI：一致。** UI 的 0／未知商品正確反映 raw Variant IDs 已被替換、batch item FK 仍是舊 ID。
3. **Import 後 orphan 是否增加：目前 importer 的隔離重現不增加；目前持久化 Next DB 已大量增加。**
4. **第一個破壞階段：目前 Next DB 的 Variant catalog 重建階段。** row fingerprint 指向 `IndexedDbAdapter.syncProductGroupsWithInventory()` 建立 `newVariant`，之後 recalculation 寫回；它在歷史 purchase/private/bundle/package 關聯仍指向舊 Variant IDs 時建立新 UUID。因沒有 operation audit／Snapshot metadata，無法從現有 DB 反推是哪一次 UI 操作觸發，但已排除 Snapshot importer、F5 read 與 PurchaseRecords ViewModel。

## 建議最小修正方案（尚未實作）

1. Next 的 catalog 同步在遇到「既有歷史資料引用不存在 Variant」時 fail-closed，不得靜默建立整批新 UUID 後繼續。
2. `syncProductGroupsWithInventory()` 寫入前增加 referential-integrity preflight；若 orphan 將增加，整次操作中止並顯示錯誤。
3. Next 只允許 Test-only Snapshot importer 建立基準，並保留 metadata；一般 restore／XLS 流程不得冒充 Snapshot parity。
4. 新增 Production Business Parity gate：來源 JSON business totals + referential counts 必須等於 import 後 raw DB，再驗 UI。
5. 目前 Next DB 的復原應先另存唯讀報告，再由使用者批准後 atomic 重匯已驗證 JSON；本階段不執行。

