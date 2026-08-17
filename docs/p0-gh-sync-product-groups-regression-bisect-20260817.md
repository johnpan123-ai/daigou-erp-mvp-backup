# P0-G/H `syncProductGroupsWithInventory()` regression bisect

日期：2026-08-17（Asia/Taipei）  
環境：Next Sandbox／獨立 Git bisect worktree  
Production：0 write、0 deploy

## 結論

- First Bad Commit：`c08fe2eac25491e771e0378d71ef93d2c67cbeca`
- Commit message：`backup: purchase management general mode v1`
- Known Good：`27f61405d16688b9ddd882949114d76e9979fe5a`
- regression 類型：新增了「Catalog 缺少 Variant 自動建立」流程；不是既有安全流程被後續改壞。

## 測試定義

測試工具：

- `tests/sync-product-groups-regression.mjs`
- `tests/run-sync-product-groups-bisect.mjs`

每個 Commit 都使用新的無痕 Browser Context，因此 IndexedDB 與 localStorage
不會沿用前一個 Commit。測試由固定
`workbench-backup-2026-08-15.json` 建立基準，記錄 Variant ID、WACA/manual
metadata 與 FK orphan 數，再執行 `syncProductGroupsWithInventory()`。

測試分成兩個 Gate：

1. 健康讀取：完整 Snapshot 可正常讀到 Variant。現在 HEAD 與 First Bad Commit
   都通過，代表健康資料不會無條件被改寫。
2. 一次性空讀取：模擬 storage read error 被既有 adapter fail-open 成 `[]`。
   持久資料在注入前完整存在；只有 sync 的第一次 `getProductVariants()` 回傳空集合。
   這會重現持久 Next DB 的資料形狀與 FK 失聯方式。

這個區分很重要：First Bad 指的是「sync 面對暫時空讀取時會破壞完整資料」；
不是宣稱完整、健康的 Snapshot 每次 sync 都必然損壞。

## 自動 bisect 結果

有效的第二次 `git bisect run`：

```text
bad  16be600cebd39c8b20fd6d6d1b3cb1b7f33f0099
good 27f61405d16688b9ddd882949114d76e9979fe5a
first bad c08fe2eac25491e771e0378d71ef93d2c67cbeca
```

邊界實測：

| Commit | sync 存在 | 注入空讀取 | Variant 前→後 | BatchItem→Variant orphan 前→後 | 結果 |
| --- | ---: | ---: | ---: | ---: | --- |
| `27f6140` | 否 | 是 | 45→45 | 0→0 | PASS |
| `c08fe2e` | 是 | 是 | 45→42 | 0→26 | FAIL |
| `c08fe2e` | 是 | 否 | 45→45 | 0→0 | PASS |
| `16be600` | 是 | 是 | 2438→2400 | 145→1407 | FAIL |

目前 HEAD 的完整 FK 影響（來源 JSON 原本已有歷史 orphan，故比較增量）：

- BatchItem → Variant：145 → 1407
- PrivateOrderItem → Variant：17 → 120
- Bundle parent → Variant：32 → 284
- Bundle component → Variant：34 → 284
- JapanPackageItem → Variant：41 → 194

## First Bad Commit 的相關變更

Commit 本身是 64 檔、`+9162/-1063` 的大型備份 Commit。與本 regression
直接相關的是：

- `src/lib/db.ts`
  - 新增 `syncProductGroupsWithInventory()`。
  - 新增 `DatabaseAdapter` method。
  - 新 Variant 只從 Catalog 欄位組裝。
- `src/pages/Inventory.tsx`
  - XLS `upsertInventory()` 後自動呼叫 sync。
- `update_sync.cjs`
  - 當時用來替換／產生 sync 函式的工作腳本。

原始目的可由 Inventory UI 報告與程式註解確認：在匯入 Catalog 後，
「補齊既有訂購紀錄 SKU」、更新 `catalog_missing`、規格分類與排序。

## 第一個破壞資料的位置

First Bad Commit 的 `src/lib/db.ts`：

1. line 571：直接信任 `getProductVariants()` 回傳值，沒有區分「真空資料」與
   「讀取失敗後的空陣列」。
2. lines 590-594：空 Variant 集合讓全部 matching Inventory rows 被判定為
   `missingItems`。
3. lines 642-653：每筆以 `crypto.randomUUID()` 建立新 Variant，只帶 Catalog
   欄位；沒有保留舊 ID、`waca_manual_adjustment`、purchased/manual metadata、
   timestamps 等資料。
4. lines 707-710：`saveProductVariants(variants)` 將整份新陣列寫回。
5. PurchaseBatch／Private／Bundle／JapanPackage 仍引用舊 Variant ID，因而 orphan。

因此真正的第一個不可逆動作是 line 709 的整份寫回；但資料語意從 line 594
把「空讀取」當成「全部缺少」時就已經被錯誤決定。

## 為什麼當時測試沒有發現

- `c08fe2e` tree 中沒有 test/spec 檔案。
- 健康路徑確實 PASS；只有 transient empty read／fail-open `[]` 才觸發。
- 當時沒有檢查 Variant ID stability、WACA/manual metadata 或 FK orphan 增量。
- 這是一個 64 檔大型備份 Commit，Catalog 補規格功能與大量 UI/資料改動混在一起。
- adapter 的讀取錯誤會回傳 default empty array，UI 不一定顯示 Error，讓危險前提不明顯。

## 建議最小修法（尚未實作）

1. 在 sync 寫入前做 fail-closed preflight：如果讀到 `variants.length === 0`，但
   已存在 Product Groups 或任何 Variant FK（batch/private/bundle/package），直接中止並顯示
   「Variant 讀取異常，未執行同步」。
2. 只有在可證明是全新資料庫、且不存在任何 Variant 依賴時，才允許從 Catalog
   建立全新 UUID。
3. 在任何 `saveProductVariants()` 前，比對：
   - 舊 Variant ID 不得無解消失；
   - FK orphan 不得增加；
   - 已存在 SKU 的 WACA/manual metadata 必須保留。
4. 保留本測試為回歸 Gate，並新增健康路徑＋讀取失敗路徑兩組測試。

這個方案不需要修改 Schema、Migration、RLS 或正式資料；修正前不應對已損壞
Sandbox 自動補 WACA、猜 FK 或重建 Variant。

