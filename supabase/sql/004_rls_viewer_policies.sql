-- =========================================================================
-- 小河馬採購工作台 - RLS 安全政策修正 (Viewer 讀取與編輯權限優化)
-- 檔案名稱: 004_rls_viewer_policies.sql
-- 
-- 【說明】
-- 本檔案修正所有雲端同步資料表之 RLS Policy：
-- 1. 允許任何登入帳號 (含 Viewer，即使無 Role) SELECT 讀取所有 deleted_at IS NULL 的資料。
-- 2. 限制僅限 owner, staff, helper 角色可以寫入、更新與刪除 (INSERT/UPDATE/DELETE)。
-- 3. 限制僅限 owner 角色可以讀取軟刪除資料 (deleted_at IS NOT NULL)。
-- 
-- 請複製以下內容直接在 Supabase SQL Editor 中執行。
-- =========================================================================

-- ==========================================
-- 0. 定義安全的角色判定函數 (SECURITY DEFINER 以防止 RLS 遞迴)
-- ==========================================

-- 判斷是否為 Owner
CREATE OR REPLACE FUNCTION public.is_owner(u_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = u_id AND role = 'owner'
  );
$$;

-- 判斷是否為編輯人員 (Owner / Staff / Helper)
CREATE OR REPLACE FUNCTION public.is_editor(u_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = u_id AND role IN ('owner', 'staff', 'helper')
  );
$$;

-- ==========================================
-- 1. 重新套用 10 張資料表之 RLS 安全政策
-- ==========================================

-- A. product_groups
DROP POLICY IF EXISTS select_policy ON public.product_groups;
CREATE POLICY select_policy ON public.product_groups FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.product_groups;
CREATE POLICY insert_policy ON public.product_groups FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.product_groups;
CREATE POLICY update_policy ON public.product_groups FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.product_groups;
CREATE POLICY delete_policy ON public.product_groups FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- B. product_categories
DROP POLICY IF EXISTS select_policy ON public.product_categories;
CREATE POLICY select_policy ON public.product_categories FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.product_categories;
CREATE POLICY insert_policy ON public.product_categories FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.product_categories;
CREATE POLICY update_policy ON public.product_categories FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.product_categories;
CREATE POLICY delete_policy ON public.product_categories FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- C. product_variants
DROP POLICY IF EXISTS select_policy ON public.product_variants;
CREATE POLICY select_policy ON public.product_variants FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.product_variants;
CREATE POLICY insert_policy ON public.product_variants FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.product_variants;
CREATE POLICY update_policy ON public.product_variants FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.product_variants;
CREATE POLICY delete_policy ON public.product_variants FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- D. sales_orders
DROP POLICY IF EXISTS select_policy ON public.sales_orders;
CREATE POLICY select_policy ON public.sales_orders FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.sales_orders;
CREATE POLICY insert_policy ON public.sales_orders FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.sales_orders;
CREATE POLICY update_policy ON public.sales_orders FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.sales_orders;
CREATE POLICY delete_policy ON public.sales_orders FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- E. sales_order_items
DROP POLICY IF EXISTS select_policy ON public.sales_order_items;
CREATE POLICY select_policy ON public.sales_order_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.sales_order_items;
CREATE POLICY insert_policy ON public.sales_order_items FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.sales_order_items;
CREATE POLICY update_policy ON public.sales_order_items FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.sales_order_items;
CREATE POLICY delete_policy ON public.sales_order_items FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- F. purchase_batches
DROP POLICY IF EXISTS select_policy ON public.purchase_batches;
CREATE POLICY select_policy ON public.purchase_batches FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.purchase_batches;
CREATE POLICY insert_policy ON public.purchase_batches FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.purchase_batches;
CREATE POLICY update_policy ON public.purchase_batches FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.purchase_batches;
CREATE POLICY delete_policy ON public.purchase_batches FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- G. purchase_batch_items
DROP POLICY IF EXISTS select_policy ON public.purchase_batch_items;
CREATE POLICY select_policy ON public.purchase_batch_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.purchase_batch_items;
CREATE POLICY insert_policy ON public.purchase_batch_items FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.purchase_batch_items;
CREATE POLICY update_policy ON public.purchase_batch_items FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.purchase_batch_items;
CREATE POLICY delete_policy ON public.purchase_batch_items FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- H. private_orders
DROP POLICY IF EXISTS select_policy ON public.private_orders;
CREATE POLICY select_policy ON public.private_orders FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.private_orders;
CREATE POLICY insert_policy ON public.private_orders FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.private_orders;
CREATE POLICY update_policy ON public.private_orders FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.private_orders;
CREATE POLICY delete_policy ON public.private_orders FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- I. private_order_items
DROP POLICY IF EXISTS select_policy ON public.private_order_items;
CREATE POLICY select_policy ON public.private_order_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.private_order_items;
CREATE POLICY insert_policy ON public.private_order_items FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.private_order_items;
CREATE POLICY update_policy ON public.private_order_items FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.private_order_items;
CREATE POLICY delete_policy ON public.private_order_items FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));


-- J. dashboard_category_images
DROP POLICY IF EXISTS select_policy ON public.dashboard_category_images;
CREATE POLICY select_policy ON public.dashboard_category_images FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.dashboard_category_images;
CREATE POLICY insert_policy ON public.dashboard_category_images FOR INSERT TO authenticated WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.dashboard_category_images;
CREATE POLICY update_policy ON public.dashboard_category_images FOR UPDATE TO authenticated USING (public.is_editor(auth.uid())) WITH CHECK (public.is_editor(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.dashboard_category_images;
CREATE POLICY delete_policy ON public.dashboard_category_images FOR DELETE TO authenticated USING (public.is_editor(auth.uid()));
