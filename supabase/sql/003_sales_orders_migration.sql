-- =========================================================================
-- 小河馬採購工作台 - 雲端同步資料表補強 SQL 整合版 (Phase 3-I-4)
-- 檔案名稱: 003_sales_orders_migration.sql
-- 
-- 【說明】
-- 本檔案補建以下三張缺失的資料表：
-- 1. public.sales_orders
-- 2. public.sales_order_items
-- 3. public.dashboard_category_images
-- 
-- 請複製以下內容，直接貼到您的 Supabase SQL Editor 中執行。
-- =========================================================================

-- ==========================================
-- 1. 建立銷售訂單單頭 (Sales Order)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.sales_orders (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id           text,
    platform           text NOT NULL,
    order_number       text UNIQUE NOT NULL,
    buyer_name         text,
    
    -- MVP 核心同步與審查欄位
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz null,
    sync_status        text NOT NULL DEFAULT 'synced',
    updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid()
);

-- ==========================================
-- 2. 建立銷售訂單明細 (Sales Order Item)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.sales_order_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id           text,
    order_id           uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
    product_variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL,
    myacg_item_code    text NOT NULL,
    product_name       text,
    variant_name       text,
    quantity           integer NOT NULL DEFAULT 0,
    price              numeric(12, 2) NOT NULL DEFAULT 0,
    amount             numeric(12, 2) NOT NULL DEFAULT 0,
    order_status       text,
    
    -- MVP 核心同步與審查欄位
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz null,
    sync_status        text NOT NULL DEFAULT 'synced',
    updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid()
);

-- ==========================================
-- 3. 建立獨立首頁大類圖片設定表 (Dashboard Category Images)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.dashboard_category_images (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category_key       text UNIQUE NOT NULL,
    image_url          text,
    storage_path       text,
    
    -- MVP 核心同步與審查欄位
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz null,
    sync_status        text NOT NULL DEFAULT 'synced',
    updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid()
);

-- ==========================================
-- 4. 建立自動更新時間戳記觸發器 (綁定公用 sync_audit_columns 觸發器)
-- ==========================================
DROP TRIGGER IF EXISTS trigger_update_sales_orders_audit ON public.sales_orders;
CREATE TRIGGER trigger_update_sales_orders_audit BEFORE UPDATE ON public.sales_orders FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

DROP TRIGGER IF EXISTS trigger_update_sales_order_items_audit ON public.sales_order_items;
CREATE TRIGGER trigger_update_sales_order_items_audit BEFORE UPDATE ON public.sales_order_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

DROP TRIGGER IF EXISTS trigger_update_dashboard_category_images_audit ON public.dashboard_category_images;
CREATE TRIGGER trigger_update_dashboard_category_images_audit BEFORE UPDATE ON public.dashboard_category_images FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ==========================================
-- 5. 效能索引建立
-- ==========================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_orders_order_number ON public.sales_orders(order_number);
CREATE INDEX IF NOT EXISTS idx_sales_orders_deleted_at ON public.sales_orders(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_order_items_order_id ON public.sales_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_deleted_at ON public.sales_order_items(deleted_at) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_category_images_key ON public.dashboard_category_images(category_key);
CREATE INDEX IF NOT EXISTS idx_dashboard_category_images_deleted_at ON public.dashboard_category_images(deleted_at) WHERE deleted_at IS NULL;

-- ==========================================
-- 6. 行級安全策略 (Row Level Security - RLS)
-- ==========================================
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_category_images ENABLE ROW LEVEL SECURITY;

-- 6a. sales_orders RLS 政策
DROP POLICY IF EXISTS select_policy ON public.sales_orders;
CREATE POLICY select_policy ON public.sales_orders
FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS insert_policy ON public.sales_orders;
CREATE POLICY insert_policy ON public.sales_orders
FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff', 'helper'));

DROP POLICY IF EXISTS update_policy ON public.sales_orders;
CREATE POLICY update_policy ON public.sales_orders
FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff', 'helper')) WITH CHECK (public.get_my_role() IN ('owner', 'staff', 'helper'));

DROP POLICY IF EXISTS delete_policy ON public.sales_orders;
CREATE POLICY delete_policy ON public.sales_orders
FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');

-- 6b. sales_order_items RLS 政策
DROP POLICY IF EXISTS select_policy ON public.sales_order_items;
CREATE POLICY select_policy ON public.sales_order_items
FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS insert_policy ON public.sales_order_items;
CREATE POLICY insert_policy ON public.sales_order_items
FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff', 'helper'));

DROP POLICY IF EXISTS update_policy ON public.sales_order_items;
CREATE POLICY update_policy ON public.sales_order_items
FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff', 'helper')) WITH CHECK (public.get_my_role() IN ('owner', 'staff', 'helper'));

DROP POLICY IF EXISTS delete_policy ON public.sales_order_items;
CREATE POLICY delete_policy ON public.sales_order_items
FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');

-- 6c. dashboard_category_images RLS 政策
DROP POLICY IF EXISTS select_policy ON public.dashboard_category_images;
CREATE POLICY select_policy ON public.dashboard_category_images
FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS insert_policy ON public.dashboard_category_images;
CREATE POLICY insert_policy ON public.dashboard_category_images
FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS update_policy ON public.dashboard_category_images;
CREATE POLICY update_policy ON public.dashboard_category_images
FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS delete_policy ON public.dashboard_category_images;
CREATE POLICY delete_policy ON public.dashboard_category_images
FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
