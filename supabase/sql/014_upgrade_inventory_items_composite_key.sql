-- =========================================================================
-- 小河馬採購工作台 - Phase 1-D 庫存主檔複合主鍵升級 Migration
-- 檔案名稱: 014_upgrade_inventory_items_composite_key.sql
-- =========================================================================

-- 1. 新增 inventory_key 欄位
ALTER TABLE public.inventory_items ADD COLUMN IF NOT EXISTS inventory_key text;

-- 2. 針對既存的舊庫存資料回填 inventory_key
-- 規則：COALESCE(normalized_product_title, product_title) || '::' || myacg_item_code || '::' || COALESCE(raw_variant_name, '')
UPDATE public.inventory_items
SET inventory_key = COALESCE(normalized_product_title, product_title) || '::' || myacg_item_code || '::' || COALESCE(raw_variant_name, '')
WHERE inventory_key IS NULL;

-- 3. 安全防護：若有極端情況仍為 NULL，則使用 UUID 補齊
UPDATE public.inventory_items
SET inventory_key = gen_random_uuid()::text
WHERE inventory_key IS NULL;

-- 4. 將 inventory_key 設定為 NOT NULL
ALTER TABLE public.inventory_items ALTER COLUMN inventory_key SET NOT NULL;

-- 5. 移除原有的 myacg_item_code 主鍵約束 (預設名稱為 inventory_items_pkey)
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS inventory_items_pkey;

-- 6. 設定新的 inventory_key 為主鍵 (PRIMARY KEY)
ALTER TABLE public.inventory_items ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (inventory_key);

-- 7. 建立一般效能索引，以利後續以 SKU (myacg_item_code) 進行快速查詢
CREATE INDEX IF NOT EXISTS idx_inventory_items_myacg_item_code ON public.inventory_items (myacg_item_code);
