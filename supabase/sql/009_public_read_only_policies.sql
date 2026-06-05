-- =========================================================================
-- 小河馬採購工作台 - SQL Migration
-- 檔案名稱: 009_public_read_only_policies.sql
-- 
-- 【說明】
-- 允許未登入帳號 (anon/public) 可以 SELECT 讀取非敏感商品主檔與採購批次。
-- 寫入權限 (INSERT/UPDATE/DELETE) 維持僅限 Owner/Staff/Helper。
-- 私下訂單、銷售訂單等敏感資安資料維持僅限已登入者 (authenticated) 讀取。
-- =========================================================================

-- A. product_groups
DROP POLICY IF EXISTS select_policy ON public.product_groups;
CREATE POLICY select_policy ON public.product_groups FOR SELECT TO public USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

-- B. product_categories
DROP POLICY IF EXISTS select_policy ON public.product_categories;
CREATE POLICY select_policy ON public.product_categories FOR SELECT TO public USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

-- C. product_variants
DROP POLICY IF EXISTS select_policy ON public.product_variants;
CREATE POLICY select_policy ON public.product_variants FOR SELECT TO public USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

-- D. purchase_batches
DROP POLICY IF EXISTS select_policy ON public.purchase_batches;
CREATE POLICY select_policy ON public.purchase_batches FOR SELECT TO public USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

-- E. purchase_batch_items
DROP POLICY IF EXISTS select_policy ON public.purchase_batch_items;
CREATE POLICY select_policy ON public.purchase_batch_items FOR SELECT TO public USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

-- F. dashboard_category_images
DROP POLICY IF EXISTS select_policy ON public.dashboard_category_images;
CREATE POLICY select_policy ON public.dashboard_category_images FOR SELECT TO public USING (deleted_at IS NULL OR public.is_owner(auth.uid()));
