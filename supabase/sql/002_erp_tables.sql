-- =========================================================================
-- 小河馬採購工作台 - ERP 雲端資料表 DDL 草案 (Phase 3-B)
-- 檔案名稱: 002_erp_tables.sql
-- 
-- 【說明】
-- 1. 本檔案為資料表遷移 SQL 草案，包含外鍵關聯、效能索引、自動更新時間與軟刪除機制。
-- 2. **請手動複製到 Supabase SQL Editor 執行，請勿直接修改程式**。
-- 3. 本 DDL 預留 sync_status、version、local_id 等欄位以配合未來本地/雲端雙向同步與衝突判定。
-- =========================================================================

-- ==========================================
-- 0. 公用觸發器函數：更新 updated_at 欄位
-- ==========================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ==========================================
-- 1. 資料表建立
-- ==========================================

-- A. 商品庫存主檔 (Inventory)
CREATE TABLE IF NOT EXISTS public.inventory (
    myacg_item_code          text PRIMARY KEY,
    product_id               text,
    product_title            text NOT NULL,
    normalized_product_title text,
    raw_variant_name         text NOT NULL,
    listing_type             text NOT NULL,
    final_price              numeric(12, 2) NOT NULL DEFAULT 0,
    myacg_available_quantity integer NOT NULL DEFAULT 0,
    myacg_sold_quantity      integer NOT NULL DEFAULT 0,
    myacg_demand_quantity    integer,
    myacg_listed_at          timestamptz,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- B. 商品群組 (Product Group)
CREATE TABLE IF NOT EXISTS public.product_groups (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title              text NOT NULL,
    normalized_title   text,
    listing_type       text,
    priority           text NOT NULL DEFAULT 'Medium' CONSTRAINT priority_check CHECK (priority IN ('High', 'Medium', 'Low')),
    purchase_date      date,
    closing_date       date,
    release_month      text,
    has_official_site  boolean NOT NULL DEFAULT false,
    product_url        text,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- C. 商品分類 (Product Category)
CREATE TABLE IF NOT EXISTS public.product_categories (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    title            text NOT NULL,
    sort_order       integer NOT NULL DEFAULT 0,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- D. 商品規格明細 (Product Variant)
CREATE TABLE IF NOT EXISTS public.product_variants (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id          uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    product_category_id       uuid REFERENCES public.product_categories(id) ON DELETE SET NULL,
    myacg_item_code           text NOT NULL REFERENCES public.inventory(myacg_item_code) ON DELETE RESTRICT,
    product_title             text NOT NULL,
    variant_name              text NOT NULL,
    raw_variant_name          text,
    myacg_auto_quantity       integer NOT NULL DEFAULT 0,
    effective_myacg_quantity   integer NOT NULL DEFAULT 0,
    waca_auto_quantity        integer NOT NULL DEFAULT 0,
    note                      text NOT NULL DEFAULT '',
    sort_order                integer NOT NULL DEFAULT 0,
    catalog_missing           boolean NOT NULL DEFAULT false,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- E. 採購批次母表 (Purchase Batch)
CREATE TABLE IF NOT EXISTS public.purchase_batches (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    name             text NOT NULL,
    date             date,
    note             text,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- F. 採購批次明細 (Purchase Batch Item)
CREATE TABLE IF NOT EXISTS public.purchase_batch_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_batch_id  uuid NOT NULL REFERENCES public.purchase_batches(id) ON DELETE CASCADE,
    product_variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
    quantity           integer NOT NULL DEFAULT 0,
    cost               numeric(12, 2) NOT NULL DEFAULT 0,
    note               text,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- G. 私下登記母表 (Private Order)
CREATE TABLE IF NOT EXISTS public.private_orders (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    customer_name    text NOT NULL,
    contact          text,
    note             text,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- H. 私下登記明細 (Private Order Item)
CREATE TABLE IF NOT EXISTS public.private_order_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    private_order_id   uuid NOT NULL REFERENCES public.private_orders(id) ON DELETE CASCADE,
    product_variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
    quantity           integer NOT NULL DEFAULT 0,
    amount             numeric(12, 2) NOT NULL DEFAULT 0,
    note               text,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- I. 銷售訂單單頭 (Sales Order)
CREATE TABLE IF NOT EXISTS public.sales_orders (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform     text NOT NULL,
    order_number text NOT NULL UNIQUE,
    buyer_name   text NOT NULL,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- J. 銷售訂單單身明細 (Sales Order Item)
CREATE TABLE IF NOT EXISTS public.sales_order_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
    product_variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL,
    myacg_item_code    text NOT NULL REFERENCES public.inventory(myacg_item_code) ON DELETE RESTRICT,
    product_name       text,
    variant_name       text,
    quantity           integer NOT NULL DEFAULT 0,
    price              numeric(12, 2) DEFAULT 0,
    amount             numeric(12, 2) DEFAULT 0,
    order_status       text,
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- K. 匯入批次日誌 (Import Batch)
CREATE TABLE IF NOT EXISTS public.import_batches (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform                 text NOT NULL,
    file_name                text NOT NULL,
    imported_at              timestamptz NOT NULL DEFAULT now(),
    total_rows               integer NOT NULL DEFAULT 0,
    valid_rows               integer NOT NULL DEFAULT 0,
    skipped_cancelled_rows   integer NOT NULL DEFAULT 0,
    new_order_items          integer NOT NULL DEFAULT 0,
    skipped_duplicate_items  integer NOT NULL DEFAULT 0,
    created_groups_count     integer NOT NULL DEFAULT 0,
    completed_group_skus_count integer NOT NULL DEFAULT 0,
    catalog_missing_count    integer NOT NULL DEFAULT 0,
    note                     text,
    details                  jsonb, -- 儲存詳細 UUID 與 JSON 結構
    
    -- 同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- ==========================================
-- 2. 觸發器綁定：自動更新 updated_at 欄位
-- ==========================================
CREATE TRIGGER trigger_update_inventory_updated_at BEFORE UPDATE ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_product_groups_updated_at BEFORE UPDATE ON public.product_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_product_categories_updated_at BEFORE UPDATE ON public.product_categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_product_variants_updated_at BEFORE UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_purchase_batches_updated_at BEFORE UPDATE ON public.purchase_batches FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_purchase_batch_items_updated_at BEFORE UPDATE ON public.purchase_batch_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_private_orders_updated_at BEFORE UPDATE ON public.private_orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_private_order_items_updated_at BEFORE UPDATE ON public.private_order_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_sales_order_items_updated_at BEFORE UPDATE ON public.sales_order_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_import_batches_updated_at BEFORE UPDATE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ==========================================
-- 3. 效能索引優化
-- ==========================================

-- A. 外鍵索引 (Foreign Key Indexes)
CREATE INDEX IF NOT EXISTS idx_product_categories_group_id ON public.product_categories(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_group_id ON public.product_variants(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_category_id ON public.product_variants(product_category_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_myacg_item_code ON public.product_variants(myacg_item_code);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_group_id ON public.purchase_batches(product_group_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_batch_id ON public.purchase_batch_items(purchase_batch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_variant_id ON public.purchase_batch_items(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_private_orders_group_id ON public.private_orders(product_group_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_order_id ON public.private_order_items(private_order_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_variant_id ON public.private_order_items(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_order_id ON public.sales_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_variant_id ON public.sales_order_items(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_myacg_item_code ON public.sales_order_items(myacg_item_code);

-- B. 搜尋性能優化索引
CREATE INDEX IF NOT EXISTS idx_inventory_normalized_title ON public.inventory(normalized_product_title);
CREATE INDEX IF NOT EXISTS idx_product_groups_normalized_title ON public.product_groups(normalized_title);

-- C. 軟刪除與同步索引 (Partial Indexes)
CREATE INDEX IF NOT EXISTS idx_inventory_active ON public.inventory(myacg_item_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_product_groups_active ON public.product_groups(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_product_variants_active ON public.product_variants(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_batches_active ON public.purchase_batches(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_private_orders_active ON public.private_orders(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_orders_active ON public.sales_orders(id) WHERE deleted_at IS NULL;

-- D. 本地 IDB 與雲端對應加速索引 (local_id Lookup Indexes)
CREATE INDEX IF NOT EXISTS idx_inventory_local_id ON public.inventory(local_id);
CREATE INDEX IF NOT EXISTS idx_product_groups_local_id ON public.product_groups(local_id);
CREATE INDEX IF NOT EXISTS idx_product_categories_local_id ON public.product_categories(local_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_local_id ON public.product_variants(local_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_local_id ON public.purchase_batches(local_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_local_id ON public.purchase_batch_items(local_id);
CREATE INDEX IF NOT EXISTS idx_private_orders_local_id ON public.private_orders(local_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_local_id ON public.private_order_items(local_id);
CREATE INDEX IF NOT EXISTS idx_sales_orders_local_id ON public.sales_orders(local_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_local_id ON public.sales_order_items(local_id);
CREATE INDEX IF NOT EXISTS idx_import_batches_local_id ON public.import_batches(local_id);
