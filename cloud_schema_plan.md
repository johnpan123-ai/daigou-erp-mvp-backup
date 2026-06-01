# ERP 雲端資料表設計與同步規劃文件 (Phase 3-A)

本文件規劃「小河馬採購工作台」由瀏覽器本地端儲存（IndexedDB/LocalStorage）遷移至 Supabase 雲端 PostgreSQL 資料庫的完整資料模型設計、資料同步策略與多人協作衝突解決方案，並保留本地單機模式的高可用性與獨立運作能力。

---

## 一、 本地資料模型與雲端資料表對應

本地 IndexedDB 中的所有模型將一對一映射至 Supabase `public` Schema 下的關係資料表：

| 本地模型名稱 (`db.ts`) | 雲端資料表名稱 | 資料層級與外鍵關係 | 說明 |
| :--- | :--- | :--- | :--- |
| `InventoryItem` | `public.inventory` | 1對多關聯 `sales_order_items` | 從買動漫 XLS 匯入的原始商品庫存、售價主檔。 |
| `ProductGroup` | `public.product_groups` | 1對多關聯 categories, variants | 採購專案/團購母體，用於將多種 SKU 規格打包管理。 |
| `ProductCategory` | `public.product_categories`| 多對1關聯 `product_groups` | 商品群組底下的分類頁籤（如「A區」、「B區」）。 |
| `ProductVariant` | `public.product_variants` | 多對1關聯 groups 及 categories | 實際規格明細 SKU，承載 WACA 需求與手動調整量。 |
| `PurchaseBatch` | `public.purchase_batches` | 1對多關聯 `purchase_batch_items`| 每次向廠商送出採購的紀錄單頭（採購紀錄）。 |
| `PurchaseBatchItem` | `public.purchase_batch_items` | 多對1關聯 batches 與 variants | 採購批次明細，記錄單一 SKU 的進貨數量與成本。 |
| `PrivateOrder` | `public.private_orders` | 1對多關聯 `private_order_items` | 熟客或私下登記的訂單單頭。 |
| `PrivateOrderItem` | `public.private_order_items` | 多對1關聯 orders 與 variants | 私下登記明細，記錄購買規格、數量與售價。 |
| `SalesOrder` | `public.sales_orders` | 1對多關聯 `sales_order_items` | 解析訂單 CSV 後建立的平台交易單頭。 |
| `SalesOrderItem` | `public.sales_order_items` | 多對1關聯 sales_orders 及 variants | 平台訂單明細，承載買家購買量與訂單狀態。 |
| `ImportBatch` | `public.import_logs` | 1對多關聯訂單/庫存明細 | 檔案匯入歷程稽核日誌，記錄每次上傳的檔案與統計。 |

---

## 二、 每張表建議必備欄位 (系統中介欄位)

為了支援離線編輯、增量同步、審查追蹤與多人協作鎖定，**所有 11 張雲端表**都必須包含以下中介欄位：

```sql
ALTER TABLE public.your_table ADD COLUMN id          uuid PRIMARY KEY DEFAULT gen_random_uuid();
ALTER TABLE public.your_table ADD COLUMN local_id    text; -- 儲存本地 IndexedDB 的隨機 UUID
ALTER TABLE public.your_table ADD COLUMN created_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.your_table ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.your_table ADD COLUMN updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid();
ALTER TABLE public.your_table ADD COLUMN deleted_at  timestamptz; -- 軟刪除時間標記
ALTER TABLE public.your_table ADD COLUMN version     integer NOT NULL DEFAULT 1; -- 樂觀鎖版本
ALTER TABLE public.your_table ADD COLUMN sync_status text NOT NULL DEFAULT 'synced'; -- 'synced' | 'pending' | 'conflict'
```

---

## 三、 資料關聯設計 (Foreign Key & Cascade Rules)

雲端關係型資料庫將建立嚴格的外鍵約束，以防止孤兒數據（Orphan rows）的產生：

* **`product_groups` $\rightarrow$ `product_variants` & `product_categories`**
  * `product_categories.product_group_id` REFERENCES `product_groups(id) ON DELETE CASCADE`
  * `product_variants.product_group_id` REFERENCES `product_groups(id) ON DELETE CASCADE`
  * *說明*：若商品母體被物理刪除，其底下的分類與規格明細將同步串聯刪除。
* **`product_categories` $\rightarrow$ `product_variants`**
  * `product_variants.product_category_id` REFERENCES `product_categories(id) ON DELETE SET NULL`
  * *說明*：若刪除某個分類分頁，規格不會被刪除，僅會將其分類歸屬設為 NULL。
* **`purchase_batches` $\rightarrow$ `purchase_batch_items`**
  * `purchase_batch_items.purchase_batch_id` REFERENCES `purchase_batches(id) ON DELETE CASCADE`
  * `purchase_batch_items.product_variant_id` REFERENCES `product_variants(id) ON DELETE RESTRICT`
  * *說明*：刪除採購批次會一併刪除明細；但**禁止刪除**已被採購明細所參照的商品規格（RESTRICT 限制）。
* **`private_orders` $\rightarrow$ `private_order_items`**
  * `private_order_items.private_order_id` REFERENCES `private_orders(id) ON DELETE CASCADE`
  * `private_order_items.product_variant_id` REFERENCES `product_variants(id) ON DELETE RESTRICT`
* **`sales_orders` $\rightarrow$ `sales_order_items`**
  * `sales_order_items.order_id` REFERENCES `sales_orders(id) ON DELETE CASCADE`
  * `sales_order_items.product_variant_id` REFERENCES `product_variants(id) ON DELETE SET NULL`
  * `sales_order_items.myacg_item_code` REFERENCES `inventory(myacg_item_code) ON DELETE RESTRICT`
  * *說明*：平台訂單明細必須強制參照商品庫存代碼。

---

## 四、 雲端同步策略

為了兼顧本地單機性能與雲端多人協作，同步邏輯分為三個層面：

### 1. 本地 $\rightarrow$ 雲端 (上傳同步)
* **異動標記**：本地模式下，任何新增或更新動作，皆會在 IndexedDB 中將該列的 `sync_status` 設為 `'pending'`，並更新本地的 `updated_at`。
* **背景批次上傳**：當偵測到網路恢復（或手動按下同步）且切換為雲端模式時，系統會將所有 `'pending'` 的行打包成 JSON Payload，發送至雲端執行 Upsert。寫入成功後，將本地狀態還原為 `'synced'`。

### 2. 雲端 $\rightarrow$ 本地 (增量下載)
* **增量查詢**：客戶端記錄上次同步的時間戳記 `last_sync_time`。
* **下載更新**：客戶端向雲端拉取：
  `SELECT * FROM table WHERE updated_at > :last_sync_time`
* **本地合併**：將下載到的更新寫入本地 IndexedDB，若下載資料的 `deleted_at` 不為空，則同步在本地 IndexedDB 執行刪除。

### 3. local_id 與 cloud_id 的雙向對應
* 離線新增時，客戶端會使用 UUID 產生 `local_id` 作為 PK。
* 上傳至雲端時，雲端會生成一個 `id` (Cloud UUID)。
* 客戶端在下載資料時，必須以 `local_id` 欄位作為首要識別鍵（而非雲端 `id`），避免在本地重複插入同一筆資料。

### 4. 避免本地覆蓋雲端 (覆寫衝突防禦)
* 客戶端在上傳 `'pending'` 資料時，必須夾帶當前本地快取的 `version` 數值。
* 雲端在寫入前，比對資料庫中的 `version` 與客戶端傳入的 `version`：
  * 若 **雲端 version == 客戶端 version**，允許寫入，並由資料庫 Trigger 自動將 `version` 累加。
  * 若 **雲端 version > 客戶端 version**，代表在此期間已有其他同事更新了這筆資料。雲端將拒絕更新，並向客戶端回傳 `409 Conflict` 狀態，由客戶端提示用戶進行「欄位合併」或「手動選擇保留版本」。

### 5. 離線資料補同步流程 (Catch-up Sync)
* **網路偵測與觸發**：利用瀏覽器 `navigator.onLine` 事件與 Web API，在斷網恢復或用戶主動切換至「雲端模式」時自動觸發「補同步程序」。
* **三階段補同步流程**：
  1. **拉取雲端異動 (Pull)**：首先向雲端拉取斷線期間（`updated_at > last_sync_time`）的所有變更資料。
  2. **本地衝突標記 (Conflict Marking)**：
     - 若雲端拉回的異動資料中，某個 `local_id` 在本地的 `sync_status` 也是 `'pending'`，代表**雙向編輯衝突**。
     - 系統會將該筆本地資料的 `sync_status` 標記為 `'conflict'`，並將雲端版本暫存於 IndexedDB 衝突快取區。
     - 若無衝突（本地為 `'synced'` 且未修改，或只有單向異動），則直接將雲端資料覆寫至本地 IndexedDB。
  3. **推播本地修改 (Push)**：將本地其餘無衝突、狀態為 `'pending'` 的異動資料，批次 upsert 至雲端。
  4. **衝突調解介面 (Conflict Resolution)**：針對標記為 `'conflict'` 的資料，在前端設定頁面或通知欄跳出提示，由用戶點擊並透過視覺化 Diff 工具選擇「保留雲端」、「保留本地」或「欄位級合併（Merge）」，解決後將 `sync_status` 設為 `'synced'` 並同步至雲端。

---

## 五、 大量匯入策略 (Bulk Import & Database Optimization)

匯入大量的 XLS（庫存主檔，約 1,000+ 筆） or CSV（訂單紀錄，約 2,000+ 筆）若採用逐筆 REST API `INSERT`，會造成極大的網路瓶頸與連線崩潰。

### 解決方案：

1. **Supabase 批次 Upsert (Batch Insert)**：
   利用 Supabase-js 的批次陣列傳入功能。Vite 客戶端將檔案解析成一整個 JSON 陣列，僅透過一次 HTTP POST 請求將整批資料傳送給 PostgREST，由資料庫進行原生批次寫入：
   ```javascript
   const { data, error } = await supabase
     .from('inventory')
     .upsert(parsedInventoryItemsArray, { onConflict: 'myacg_item_code' });
   ```
2. **PostgreSQL RPC 預存程序 (交易安全保障)**：
   對於訂單匯入（需要同時寫入 `sales_orders`、`sales_order_items` 並更新 `product_variants` 平台需求量），我們會在資料庫建立一個安全函數：
   ```sql
   CREATE OR REPLACE FUNCTION public.import_sales_csv_batch(orders_payload jsonb, items_payload jsonb) ...
   ```
   整個解析與寫入工作在資料庫的單一 Transaction 中執行。這能確保資料「要麼全成功，要麼全失敗」，並將耗時從幾分鐘壓縮到 200 毫秒內。

---

## 六、 多人協作風險與緩解手段

### 1. 全表 Save 覆蓋風險
* **風險**：本地 IndexedDB 目前會將整組 categories/variants 的陣列全量存檔（`saveProductGroups(groups)`），這在雲端環境會將其他同事剛寫入的資料直接「物理覆蓋並抹除」。
* **緩解**：徹底重構前端 `dataProvider` 寫入層，改為**「列級/部分（Row-level / Patch）更新」**。僅發送異動行的 SQL Upsert，不發送整張表。

### 2. 同時編輯衝突 (Dirty Write)
* **風險**：兩名採購同時修改一個規格的 note 或調整數量。
* **緩解**：套用**樂觀鎖**（Optimistic Locking，詳見 RLS 觸發器 DDL）。比對 `version` 決定是否成功。

### 3. 軟刪除 (Soft Delete) 與資料追蹤
* **風險**：實體物理刪除會破壞外鍵完整性並導致其他系統參照遺失。
* **緩解**：
  * 限制物理刪除（DELETE）僅限 `owner` 角色。
  * 一般員工的刪除動作一律編譯為 `UPDATE` 指令，將 `deleted_at` 設為當前時間。
  * 所有 SELECT 政策加上 `deleted_at IS NULL` 自動過濾，使軟刪除資料在一般介面隱藏，但可在管理後台進行稽核與還原。
  * 每筆異動透過 `updated_by` 自動寫入當前登入使用者的 `auth.uid()`，確實記錄操作者日誌。

---

## 七、 後續 Phase 建議與計畫時程

本規劃核准後，建議依據以下子階段推動雲端資料表遷移：

* **Phase 3-B：撰寫 ERP tables SQL 草案**
  * 在 `supabase/sql/002_erp_tables.sql` 中撰寫 11 張表的完整 DDL（包含欄位約束、Trigger 與效能 Index）。
* **Phase 3-C：SQL 審查**
  * 針對外鍵 Cascade 規則、RLS 效能與 Index 覆蓋率進行程式碼安全審查。
* **Phase 3-D：建立資料表**
  * 在 Supabase SQL Editor 中正式執行 DDL，建立資料庫結構。
* **Phase 3-E：只讀同步測試**
  * 在不開放寫入的狀態下，重構 `dataProvider.get...()`。測試從雲端下載資料快取回 IndexedDB 的增量同步邏輯。
* **Phase 3-F：小量寫入測試**
  * 測試單筆商品的新增、修改、軟刪除與觸發器 version 自動加壓效能。
* **Phase 3-G：正式資料匯入**
  * 透過 RPC 進行大批量歷史訂單與商品主檔資料匯入，宣告雲端化完成。
