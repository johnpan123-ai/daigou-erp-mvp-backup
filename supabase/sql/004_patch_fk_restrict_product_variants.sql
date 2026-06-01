-- =========================================================================
-- 小河馬採購工作台 - 商品規格外鍵 RESTRICT 約束修補 SQL (Phase 3-D-FK-Patch)
-- 檔案名稱: 004_patch_fk_restrict_product_variants.sql
-- 
-- 【說明】
-- 1. 解決原因：Supabase 內現有的 product_variants 資料表已存在，
--    導致 002 DDL 中定義的 ON DELETE RESTRICT 約束未被套用（仍為舊版的 CASCADE）。
-- 2. 本指令檔將動態找出並刪除 product_variants 指向 product_groups 的舊外鍵約束，
--    並重新建立命名為 fk_product_variants_product_group 的 ON DELETE RESTRICT 外鍵。
-- 3. **請手動複製到 Supabase SQL Editor 執行，請勿直接修改程式**。
-- =========================================================================

-- ==========================================
-- 1. 清理可能殘留的測試資料
-- ==========================================
DELETE FROM public.product_variants WHERE myacg_item_code = 'SKU-VERIFY-001';
DELETE FROM public.product_categories WHERE title = '分區頁籤 A';
DELETE FROM public.product_groups WHERE title IN ('驗證測試群組', '驗證測試群組-更新版');

-- ==========================================
-- 2. 動態尋找並刪除舊的外鍵約束 (Idempotent 確保)
-- ==========================================
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN 
        SELECT 
            tc.constraint_name
        FROM 
            information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage AS ccu
              ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
        WHERE tc.table_name = 'product_variants'
          AND tc.table_schema = 'public'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'product_group_id'
          AND ccu.table_name = 'product_groups'
    LOOP
        EXECUTE 'ALTER TABLE public.product_variants DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
        RAISE NOTICE '已成功刪除舊的外鍵約束: %', r.constraint_name;
    END LOOP;
END $$;

-- ==========================================
-- 3. 建立命名的 ON DELETE RESTRICT 外鍵約束
-- ==========================================
ALTER TABLE public.product_variants 
ADD CONSTRAINT fk_product_variants_product_group 
FOREIGN KEY (product_group_id) 
REFERENCES public.product_groups(id) 
ON DELETE RESTRICT;

-- ==========================================
-- 4. 驗證新外鍵約束規則
-- ==========================================
SELECT 
    tc.table_name AS "資料表", 
    tc.constraint_name AS "約束名稱",
    ccu.table_name AS "指向目標表",
    rc.delete_rule AS "刪除規則 (應為 RESTRICT)"
FROM 
    information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints AS rc
      ON rc.constraint_name = tc.constraint_name
WHERE tc.table_name = 'product_variants' 
  AND tc.table_schema = 'public'
  AND tc.constraint_name = 'fk_product_variants_product_group';
