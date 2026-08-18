# Next Functional Exploration Baseline

建立時間：2026-08-19 00:40–00:41（Asia/Taipei）  
環境：Next Sandbox；診斷資料庫 `daigou-erp-db-next-v1`  ���
程式基準：`f6f7f32994b2261ccd4d0b0a82e16c418e20accb`  
Checkpoint Tag：`checkpoint-20260819-0041-next-before-functional-exploration`  
Snapshot：`C:\Users\小河馬\Downloads\workbench-backup-2026-08-15.json`

本次 baseline 使用既有 `test:next-nightly-integrity` 在獨立 `http://127.0.0.1:4245` origin 建立；不覆蓋使用者目前 4192 origin 的資料。原始 Next 工作樹在 checkpoint 前已有單價 permission fix 與 Field Test Bug 文件，均已原樣保存。

## Collection counts

| Collection | Rows |
| --- | ---: |
| inventory | 4,096 |
| productGroups | 559 |
| productCategories | 305 |
| productVariants | 2,438 |
| purchaseBatches | 467 |
| purchaseBatchItems | 1,407 |
| privateOrders | 93 |
| privateOrderItems | 120 |
| bundleComponents | 284 |
| japanPackages | 36 |
| japanPackageItems | 225 |
| outboundShipments | 9 |
| outboundShipmentItems | 210 |

`salesOrders`、`salesOrderItems`、`importBatches` 均為 0。

## Snapshot collection SHA-256

Hash 為每集合經 stable object-key ordering 後的 JSON SHA-256；Variant ID hash 為排序後 2,438 個 Variant IDs 以換行串接後的 SHA-256。

| Collection | SHA-256 |
| --- | --- |
| inventory | `9a31378c0e7d80f0080b603866549bf727256a317827f118296985c19df3ff73` |
| productGroups | `766be970ace82908742d977f15237712a797ea3f80851457692fc282f8265513` |
| productCategories | `16466acd67745a7b06dc82772d852dbbbe470f6c96a8f58503ac72619ec62307` |
| productVariants | `23028b4648f71bd5c000854af1218c3f01db9c945adab2d55fa79820e2e7535b` |
| purchaseBatches | `b393d586063c987730cd287e0d3af6f665d3adb43d7317b96d2942b4e97cf8e7` |
| purchaseBatchItems | `3693732c042041c66edd8282d52e7cf1be3a3005b0b8dccb6179d3551c192b6c` |
| privateOrders | `78a1d89c39a5a27d1e2a307c5c3c7adae7ec7e8552692f3f4a4af02fcd220c6a` |
| privateOrderItems | `78c44e174a35b7db3e4981798c1ece07940e5940da79a511fca48e4d2bbdb8f3` |
| bundleComponents | `f92874ef6ecbf76b1a138a2bfd407ce86dd7a48c7d0f37075e018c33a2a77c6d` |
| japanPackages | `37c69186c2f511df37f5e500ee4accac3b9769d848f2142c118c60d99ac96176` |
| japanPackageItems | `a8a336695208c4cabe49f7fe16f8fc0f2dbe6be0ce7a165cd8c061b1d42048e5` |
| outboundShipments | `301817515af6badbac666d82b9312f09816ebfb619281e343de5c9b6f861cadf` |
| outboundShipmentItems | `cd3799cab6771b6b2b3d8dc72b8298e46a1ef51a1fc37a0bdc79cff9e4d05887` |

Variant ID hash：`0bb113aa89c9737280f9341eab0358b0d3c697ca7fc606bd3c50d1f5186e106a`。

## Referential-integrity baseline

以下為 Snapshot 已存在的歷史 orphan；本輪 gate 是不得增加，不自動修復：

- PurchaseBatchItem → Batch：3
- PurchaseBatchItem → Variant：145
- Batch → Group：25
- PrivateOrder → Group：10
- PrivateOrderItem → Variant：17
- Bundle parent → Variant：32
- Bundle component → Variant：34
- JapanPackageItem → Variant：41
- OutboundItem → JapanPackageItem：1
- OutboundItem → Group：35

其他既有檢查關聯為 0。`test:next-nightly-integrity` 確認 import 後各集合 count/hash 與來源一致、orphan 未增加、Production IndexedDB unchanged、Production Supabase requests = 0。

## VSPO Golden Sample

固定 Golden 參考序列（依使用者指定的商品順序）：

- WACA：`4 / 3 / 0 / 0 / 2`
- 已採購：`9 / 19 / 0 / 2 / 13`

Raw probe 以固定 fixture group ID 順序輸出的實際對照為：

| Group | WACA | 已採購 |
| --- | ---: | ---: |
| `18bcdaae-52a2-47a4-9aec-6f7c9b5897cc` | 4 | 9 |
| `4a584e43-8478-47fd-ae1d-618ad37223f4` | 0 | 0 |
| `52e277f7-18c5-4694-99af-d2a6d34ddf56` | 3 | 19 |
| `549ef9a3-e106-41c8-ac51-ae9dd218c0f3` | 0 | 2 |
| `cf9ccf77-5c84-4afc-8f23-d51e7475d5ce` | 2 | 13 |

Batch item 商品名稱在 raw integrity probe 中均可由 Variant 關聯解析；本 baseline 沒有新的「未知商品」。
