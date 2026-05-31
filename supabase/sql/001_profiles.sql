-- =========================================================================
-- 小河馬採購工作台 - 雲端化資料表 DDL 安全審查版 (Phase 2-C-Review)
-- 檔案名稱: 001_profiles.sql
-- 
-- 【說明】
-- 1. 本檔案為經過安全審查之 SQL 部署草案，**需手動複製到 Supabase SQL Editor 執行**。
-- 2. 執行前請確認已備份所有雲端與本地端資料。
-- 3. 本檔案在純本地模式 (Local Mode) 下不會對系統運作造成任何影響。
-- 4. 已修正安全性漏洞：為 SECURITY DEFINER 函數設定顯式 search_path。
-- 5. 已修正 RLS 效能漏洞：移除可能引起無限遞迴的 UPDATE 子查詢政策，改為更保守的安全限制。
-- =========================================================================

-- 1. 建立角色 ENUM 型態 (若未存在)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('owner', 'staff', 'viewer', 'helper');
    END IF;
END$$;

-- 2. 建立 profiles 資料表 (與 Supabase auth.users 綁定)
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email text NOT NULL,
    display_name text,
    role user_role NOT NULL DEFAULT 'viewer',
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz,
    
    -- 保留約束
    CONSTRAINT email_format_check CHECK (email ~* '^[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,4}$')
);

-- 3. 自動更新 updated_at 欄位的 Trigger 函數與觸發器 (使用 safe schema resolution)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_profiles_updated_at ON public.profiles;
CREATE TRIGGER trigger_update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 4. 當 auth.users 新增帳號時，自動於 public.profiles 建立對應資料的 Trigger 函數
-- 已設定 SECURITY DEFINER 並明確指定 search_path 以防止 Search Path Hijacking (安全漏洞)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name, role, is_active)
  VALUES (
    new.id,
    new.email,
    coalesce(
        new.raw_user_meta_data->>'display_name', 
        new.raw_user_meta_data->>'full_name', 
        split_part(new.email, '@', 1)
    ),
    'viewer', -- 預設為唯讀屬性 viewer，需手動經由 DB/Owner 提升為 staff 或 owner
    true
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 綁定 Trigger 到 auth.users 註冊事件
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 5. 啟用 RLS (Row Level Security) 行級安全性
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 6. RLS Policies (行級安全政策)
-- 6a. 讀取政策：使用者可以讀取自己的 profile (安全)
DROP POLICY IF EXISTS "Users can read their own profile" ON public.profiles;
CREATE POLICY "Users can read their own profile" 
ON public.profiles 
FOR SELECT 
TO authenticated
USING (auth.uid() = user_id);

-- 6b. 修改政策：保守版本
-- 為了安全起見，暫時禁止一般使用者自行 UPDATE 任何 profile 欄位 (包括 display_name)。
-- 這能避免 UPDATE 子查詢在 RLS 中評估時引起效能低落或無限遞迴 (Infinite Recursion) 的問題。
-- 若要修改名稱，初期可直接由資料庫管理員手動修改，或留待後續 Phase 實作 Owner 專用管理頁面。

-- 6c. Owner 專用管理政策 (初期保留，可在系統初始化第一個 Owner 後取消註解啟用)
-- DROP POLICY IF EXISTS "Owners can manage all profiles" ON public.profiles;
-- CREATE POLICY "Owners can manage all profiles"
-- ON public.profiles
-- FOR ALL
-- TO authenticated
-- USING (
--   EXISTS (
--     SELECT 1 FROM public.profiles
--     WHERE user_id = auth.uid() AND role = 'owner'
--   )
-- );
