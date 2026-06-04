-- =========================================================================
-- 小河馬採購工作台 - 建立首頁圖片同步表與 RLS 政策 (Phase 3-H-2)
-- 檔案名稱: 006_dashboard_category_images.sql
-- =========================================================================

-- ==========================================
-- 0. 公用判定輔助函數與觸發器 (SECURITY DEFINER 以防止 RLS 遞迴，對齊 profiles.id)
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

-- 判斷是否為 Owner 或 Staff
CREATE OR REPLACE FUNCTION public.is_owner_or_staff(u_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = u_id AND role IN ('owner', 'staff')
  );
$$;

-- 自動更新欄位觸發器函數 (若尚未存在則建立)
CREATE OR REPLACE FUNCTION public.sync_audit_columns()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    NEW.version = OLD.version + 1;
    
    IF auth.uid() IS NOT NULL THEN
        NEW.updated_by = auth.uid();
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ==========================================
-- 1. 建立 dashboard_category_images 首頁圖片同步表
-- ==========================================
CREATE TABLE IF NOT EXISTS public.dashboard_category_images (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category_key       text NOT NULL UNIQUE,
    image_url          text,
    storage_path       text,
    
    -- 同步與審查欄位
    local_id           text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at         timestamptz,
    version            integer NOT NULL DEFAULT 1,
    sync_status        text NOT NULL DEFAULT 'synced'
);

-- ==========================================
-- 2. 綁定自動更新時間觸發器
-- ==========================================
DROP TRIGGER IF EXISTS trigger_update_dashboard_category_images_audit ON public.dashboard_category_images;
CREATE TRIGGER trigger_update_dashboard_category_images_audit BEFORE UPDATE ON public.dashboard_category_images FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ==========================================
-- 3. 建立效能與唯一約束索引
-- ==========================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_category_images_key ON public.dashboard_category_images(category_key);
CREATE INDEX IF NOT EXISTS idx_dashboard_category_images_active ON public.dashboard_category_images(id) WHERE deleted_at IS NULL;

-- ==========================================
-- 4. 啟用 RLS 行級安全設定
-- ==========================================
ALTER TABLE public.dashboard_category_images ENABLE ROW LEVEL SECURITY;

-- ==========================================
-- 5. 設定 RLS Policies (讀寫隔離政策)
-- ==========================================

DROP POLICY IF EXISTS select_policy ON public.dashboard_category_images;
CREATE POLICY select_policy ON public.dashboard_category_images FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.dashboard_category_images;
CREATE POLICY insert_policy ON public.dashboard_category_images FOR INSERT TO authenticated WITH CHECK (public.is_owner_or_staff(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.dashboard_category_images;
CREATE POLICY update_policy ON public.dashboard_category_images FOR UPDATE TO authenticated USING (public.is_owner_or_staff(auth.uid())) WITH CHECK (public.is_owner_or_staff(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.dashboard_category_images;
CREATE POLICY delete_policy ON public.dashboard_category_images FOR DELETE TO authenticated USING (public.is_owner_or_staff(auth.uid()));
