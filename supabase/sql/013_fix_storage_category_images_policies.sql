-- =========================================================================
-- 小河馬採購工作台 - 修正 Storage RLS 政策 (Phase 3-H-4)
-- 檔案名稱: 013_fix_storage_category_images_policies.sql
-- 
-- 【說明】
-- 1. 之前定義的 storage.objects 上傳與修改政策調用了 public.is_owner_or_staff(auth.uid()) 函數。
-- 2. 在 Supabase Storage 服務的執行環境中，跨 schema 調用 public 函數可能因為權限或 context 原因
--    導致判定失敗，拋出 "new row violates row-level security policy" 錯誤。
-- 3. 本檔案將 RLS 政策改為「直接查詢 public.profiles 表」，不依賴 helper function，確保 100% 相容與穩定。
-- =========================================================================

-- 1. 清理舊的 Storage 政策
DROP POLICY IF EXISTS "Owner/Staff can upload to dashboard-category-images" ON storage.objects;
DROP POLICY IF EXISTS "Owner/Staff can update in dashboard-category-images" ON storage.objects;
DROP POLICY IF EXISTS "Owner/Staff can delete from dashboard-category-images" ON storage.objects;

-- 2. 建立新上傳政策：只有登入且在 public.profiles 中角色為 owner/staff 的使用者可上傳
CREATE POLICY "Owner/Staff can upload to dashboard-category-images" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'dashboard-category-images' 
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() AND role IN ('owner', 'staff')
    )
  )
);

-- 3. 建立新更新政策：只有登入且在 public.profiles 中角色為 owner/staff 的使用者可更新
CREATE POLICY "Owner/Staff can update in dashboard-category-images" ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'dashboard-category-images' 
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() AND role IN ('owner', 'staff')
    )
  )
)
WITH CHECK (
  bucket_id = 'dashboard-category-images' 
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() AND role IN ('owner', 'staff')
    )
  )
);

-- 4. 建立新刪除政策：只有登入且在 public.profiles 中角色為 owner/staff 的使用者可刪除
CREATE POLICY "Owner/Staff can delete from dashboard-category-images" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'dashboard-category-images' 
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() AND role IN ('owner', 'staff')
    )
  )
);
