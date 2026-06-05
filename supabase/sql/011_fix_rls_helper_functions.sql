-- =========================================================================
-- 小河馬採購工作台 - 修正 RLS 角色判定輔助函數 (profiles.user_id 欄位修正)
-- 檔案名稱: 011_fix_rls_helper_functions.sql
-- 
-- 【說明】
-- 1. 之前定義的 RLS 輔助函數在 public.profiles 表中錯誤地使用 id 欄位與 auth.uid() 進行比對。
-- 2. 由於 profiles.id 是隨機產生的 UUID，而真正的 Supabase Auth 使用者 ID 儲存在 profiles.user_id，
--    導致所有 RLS 判定函數 (is_owner, is_owner_or_staff, is_editor) 全數回傳 false。
-- 3. 本檔案將這 3 個輔助函數修正為比對 profiles.user_id。
-- =========================================================================

-- 1. 修正 is_owner 函數
CREATE OR REPLACE FUNCTION public.is_owner(u_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = u_id AND role = 'owner'
  );
$$;

-- 2. 修正 is_owner_or_staff 函數
CREATE OR REPLACE FUNCTION public.is_owner_or_staff(u_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = u_id AND role IN ('owner', 'staff')
  );
$$;

-- 3. 修正 is_editor 函數
CREATE OR REPLACE FUNCTION public.is_editor(u_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE user_id = u_id AND role IN ('owner', 'staff', 'helper')
  );
$$;

-- 重點提示：請複製上述內容至 Supabase SQL Editor 中執行以修正資料庫權限判定。
