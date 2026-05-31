-- =========================================================================
-- 小河馬採購工作台 - 訂購紀錄核心雲端同步 SQL 草案 (Phase 3-B-MVP)
-- 檔案名稱: 002_core_erp_tables_mvp.sql
-- 
-- 【說明】
-- 1. 本檔案為 MVP 最小可行性產品之核心資料庫 SQL 草案。
-- 2. 僅建立訂購紀錄核心 7 張表，暫時不包含 inventory、sales_orders 與檔案匯入日誌。
-- 3. 為此，product_variants.myacg_item_code 欄位改為純文字 (text) 儲存，不加外鍵約束。
-- 4. **請手動複製到 Supabase SQL Editor 執行，請勿直接修改程式**。
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
-- 1. 建立 7 張核心資料表
-- ==========================================

-- A. 商品群組 (Product Group)
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
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- B. 商品分類 (Product Category)
CREATE TABLE IF NOT EXISTS public.product_categories (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    title            text NOT NULL,
    sort_order       integer NOT NULL DEFAULT 0,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- C. 商品規格明細 (Product Variant)
CREATE TABLE IF NOT EXISTS public.product_variants (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id          uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    product_category_id       uuid REFERENCES public.product_categories(id) ON DELETE SET NULL,
    myacg_item_code           text NOT NULL, -- MVP 階段改為純文字儲存，不建立與 inventory 表的外鍵約束
    product_title             text NOT NULL,
    variant_name              text NOT NULL,
    raw_variant_name          text,
    myacg_auto_quantity       integer NOT NULL DEFAULT 0,
    effective_myacg_quantity   integer NOT NULL DEFAULT 0,
    waca_auto_quantity        integer NOT NULL DEFAULT 0,
    note                      text NOT NULL DEFAULT '',
    sort_order                integer NOT NULL DEFAULT 0,
    catalog_missing           boolean NOT NULL DEFAULT false,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- D. 採購批次單頭 (Purchase Batch)
CREATE TABLE IF NOT EXISTS public.purchase_batches (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    name             text NOT NULL,
    date             date,
    note             text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- E. 採購批次明細 (Purchase Batch Item)
CREATE TABLE IF NOT EXISTS public.purchase_batch_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_batch_id  uuid NOT NULL REFERENCES public.purchase_batches(id) ON DELETE CASCADE,
    product_variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
    quantity           integer NOT NULL DEFAULT 0,
    cost               numeric(12, 2) NOT NULL DEFAULT 0,
    note               text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- F. 私下登記單頭 (Private Order)
CREATE TABLE IF NOT EXISTS public.private_orders (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    customer_name    text NOT NULL,
    contact          text,
    note             text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- G. 私下登記明細 (Private Order Item)
CREATE TABLE IF NOT EXISTS public.private_order_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    private_order_id   uuid NOT NULL REFERENCES public.private_orders(id) ON DELETE CASCADE,
    product_variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
    quantity           integer NOT NULL DEFAULT 0,
    amount             numeric(12, 2) NOT NULL DEFAULT 0,
    note               text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- ==========================================
-- 2. 觸發器綁定：自動更新 updated_at 欄位
-- ==========================================
CREATE TRIGGER trigger_update_product_groups_updated_at BEFORE UPDATE ON public.product_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_product_categories_updated_at BEFORE UPDATE ON public.product_categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_product_variants_updated_at BEFORE UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_purchase_batches_updated_at BEFORE UPDATE ON public.purchase_batches FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_purchase_batch_items_updated_at BEFORE UPDATE ON public.purchase_batch_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_private_orders_updated_at BEFORE UPDATE ON public.private_orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_private_order_items_updated_at BEFORE UPDATE ON public.private_order_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ==========================================
-- 3. 效能索引優化
-- ==========================================

-- A. 外鍵索引 (Foreign Key Indexes)
CREATE INDEX IF NOT EXISTS idx_product_categories_group_id ON public.product_categories(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_group_id ON public.product_variants(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_category_id ON public.product_variants(product_category_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_group_id ON public.purchase_batches(product_group_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_batch_id ON public.purchase_batch_items(purchase_batch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_variant_id ON public.purchase_batch_items(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_private_orders_group_id ON public.private_orders(product_group_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_order_id ON public.private_order_items(private_order_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_variant_id ON public.private_order_items(product_variant_id);

-- B. 軟刪除與同步索引 (Partial Indexes & local_id Lookups)
CREATE INDEX IF NOT EXISTS idx_product_groups_active ON public.product_groups(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_product_variants_active ON public.product_variants(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_batches_active ON public.purchase_batches(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_private_orders_active ON public.private_orders(id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_groups_local_id ON public.product_groups(local_id);
CREATE INDEX IF NOT EXISTS idx_product_categories_local_id ON public.product_categories(local_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_local_id ON public.product_variants(local_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_local_id ON public.purchase_batches(local_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_local_id ON public.purchase_batch_items(local_id);
CREATE INDEX IF NOT EXISTS idx_private_orders_local_id ON public.private_orders(local_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_local_id ON public.private_order_items(local_id);

-- ==========================================
-- 4. 行級安全策略 (Row Level Security - RLS)
-- ==========================================

-- 啟用每張表的 RLS
ALTER TABLE public.product_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.private_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.private_order_items ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------
-- 4a. 讀取權限策略：所有登入的使用者 (Owner, Staff, Viewer, Helper) 皆可讀取
-- ------------------------------------------
CREATE POLICY select_policy ON public.product_groups FOR SELECT TO authenticated USING (true);
CREATE POLICY select_policy ON public.product_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY select_policy ON public.product_variants FOR SELECT TO authenticated USING (true);
CREATE POLICY select_policy ON public.purchase_batches FOR SELECT TO authenticated USING (true);
CREATE POLICY select_policy ON public.purchase_batch_items FOR SELECT TO authenticated USING (true);
CREATE POLICY select_policy ON public.private_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY select_policy ON public.private_order_items FOR SELECT TO authenticated USING (true);

-- ------------------------------------------
-- 4b. 寫入權限策略：僅有 Owner 與 Staff 可以進行 INSERT / UPDATE / DELETE 寫入
-- ------------------------------------------
CREATE POLICY modify_policy ON public.product_groups
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')))
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')));

CREATE POLICY modify_policy ON public.product_categories
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')))
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')));

CREATE POLICY modify_policy ON public.product_variants
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')))
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')));

CREATE POLICY modify_policy ON public.purchase_batches
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')))
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')));

CREATE POLICY modify_policy ON public.purchase_batch_items
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')))
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')));

CREATE POLICY modify_policy ON public.private_orders
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')))
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')));

CREATE POLICY modify_policy ON public.private_order_items
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')))
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('owner', 'staff')));
