-- =========================================================================
-- 小河馬採購工作台 - 庫存主檔雲端同步資料表 (inventory_items) - 安全版本
-- 檔案名稱: 010_inventory_items.sql
-- 
-- 【說明】
-- 本檔案在 Supabase 建立庫存主檔資料表，以支援跨裝置/新瀏覽器的買動漫需求計算：
-- 1. 建立 public.inventory_items 資料表與對應欄位，使用 myacg_item_code 作為 PRIMARY KEY。
-- 2. 啟用 RLS 並套用 is_owner_or_staff 安全政策。
-- =========================================================================

-- 1. 建立資料表
CREATE TABLE IF NOT EXISTS public.inventory_items (
    myacg_item_code             text PRIMARY KEY,
    product_id                  text,
    product_title               text NOT NULL,
    normalized_product_title    text,
    raw_variant_name            text,
    listing_type                text,
    final_price                 integer DEFAULT 0,
    myacg_available_quantity    integer DEFAULT 0,
    myacg_sold_quantity         integer DEFAULT 0,
    myacg_demand_quantity       integer DEFAULT 0,
    myacg_listed_at             text,
    import_sort_index           integer,
    
    -- 系統欄位
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    updated_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at                  timestamptz,
    version                     integer NOT NULL DEFAULT 1,
    sync_status                 text NOT NULL DEFAULT 'synced'
);

-- 2. 建立效能索引
CREATE INDEX IF NOT EXISTS inventory_items_updated_at_idx ON public.inventory_items (updated_at);

-- 3. 啟用 RLS
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;

-- 4. 套用 RLS 政策 (使用 is_owner_or_staff 安全政策)
DROP POLICY IF EXISTS select_policy ON public.inventory_items;
CREATE POLICY select_policy ON public.inventory_items FOR SELECT TO authenticated 
    USING (deleted_at IS NULL OR public.is_owner(auth.uid()));

DROP POLICY IF EXISTS insert_policy ON public.inventory_items;
CREATE POLICY insert_policy ON public.inventory_items FOR INSERT TO authenticated 
    WITH CHECK (public.is_owner_or_staff(auth.uid()));

DROP POLICY IF EXISTS update_policy ON public.inventory_items;
CREATE POLICY update_policy ON public.inventory_items FOR UPDATE TO authenticated 
    USING (public.is_owner_or_staff(auth.uid())) 
    WITH CHECK (public.is_owner_or_staff(auth.uid()));

DROP POLICY IF EXISTS delete_policy ON public.inventory_items;
CREATE POLICY delete_policy ON public.inventory_items FOR DELETE TO authenticated 
    USING (public.is_owner_or_staff(auth.uid()));
