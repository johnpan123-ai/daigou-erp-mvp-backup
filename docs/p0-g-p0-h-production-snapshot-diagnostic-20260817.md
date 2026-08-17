# P0-G / P0-H Production → Snapshot → Sandbox 唯讀診斷

建立時間：2026-08-17 20:44（Asia/Taipei）  
環境：Next Sandbox；Experimental Performance 工作已停止  
Production：只讀，未修改  
狀態：Diagnostic Only；未修資料、未修 UI、未 Push、未 Deploy

## 結論摘要

這次發現的是兩個不同層次的問題：

1. **P0-G：Production Business Parity 未成立。**
   Production 與 `workbench-backup-2026-08-15.json` 都有 VSPO 的 WACA 與已採購來源資料，但目前 Next UI 讀出的 WACA／已採購為 0。原有的 Sandbox-to-Sandbox parity 只比較同一份輸入在 Next 與 Experimental 的 checksum，不能證明資料能重現 Production 業務結果。
2. **P0-H：目前 Next 的採購批次明細解析已出現 referential integrity regression。**
   Production 同一批次能解析商品，Next 同一批次顯示「未知商品」。原始 2026-08-15 JSON 本身已有歷史 orphan，但 VSPO 這些被 Next 顯示為未知的明細在 JSON 中是有效 Variant 關聯，因此不能全部歸因於既有 orphan。
3. **目前不能安全宣稱 importer 已新增多少 orphan。**
   Snapshot importer 的程式碼會原樣保留 ID，不做 remap／dedupe／猜配；但目前 Next 的實際 DB 不是 2026-08-15 JSON 的筆數狀態，且目前安全瀏覽介面沒有提供完整 Next raw snapshot 下載結果。因此本輪不把 `Next orphan = 145` 當成已證實結論。

## 1. 診斷基準與版本

| 項目 | 目前紀錄 |
| --- | --- |
| Production baseline | `c3756cd55e90658546a1936c6549411c540351f3`（使用者指定的正式版本） |
| Next branch | `codex/next-sandbox` @ `99c11c0697abf131cb6b5453b18df362adb7cbd1` |
| Experimental branch | `codex/experimental-sandbox` @ `1bd7faf30b2ec1381514a63696ad61f758285c9a` |
| Legacy Test branch | `codex/test-sandbox` @ `a13721f83b763466ba19c32899f2011cfd8851c8c1`（未修改） |
| Next runtime DB | `daigou-erp-db-next-v1` |
| Source JSON | `workbench-backup-2026-08-15.json`，原始檔 7,938,588 bytes |
| Next/Experimental parity test | `tests/sandbox-snapshot-parity.mjs`；只證明同一輸入在兩個 Sandbox 相同 |

本輪未碰 Experimental worktree，也沒有把 Test／Experimental 功能帶入 Production。

## 2. P0-G：Production UI → JSON → Next DB → Next UI

### 2.1 Production PurchaseRecords 的實際來源

程式碼追蹤結果：

- **買動漫**：以既有 `ProductVariant` 數量欄位、Inventory／SalesOrder 計算結果及 manual adjustment 的既有優先順序，由 `calculateVariantDemandAndPurchased()` 產生。
- **WACA**：`waca_auto_quantity + waca_manual_adjustment`；若新欄位不存在才走舊 `waca_quantity` fallback。
- **已採購**：優先考慮 `purchased_manual_adjustment`；沒有有效 manual adjustment 時，依 `purchase_batch_items.quantity` 按 `product_variant_id` 加總，再由群組彙總。
- **缺口**：沿用既有 `calculateVariantDemandAndPurchased()` 的結果；本輪沒有重算或修改公式。
- `PurchaseRecords.tsx` 先以 `mapPurchaseBatchItemsByGroup(batches, batchItems)` 建立採購明細索引，再把結果交給上述既有計算。

### 2.2 五筆 VSPO 精確比對

Production 是以正式網站唯讀檢查；JSON 是直接讀取 `workbench-backup-2026-08-15.json`；Next UI 是在 `http://127.0.0.1:4192` 的 Next Sandbox 唯讀檢查。

| Product Group | Group ID（縮寫） | Production 買動漫／WACA／已採購 | JSON 買動漫／WACA／已採購 | Next UI 買動漫／WACA／已採購 | Next UI 缺口顯示 |
| --- | --- | ---: | ---: | ---: | ---: |
| 猫汰つな 4周年 | `18bcdaae…5897cc` | 2 / 4 / 9 | 2 / 4 / 9 | 2 / 0 / 0 | -2 |
| 空澄セナ 6周年 | `4a584e43…23f4` | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 無 |
| 八雲べに 5周年 | `52e277f7…ddf56` | 4 / 3 / 19 | 4 / 3 / 19 | 4 / 0 / 0 | -4 |
| 小雀とと 7周年 | `549ef9a3…c0f3` | 2 / 0 / 2 | 2 / 0 / 2 | 2 / 0 / 0 | 無 |
| 一ノ瀬うるは 7周年 | `cf9ccf77…d5ce` | 9 / 2 / 13 | 9 / 2 / 13 | 9 / 0 / 0 | -9 |

Production 五筆與 JSON 五筆的數字一致；差異從 Next 的讀取／顯示結果開始被觀察到。

### 2.3 JSON 中 WACA 的實際欄位

五筆 VSPO 的 JSON 都包含有效的 `product_variants`。WACA 並不是只放在 metadata 或 localStorage：

| Group | `waca_auto_quantity` 合計 | `waca_manual_adjustment` 合計 | JSON WACA |
| --- | ---: | ---: | ---: |
| 猫汰つな | 0 | 4 | 4 |
| 空澄セナ | 0 | 0 | 0 |
| 八雲べに | 0 | 3 | 3 |
| 小雀とと | 0 | 0 | 0 |
| 一ノ瀬うるは | 0 | 2 | 2 |

因此「JSON 沒有 WACA」已被排除。Importer 的 `validateBackupShape()` 與 `writeSnapshotAtomically()` 會保留 row 物件，沒有刪除 `waca_manual_adjustment` 的程式。

### 2.4 JSON 中已採購的實際來源

五筆 VSPO 的已採購數均可由 `purchase_batch_items.quantity` 按 Variant 加總得到：

| Group | JSON 有效採購批次 | `purchase_batch_items` 筆數 | quantity 合計 |
| --- | ---: | ---: | ---: |
| 猫汰つな | 2 | 7 | 9 |
| 八雲べに | 1 | 9 | 19 |
| 小雀とと | 1 | 2 | 2 |
| 一ノ瀬うるは | 1 | 8 | 13 |

空澄沒有採購批次與明細，合計 0。JSON 內的批次、明細、Variant ID 和 Group ID 對這些五筆都是有效的。

### 2.5 Next 執行期證據

Next Settings／runtime 唯讀結果：

- Sandbox DB：`daigou-erp-db-next-v1`
- raw `product_variants` read log：2485
- read-time dedupe：合併 2 筆 duplicate row，UI canonical variant count：2483
- Settings 顯示 ProductGroup 569（含 sandbox metadata／特殊資料）；PurchaseRecords 顯示 568
- 這些數字不等於 2026-08-15 JSON 的 559 groups／2438 variants，也不等於 2026-08-17 JSON 的 568 groups／2508 variants。

因此目前 Next DB 不是「2026-08-15 JSON 原樣匯入後的可證明狀態」。這是目前最重要的 parity 警訊：在沒有取得 Next 的完整 raw export 前，不能把 Next UI 0 值歸因為 Production JSON 缺欄位。

### 2.6 WACA／已採購的第一個可觀察分歧點

- WACA：Production／JSON 有 `waca_manual_adjustment`，Next PurchaseRecords 讀取結果為 0。第一個已確認分歧點是 **Next runtime 的資料讀取／ViewModel 層**；目前不能安全判定是「Next DB 內欄位已遺失」或「Next DB 不是該 JSON、再由讀取路徑讀錯」。
- 已採購：Next 的採購批次歷史仍顯示批次、款數、件數與成本，但 PurchaseRecords 的已採購為 0。這表示採購批次資料並非整體消失，然而明細到 Variant 的計算關聯沒有在該頁成功對上。第一個可觀察分歧同樣在 **Next runtime 的 Variant／batch-item 解析鏈**。
- 目前不支持「localStorage WACA」或「缺口公式改壞」的結論。

## 3. P0-H：PurchaseBatch Item Referential Integrity

### 3.1 Production 與 Next 同批次實測

同一 Product Group：八雲べ니 `52e277f7-18c5-4694-99af-d2a6d34ddf56`，同一批次 `第1批下單`：

- Production 展開後可解析 9 筆：複製簽套組、門簾、附收納盒筷子、竹製團扇、壓克力立牌、徽章 A/B/C、複製簽。
- Next 展開同一批次仍有 9 筆、件數 19、成本 0，但 9 筆全部顯示「未知商品」。
- 猫汰つな同樣在 Next 展開「套組拆套」6 筆與「單套組」1 筆時顯示「未知商品」；Production 能解析同類採購明細。

這不是單純 UI fallback：Next 的 resolver 明確是 `variantMap.get(item.product_variant_id)`，找不到 Variant 才顯示「未知商品」。

### 3.2 原始 JSON 的 orphan 統計

`workbench-backup-2026-08-15.json`：

| 關聯 | orphan 筆數 |
| --- | ---: |
| PurchaseBatchItem → ProductVariant | 145 |
| PurchaseBatch → ProductGroup | 25 |
| PurchaseBatchItem → PurchaseBatch | 3 |

2026-08-17 的既有 JSON 也為 145／25／3。這些是 Export 當下已存在的歷史 orphan，不能在本輪自動清除或猜配。

### 3.3 十筆實際可辨識的未知樣本對照

下表選取 Next UI 中被看見為「未知商品」的八雲批次前四筆與猫汰批次前六筆。Production／JSON 兩層可解析；Next UI 明確不能解析。因目前安全瀏覽介面無法直接匯出 Next raw `kv` 內容，Next DB 欄位先標為「未直接讀取」，不冒充已取得。

| batch_item_id | JSON variant_id | JSON group_id | JSON Variant 存在 | Production UI | Next DB raw | Next UI |
| --- | --- | --- | --- | --- | --- | --- |
| `18eeb427…526cc` | `2953f31d…57ad2e` | `52e277f7…ddf56` | 是 | 徽章C款 | 未直接讀取 | 未知商品 |
| `1bf032c6…7c015` | `99946824…7a7da5f2` | `52e277f7…ddf56` | 是 | 壓克力立牌 | 未直接讀取 | 未知商品 |
| `1db281eb…604c6` | `ac438d7b…96cffb1` | `52e277f7…ddf56` | 是 | 徽章A款 | 未直接讀取 | 未知商品 |
| `6968f85e…9359f` | `fed77bae…7ba9f8` | `52e277f7…ddf56` | 是 | 門簾 | 未直接讀取 | 未知商品 |
| `99a7fce2…bd15c8` | `fd47cab9…7a9f3f` | `52e277f7…ddf56` | 是 | 複製簽套組 | 未直接讀取 | 未知商品 |
| `a1b09dae…70ef72a` | `78b4e55f…8bc4bc4` | `52e277f7…ddf56` | 是 | 竹製團扇 | 未直接讀取 | 未知商品 |
| `b40e97a8…a57d` | `a84ecdf0…a23a57d` | `52e277f7…ddf56` | 是 | 徽章B款 | 未直接讀取 | 未知商品 |
| `b68c30b3…15ed3f` | `77fea9ea…54d24` | `52e277f7…ddf56` | 是 | 附收納盒筷子 | 未直接讀取 | 未知商品 |
| `f1cd5c0d…d1eecf` | `b96b2713…a8048c0` | `52e277f7…ddf56` | 是 | 複製簽 | 未直接讀取 | 未知商品 |
| `07234c79…2d737e` | `0a162a0b…a6b4d3` | `18bcdaae…5897cc` | 是 | 絨毛吊飾 | 未直接讀取 | 未知商品 |

這 10 筆不是原始 JSON 的 145 筆 orphan；它們是 JSON 中有 Variant 的有效關聯，卻在目前 Next UI 無法 resolve，故已足以證明本次問題不只是歷史 orphan 顯示。

### 3.4 Importer／dedupe 歷史檢查

- `src/lib/testSnapshotImport.ts` 的 15 組集合會先驗證型別／ID，再以單一 IndexedDB transaction `clear()` 後 `put()`；它沒有重寫 `id`、`product_variant_id` 或 `product_group_id`。
- `buildOrphanWarnings()` 只報告 orphan，不修復、不刪除、不補關聯。
- `src/lib/db.ts` 的 read-time Variant dedupe 是既有 Production 也有的歷史修正（`68dab4f` 已在 Production baseline ancestry 內）；它以 group／SKU／spec／title 建 key，並把 alias item ID remap 到 canonical ID。
- 目前 Next runtime log 只證實合併 2 筆 duplicate row，尚未證實這 2 筆就是上述 10 筆。不能在沒有 raw ID map 前指控 dedupe 造成這批 VSPO 失聯。

## 4. 擴大抽樣結果（先完成來源層，Next parity 暫停宣稱）

同一份 2026-08-15 JSON 的來源層抽樣如下；數字是 `買動漫 / WACA / 私人 / 已採購`，只讀計算，不寫資料：

| 類型 | 五筆抽樣代表 | 結果 |
| --- | --- | --- |
| Hololive | 音乃瀬奏 77萬；綺々羅々ヴィヴィ；大空スバル；響咲リオナ；輪堂千速 | 分別可見 4/0/0/5、9/5/0/16、2/3/0/7、0/1/0/1、7/2/0/11 |
| C108 | JEWEL GLOSS；ギャルあずいろ；C108新刊 After School holoX；HoloSummer；あずきちとござるさん2 | 分別可見 0/0/0/0、1/0/0/1、0/0/0/0、0/0/0/0、0/0/0/0 |
| 代理版 | GSC 3108；BanG Dream Ave Mujica；白上吹雪 Date Style；尾丸波爾卡；S.H.Figuarts 草薙素子 | 分別可見 0/1/0/0、1/0/0/0、38/8/0/0、1/1/0/0、0/0/0/0 |
| 私人訂單 | MOCHIPICO Gamers；超級變色龍；Mococo；掌心 PC 零件；哥吉拉東京SOS | 私人合計分別為 31、1、1、3、1；來源可解析 |
| 套組 | 音乃瀬奏；綺々羅々ヴィヴィ；大空スバル；響咲リオナ；輪堂千速 | 五筆都有 bundle components；原始關聯保留 |
| 多採購批次 | 綺々羅々ヴィヴィ；西部大篷車；MOCHIPICO Gamers；AZKi Departure；星街すいせい | 批次數分別為 3、7、8、2、2 |

目前只把 VSPO 的 Next UI 逐筆核對到「Production 正常、Next 未知／0」；其他類型因 Next raw snapshot 尚未取得，不將 Sandbox parity 標記為通過。這是刻意的停止條件，不用畫面猜數字。

## 5. 原有 parity 測試的重新定義

目前 `tests/sandbox-snapshot-parity.mjs` 做的是：

```text
同一份 JSON → Next
同一份 JSON → Experimental
比較 counts / collectionHashes
```

這只能叫：

> **Sandbox-to-Sandbox Parity**

本次新增的業務驗收定義（尚未實作測試）應另稱：

> **Production Business Parity**

至少要對固定 Product Group／Variant ID 比較：

- 買動漫
- WACA（含 manual adjustment）
- 私人訂單
- 已採購
- 缺口
- 採購批次與批次明細是否可 resolve
- orphan 關聯數是否 `imported <= source JSON`

並且要同時保存 Production UI／Production JSON／Sandbox raw DB／Sandbox UI 四層證據。四層中任何一層缺少，就不能標記 parity 通過。

## 6. 根因判定與目前信心

### P0-G

- **已排除**：Production 沒資料、JSON 沒 WACA、WACA 只在 localStorage、缺口公式本輪被改掉。
- **已確認**：JSON 有 WACA manual adjustment 與 purchase batch quantity；Next UI 讀取為 0。
- **最可能層級**：Next Sandbox 的資料來源／匯入後 runtime read／Variant-to-batch-item ViewModel 不同於該 Production JSON；目前 Next live DB 與指定 JSON 筆數不一致，這是最強證據。
- **尚未證實**：是 Snapshot 來源選錯／未完整替換、Next DB 後續被其他資料覆蓋，或 read-time dedupe alias map 對這批 ID 造成失聯。

### P0-H

- **已排除**：Production 原始批次本身全面壞掉；Production 同批次可解析。
- **已確認**：原始 JSON 有 145 筆 Variant orphan／25 筆 Group orphan／3 筆 Batch orphan；但被 Next 顯示未知的 10 筆 VSPO 樣本在 JSON 中不是 orphan。
- **最可能層級**：指定 JSON 到目前 Next live DB／runtime read 之間的 snapshot provenance 或關聯解析差異；不能只歸因為既有歷史 orphan。
- **尚未證實**：Next raw orphan 是否大於 145。現有安全 UI 沒有提供完整 raw ID export，因此這個數字本輪保留為「待直接讀取」。

## 7. 最小且安全的下一步（本輪不執行）

1. 在新的 disposable Sandbox DB 以 `workbench-backup-2026-08-15.json` 完整匯入，讀取 raw `erp_product_variants`／`erp_purchase_batch_items`／`erp_purchase_batches`，計算精確 orphan。
2. 逐一檢查上表 10 個 `batch_item_id`：raw item ID、raw variant ID、canonical variant ID、alias map、group ID。
3. 將目前 Next live DB 另存唯讀 JSON，再與指定 2026-08-15 JSON 比較每集合 counts／hash／關聯；不要先修復目前 Next DB。
4. 若 raw Next 與 JSON 相同但 UI 仍失聯，才進入 ViewModel／dedupe bisect；若 raw Next 已不同，先追 snapshot import provenance。
5. 之後才建立 Production Business Parity 自動測試；不要用人工補 WACA、補已採購或 SKU／名稱猜配。

## 8. 禁止事項與資料狀態

本輪沒有：

- 修改 Production、Next DB 或 JSON
- 補 WACA／已採購／Variant ID
- 改缺口公式或 resolver fallback
- 執行 restore、import、seed、migration
- Push、Deploy
- 修改 Provider、db.ts 或 Schema

結論：目前只能標記 **P0-G/P0-H：診斷已確認、修正未開始**。在取得 Next raw 四層資料前，不應修 Snapshot、Importer 或 ViewModel，也不應把「Sandbox-to-Sandbox parity」繼續稱作 Production Parity。
