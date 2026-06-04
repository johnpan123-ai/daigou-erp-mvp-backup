-- =========================================================================
-- 小河馬採購工作台 - 銷售訂單同步 DDL (Phase 3-G-2-MVP)
-- 檔案名稱: 005_sales_orders_sync.sql
-- =========================================================================

-- 1. 建立 sales_orders
CREATE TABLE IF NOT EXISTS public.sales_orders (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform           text NOT NULL,
    order_number       text NOT NULL UNIQUE,
    buyer_name         text NOT NULL,
    
    -- 同步與審查欄位
    local_id           text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at         timestamptz,
    version            integer NOT NULL DEFAULT 1,
    sync_status        text NOT NULL DEFAULT 'synced'
);

-- 2. 建立 sales_order_items (無 inventory 外鍵限制)
CREATE TABLE IF NOT EXISTS public.sales_order_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
    product_variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL,
    myacg_item_code    text NOT NULL, -- 無 inventory 外鍵約束
    product_name       text,
    variant_name       text,
    quantity           integer NOT NULL DEFAULT 0,
    price              numeric(12, 2) DEFAULT 0,
    amount             numeric(12, 2) DEFAULT 0,
    order_status       text,
    
    -- 同步與審查欄位
    local_id           text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at         timestamptz,
    version            integer NOT NULL DEFAULT 1,
    sync_status        text NOT NULL DEFAULT 'synced'
);

-- 3. 綁定自動更新時間觸發器 (sync_audit_columns)
DROP TRIGGER IF EXISTS trigger_update_sales_orders_audit ON public.sales_orders;
CREATE TRIGGER trigger_update_sales_orders_audit BEFORE UPDATE ON public.sales_orders FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

DROP TRIGGER IF EXISTS trigger_update_sales_order_items_audit ON public.sales_order_items;
CREATE TRIGGER trigger_update_sales_order_items_audit BEFORE UPDATE ON public.sales_order_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- 4. 建立效能與同步索引
CREATE INDEX IF NOT EXISTS idx_sales_orders_order_number ON public.sales_orders(order_number);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_order_id ON public.sales_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_variant_id ON public.sales_order_items(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_sales_orders_local_id ON public.sales_orders(local_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_items_local_id ON public.sales_order_items(local_id);
CREATE INDEX IF NOT EXISTS idx_sales_orders_active ON public.sales_orders(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_order_items_active ON public.sales_order_items(id) WHERE deleted_at IS NULL;

-- 5. 啟用 RLS
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_order_items ENABLE ROW LEVEL SECURITY;

-- 6. 行級安全策略 (Owner / Viewer 模式)
DROP POLICY IF EXISTS select_policy ON public.sales_orders;
CREATE POLICY select_policy ON public.sales_orders FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS insert_policy ON public.sales_orders;
CREATE POLICY insert_policy ON public.sales_orders FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS update_policy ON public.sales_orders;
CREATE POLICY update_policy ON public.sales_orders FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS delete_policy ON public.sales_orders;
CREATE POLICY delete_policy ON public.sales_orders FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');

DROP POLICY IF EXISTS select_policy ON public.sales_order_items;
CREATE POLICY select_policy ON public.sales_order_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS insert_policy ON public.sales_order_items;
CREATE POLICY insert_policy ON public.sales_order_items FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS update_policy ON public.sales_order_items;
CREATE POLICY update_policy ON public.sales_order_items FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS delete_policy ON public.sales_order_items;
CREATE POLICY delete_policy ON public.sales_order_items FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
