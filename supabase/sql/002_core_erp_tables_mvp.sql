-- =========================================================================
-- 小河馬採購工作台 - 訂購紀錄核心雲端同步 SQL 審查修正版 (Phase 3-C-MVP)
-- 檔案名稱: 002_core_erp_tables_mvp.sql
-- 
-- 【說明】
-- 1. 本檔案為經安全與效能審查（Review）修正後之 MVP 核心 DDL 部署版本。
-- 2. 修正重點：
--    - 建立 SECURITY DEFINER 輔助函數以避免 RLS 查詢 `profiles` 時發生遞迴與效能低落。
--    - 修改 SELECT 政策：預設僅能檢視 `deleted_at IS NULL` 的資料（Owner 例外可看全部）。
--    - 拆分 modify_policy 為 INSERT、UPDATE、DELETE 政策，權限邊界更清晰。
--    - DELETE 限制：一般 Staff 僅能透過 UPDATE 將 `deleted_at` 設為非空（軟刪除），
--      物理刪除（DELETE）僅限角色為 `owner` 的使用者。
--    - 建立 `sync_audit_columns` trigger，在 UPDATE 時自動累加 `version`、
--      更新 `updated_at` 並記錄 `updated_by = auth.uid()`。
-- 3. **請手動複製到 Supabase SQL Editor 執行，請勿直接修改程式**。
-- =========================================================================

-- ==========================================
-- 0. 公用輔助函數與審查觸發器
-- ==========================================

-- 讀取角色輔助函數 (使用 SECURITY DEFINER 並限定 search_path 以免 RLS 造成遞迴)
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS public.user_role
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT role FROM public.profiles WHERE user_id = auth.uid();
$$;

-- 審查欄位自動更新觸發器函數
CREATE OR REPLACE FUNCTION public.sync_audit_columns()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    NEW.version = OLD.version + 1;
    
    -- 若是透過 API 用戶端修改，自動記錄操作者 UUID
    -- 若為 SQL Editor 或 Migration 工具（auth.uid() 為空），則保留傳入的原始數值
    IF auth.uid() IS NOT NULL THEN
        NEW.updated_by = auth.uid();
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ==========================================
-- 1. 建立 7 張核心資料表
-- ==========================================

-- A. 商品群組 (Product Group)
CREATE TABLE IF NOT EXISTS public.product_groups (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title              text NOT NULL,
    normalized_title   text,
    listing_type       text,
    priority           text NOT NULL DEFAULT 'Medium' CONSTRAINT priority_check CHECK (priority IN ('High', 'Medium', 'Low')),
    purchase_date      date,
    closing_date       date,
    release_month      text,
    has_official_site  boolean NOT NULL DEFAULT false,
    product_url        text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- B. 商品分類 (Product Category)
CREATE TABLE IF NOT EXISTS public.product_categories (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    title            text NOT NULL,
    sort_order       integer NOT NULL DEFAULT 0,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- C. 商品規格明細 (Product Variant)
CREATE TABLE IF NOT EXISTS public.product_variants (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id          uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    product_category_id       uuid REFERENCES public.product_categories(id) ON DELETE SET NULL,
    myacg_item_code           text NOT NULL, -- MVP 階段改為純文字儲存，不建立與 inventory 表的外鍵約束
    product_title             text NOT NULL,
    variant_name              text NOT NULL,
    raw_variant_name          text,
    myacg_auto_quantity       integer NOT NULL DEFAULT 0,
    effective_myacg_quantity   integer NOT NULL DEFAULT 0,
    waca_auto_quantity        integer NOT NULL DEFAULT 0,
    note                      text NOT NULL DEFAULT '',
    sort_order                integer NOT NULL DEFAULT 0,
    catalog_missing           boolean NOT NULL DEFAULT false,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- D. 採購批次單頭 (Purchase Batch)
CREATE TABLE IF NOT EXISTS public.purchase_batches (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    name             text NOT NULL,
    date             date,
    note             text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- E. 採購批次明細 (Purchase Batch Item)
CREATE TABLE IF NOT EXISTS public.purchase_batch_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_batch_id  uuid NOT NULL REFERENCES public.purchase_batches(id) ON DELETE CASCADE,
    product_variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
    quantity           integer NOT NULL DEFAULT 0,
    cost               numeric(12, 2) NOT NULL DEFAULT 0,
    note               text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- F. 私下登記單頭 (Private Order)
CREATE TABLE IF NOT EXISTS public.private_orders (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE,
    customer_name    text NOT NULL,
    contact          text,
    note             text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- G. 私下登記明細 (Private Order Item)
CREATE TABLE IF NOT EXISTS public.private_order_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    private_order_id   uuid NOT NULL REFERENCES public.private_orders(id) ON DELETE CASCADE,
    product_variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
    quantity           integer NOT NULL DEFAULT 0,
    amount             numeric(12, 2) NOT NULL DEFAULT 0,
    note               text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1
);

-- ==========================================
-- 2. 觸發器綁定：自動累加 Version、更新時間與操作人
-- ==========================================
CREATE TRIGGER trigger_update_product_groups_audit BEFORE UPDATE ON public.product_groups FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
CREATE TRIGGER trigger_update_product_categories_audit BEFORE UPDATE ON public.product_categories FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
CREATE TRIGGER trigger_update_product_variants_audit BEFORE UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
CREATE TRIGGER trigger_update_purchase_batches_audit BEFORE UPDATE ON public.purchase_batches FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
CREATE TRIGGER trigger_update_purchase_batch_items_audit BEFORE UPDATE ON public.purchase_batch_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
CREATE TRIGGER trigger_update_private_orders_audit BEFORE UPDATE ON public.private_orders FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();
CREATE TRIGGER trigger_update_private_order_items_audit BEFORE UPDATE ON public.private_order_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ==========================================
-- 3. 效能索引優化
-- ==========================================

-- A. 外鍵索引 (Foreign Key Indexes)
CREATE INDEX IF NOT EXISTS idx_product_categories_group_id ON public.product_categories(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_group_id ON public.product_variants(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_category_id ON public.product_variants(product_category_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_group_id ON public.purchase_batches(product_group_id);
CREATE INDEX If NOT EXISTS idx_purchase_batch_items_batch_id ON public.purchase_batch_items(purchase_batch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_variant_id ON public.purchase_batch_items(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_private_orders_group_id ON public.private_orders(product_group_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_order_id ON public.private_order_items(private_order_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_variant_id ON public.private_order_items(product_variant_id);

-- B. 搜尋性能與軟刪除索引 (Partial Indexes - 排除已軟刪除資料以加快查詢)
CREATE INDEX IF NOT EXISTS idx_product_groups_active ON public.product_groups(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_product_variants_active ON public.product_variants(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_batches_active ON public.purchase_batches(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_private_orders_active ON public.private_orders(id) WHERE deleted_at IS NULL;

-- C. 本地 IDB 與雲端同步加速索引 (local_id Lookups)
CREATE INDEX IF NOT EXISTS idx_product_groups_local_id ON public.product_groups(local_id);
CREATE INDEX IF NOT EXISTS idx_product_categories_local_id ON public.product_categories(local_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_local_id ON public.product_variants(local_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_local_id ON public.purchase_batches(local_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_local_id ON public.purchase_batch_items(local_id);
CREATE INDEX IF NOT EXISTS idx_private_orders_local_id ON public.private_orders(local_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_local_id ON public.private_order_items(local_id);

-- ==========================================
-- 4. 行級安全策略 (Row Level Security - RLS)
-- ==========================================

-- 啟用每張表的 RLS
ALTER TABLE public.product_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.private_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.private_order_items ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------
-- 4a. SELECT 政策：一般使用者僅能查詢「未軟刪除 (deleted_at IS NULL)」的資料，Owner 則不受此限。
-- ------------------------------------------
CREATE POLICY select_policy ON public.product_groups FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');
CREATE POLICY select_policy ON public.product_categories FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');
CREATE POLICY select_policy ON public.product_variants FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');
CREATE POLICY select_policy ON public.purchase_batches FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');
CREATE POLICY select_policy ON public.purchase_batch_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');
CREATE POLICY select_policy ON public.private_orders FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');
CREATE POLICY select_policy ON public.private_order_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

-- ------------------------------------------
-- 4b. INSERT 政策：僅限 Owner 與 Staff 寫入
-- ------------------------------------------
CREATE POLICY insert_policy ON public.product_groups FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY insert_policy ON public.product_categories FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY insert_policy ON public.product_variants FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY insert_policy ON public.purchase_batches FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY insert_policy ON public.purchase_batch_items FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY insert_policy ON public.private_orders FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY insert_policy ON public.private_order_items FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

-- ------------------------------------------
-- 4c. UPDATE 政策：僅限 Owner 與 Staff 更新（包含將 deleted_at 設為現在時間以執行軟刪除）
-- ------------------------------------------
CREATE POLICY update_policy ON public.product_groups FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY update_policy ON public.product_categories FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY update_policy ON public.product_variants FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY update_policy ON public.purchase_batches FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY update_policy ON public.purchase_batch_items FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY update_policy ON public.private_orders FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));
CREATE POLICY update_policy ON public.private_order_items FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

-- ------------------------------------------
-- 4d. DELETE 政策：實體物理刪除 (Hard Delete) 嚴格限制僅限 Owner 可執行
-- ------------------------------------------
CREATE POLICY delete_policy ON public.product_groups FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
CREATE POLICY delete_policy ON public.product_categories FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
CREATE POLICY delete_policy ON public.product_variants FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
CREATE POLICY delete_policy ON public.purchase_batches FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
CREATE POLICY delete_policy ON public.purchase_batch_items FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
CREATE POLICY delete_policy ON public.private_orders FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
CREATE POLICY delete_policy ON public.private_order_items FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
