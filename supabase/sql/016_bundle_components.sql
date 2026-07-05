-- ==========================================
-- 小河馬採購工作台 - 套組子商品關聯表
-- 檔案名稱: 016_bundle_components.sql
-- ==========================================

-- 1. 建立 bundle_components 資料表
CREATE TABLE IF NOT EXISTS public.bundle_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bundle_variant_id UUID NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
    component_variant_id UUID NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 啟用 RLS
ALTER TABLE public.bundle_components ENABLE ROW LEVEL SECURITY;

-- 建立 RLS Policy (與現有 RLS 邏輯一致：Viewer 唯讀，Editor 可編輯)
DROP POLICY IF EXISTS select_policy ON public.bundle_components;
CREATE POLICY select_policy ON public.bundle_components FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS insert_policy ON public.bundle_components;
CREATE POLICY insert_policy ON public.bundle_components FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.bundle_components;
CREATE POLICY update_policy ON public.bundle_components FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.bundle_components;
CREATE POLICY delete_policy ON public.bundle_components FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));
