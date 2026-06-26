-- ==========================================
-- 小河馬採購工作台 - 日本包裹管理資料表
-- 檔案名稱: 015_japan_packages_tables.sql
-- ==========================================

-- 1. 建立 japan_packages 資料表
CREATE TABLE IF NOT EXISTS public.japan_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    vendor_name TEXT,
    carrier TEXT,
    tracking_number TEXT,
    shipped_at DATE,
    expected_arrival_at DATE,
    arrived_at DATE,
    status TEXT NOT NULL DEFAULT 'registered',
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 啟用 RLS
ALTER TABLE public.japan_packages ENABLE ROW LEVEL SECURITY;

-- 建立 RLS Policy (與現有 RLS 邏輯一致：Viewer 唯讀非刪除資料，Editor 可編輯)
DROP POLICY IF EXISTS select_policy ON public.japan_packages;
CREATE POLICY select_policy ON public.japan_packages FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.japan_packages;
CREATE POLICY insert_policy ON public.japan_packages FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.japan_packages;
CREATE POLICY update_policy ON public.japan_packages FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.japan_packages;
CREATE POLICY delete_policy ON public.japan_packages FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- 2. 建立 japan_package_items 資料表
CREATE TABLE IF NOT EXISTS public.japan_package_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    japan_package_id UUID NOT NULL REFERENCES public.japan_packages(id) ON DELETE CASCADE,
    product_group_id UUID,
    product_variant_id UUID,
    purchase_batch_id UUID,
    purchase_batch_item_id UUID,
    product_title TEXT,
    category_name TEXT,
    variant_name TEXT,
    sku TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    checked BOOLEAN NOT NULL DEFAULT FALSE,
    checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 啟用 RLS
ALTER TABLE public.japan_package_items ENABLE ROW LEVEL SECURITY;

-- 建立 RLS Policy
DROP POLICY IF EXISTS select_policy ON public.japan_package_items;
CREATE POLICY select_policy ON public.japan_package_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.japan_package_items;
CREATE POLICY insert_policy ON public.japan_package_items FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.japan_package_items;
CREATE POLICY update_policy ON public.japan_package_items FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.japan_package_items;
CREATE POLICY delete_policy ON public.japan_package_items FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));
