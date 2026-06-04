-- =========================================================================
-- 小河馬採購工作台 - 建立首頁圖片 Storage Bucket 與 RLS 政策 (Phase 3-H-3)
-- 檔案名稱: 007_create_dashboard_category_images_bucket.sql
-- =========================================================================

-- 1. 建立 storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'dashboard-category-images', 
  'dashboard-category-images', 
  true, 
  5242880, -- 5MB
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE 
SET public = true, 
    file_size_limit = 5242880, 
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];

-- 2. 啟用 storage.objects RLS 行級安全設定 (一般預設已啟用，此處作為保險)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 3. 清理舊政策
DROP POLICY IF EXISTS "Public Read Access on dashboard-category-images" ON storage.objects;
DROP POLICY IF EXISTS "Owner/Staff can upload to dashboard-category-images" ON storage.objects;
DROP POLICY IF EXISTS "Owner/Staff can update in dashboard-category-images" ON storage.objects;
DROP POLICY IF EXISTS "Owner/Staff can delete from dashboard-category-images" ON storage.objects;

-- 4. 建立讀取政策：任何人 (包含 public/anon 及 authenticated) 可讀取此 bucket 的圖片物件
CREATE POLICY "Public Read Access on dashboard-category-images" ON storage.objects
FOR SELECT TO public
USING (bucket_id = 'dashboard-category-images');

-- 5. 建立上傳政策：只有登入的 owner/staff 角色可上傳圖片物件
CREATE POLICY "Owner/Staff can upload to dashboard-category-images" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'dashboard-category-images' 
  AND public.is_owner_or_staff(auth.uid())
);

-- 6. 建立更新政策：只有登入的 owner/staff 角色可更新圖片物件
CREATE POLICY "Owner/Staff can update in dashboard-category-images" ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'dashboard-category-images' 
  AND public.is_owner_or_staff(auth.uid())
)
WITH CHECK (
  bucket_id = 'dashboard-category-images' 
  AND public.is_owner_or_staff(auth.uid())
);

-- 7. 建立刪除政策：只有登入的 owner/staff 角色可刪除圖片物件
CREATE POLICY "Owner/Staff can delete from dashboard-category-images" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'dashboard-category-images' 
  AND public.is_owner_or_staff(auth.uid())
);
