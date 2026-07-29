-- ==========================================
-- 小河馬採購工作台 - 出庫管理資料表
-- 檔案名稱: 017_outbound_shipments.sql
-- ==========================================

-- 1. 建立 outbound_shipments 資料表
CREATE TABLE IF NOT EXISTS public.outbound_shipments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    carrier TEXT,
    tracking_number TEXT,
    weight_kg NUMERIC,
    shipping_cost NUMERIC,
    shipped_at DATE,
    received_at DATE,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

ALTER TABLE public.outbound_shipments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_policy ON public.outbound_shipments;
CREATE POLICY select_policy ON public.outbound_shipments FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.outbound_shipments;
CREATE POLICY insert_policy ON public.outbound_shipments FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.outbound_shipments;
CREATE POLICY update_policy ON public.outbound_shipments FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.outbound_shipments;
CREATE POLICY delete_policy ON public.outbound_shipments FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));

-- 2. 建立 outbound_shipment_items 資料表
CREATE TABLE IF NOT EXISTS public.outbound_shipment_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outbound_shipment_id UUID NOT NULL REFERENCES public.outbound_shipments(id) ON DELETE CASCADE,
    japan_package_item_id UUID,
    product_group_id UUID,
    product_variant_id UUID,
    product_title TEXT,
    variant_name TEXT,
    sku TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    checked BOOLEAN NOT NULL DEFAULT FALSE,
    checked_at TIMESTAMPTZ,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

ALTER TABLE public.outbound_shipment_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS select_policy ON public.outbound_shipment_items;
CREATE POLICY select_policy ON public.outbound_shipment_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.outbound_shipment_items;
CREATE POLICY insert_policy ON public.outbound_shipment_items FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.outbound_shipment_items;
CREATE POLICY update_policy ON public.outbound_shipment_items FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.outbound_shipment_items;
CREATE POLICY delete_policy ON public.outbound_shipment_items FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));

-- 3. 建立索引
CREATE INDEX IF NOT EXISTS idx_outbound_shipments_status ON public.outbound_shipments(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_shipments_deleted_at ON public.outbound_shipments(deleted_at);
CREATE INDEX IF NOT EXISTS idx_outbound_shipment_items_shipment_id ON public.outbound_shipment_items(outbound_shipment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_shipment_items_jp_item_id ON public.outbound_shipment_items(japan_package_item_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_shipment_items_deleted_at ON public.outbound_shipment_items(deleted_at);
