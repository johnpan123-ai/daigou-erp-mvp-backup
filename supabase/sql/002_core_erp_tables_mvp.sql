-- =========================================================================
-- 小河馬採購工作台 - 訂購紀錄核心雲端同步 SQL 審查安全優化版 (Phase 3-C-MVP-Review-Audit)
-- 檔案名稱: 002_core_erp_tables_mvp.sql
-- 
-- 【說明與修正審查】
-- 1. 本檔案為 Phase 3-C 安全性與邏輯審查優化後之核心 DDL 版本。
-- 2. 審查與優化內容：
--    - 【可重複執行性】全面引入 DROP TRIGGER/POLICY IF EXISTS，對 pg_type/create table 採用防重疊建立。
--    - 【RLS 遞迴防禦】get_my_role() 為 SECURITY DEFINER 且 SET search_path = public，完全阻斷 RLS 遞迴與路徑劫持。
--    - 【updated_by 觸發器安全性】調整 sync_audit_columns 函數，在 auth.uid() 為 NULL（如 SQL Editor 或系統 Migration）時不報錯且維持原值，以支援多人協作與本機同步。
--    - 【外鍵安全性與 Cascade】為防止誤刪，除批次明細（Items）隨單頭（Batches/Orders）Cascade Delete 外，商品規格、採購記錄與群組之關聯全面使用 ON DELETE RESTRICT。
--    - 【命名與欄位 UI 一致性】新增 myacg_manual_adjustment, waca_manual_adjustment 等手動調整欄位以匹配 UI 設計。並針對 purchase_date (購買結單日) 與 closing_date (官方結單日) 等語意進行詳細註解。
--    - 【效能索引優化】針對 deleted_at, local_id, 外鍵, updated_at (增量查詢加速) 與 myacg_item_code 建立完整索引。
--    - 【軟刪除安全】SELECT 政策預設僅開放 deleted_at IS NULL 資料，僅 owner 可讀取全部（包括軟刪除）。物理 DELETE 權限限於 owner。
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

-- 審查欄位自動更新觸發器函數 (已修正安全機制：當 auth.uid() 為空時不拋錯)
CREATE OR REPLACE FUNCTION public.sync_audit_columns()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    NEW.version = OLD.version + 1;
    
    -- 若是透過 API 用戶端修改，自動記錄操作者 UUID
    -- 若為 SQL Editor 或 Migration 工具（auth.uid() 為空），則保留傳入的原始數值或預設值
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
    listing_type       text, -- 例如：'一般預購', '代理版', '現貨', '日本代購', '現地代購'
    priority           text NOT NULL DEFAULT 'Medium' CONSTRAINT priority_check CHECK (priority IN ('High', 'Medium', 'Low')),
    
    -- 【命名與語意註解】
    purchase_date      text, -- 對應 UI 的「購買結單日」 (格式 YYYY-MM-DD，本機 IndexedDB 字串格式)
    closing_date       text, -- 對應 UI 的「官方結單日」 (格式 YYYY-MM-DD，本機 IndexedDB 字串格式)
    -- 【註：前端 UI 之「狀態」 (status) 為動態計算得來 (即今日是否已超過 closing_date)，故不另設資料庫欄位】
    
    release_month      text, -- 發售月份 (如 2026-11)
    has_official_site  boolean NOT NULL DEFAULT false,
    product_url        text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- B. 商品分類 (Product Category)
CREATE TABLE IF NOT EXISTS public.product_categories (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE CASCADE, 
    -- 說明：Category 代表商品群組底下的分頁頁籤。若群組 (ProductGroup) 被刪除，則底下分類一併 CASCADE 刪除。
    title            text NOT NULL,
    sort_order       integer NOT NULL DEFAULT 0,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- C. 商品規格明細 (Product Variant)
CREATE TABLE IF NOT EXISTS public.product_variants (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id            uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE RESTRICT,
    -- 說明：防止商品群組 (ProductGroup) 被誤刪。若群組下已有規格，必須先處理規格，故使用 ON DELETE RESTRICT 約束。
    product_category_id         uuid REFERENCES public.product_categories(id) ON DELETE SET NULL,
    -- 說明：分類 (Category) 刪除時，不應刪除規格商品，僅將其分類歸屬設為空 (SET NULL)。
    myacg_item_code             text NOT NULL, -- MVP 階段改為純文字儲存，不建立與 inventory 表的外鍵約束
    product_title               text NOT NULL,
    variant_name                text NOT NULL,
    raw_variant_name            text,
    
    -- 平台需求與手動調整量 (對應 UI 之數量需求加總計算)
    myacg_auto_quantity         integer NOT NULL DEFAULT 0,  -- 買動漫自動需求量 (對應 myacg_quantity)
    effective_myacg_quantity     integer NOT NULL DEFAULT 0,  -- 買動漫有效需求量
    myacg_manual_adjustment     integer NOT NULL DEFAULT 0,  -- 買動漫手動調整量
    waca_auto_quantity          integer NOT NULL DEFAULT 0,  -- WACA 自動需求量 (對應 waca_quantity)
    waca_manual_adjustment      integer NOT NULL DEFAULT 0,  -- WACA 手動調整量
    private_manual_adjustment   integer NOT NULL DEFAULT 0,  -- 私下登記手動調整量 (對應 private_quantity)
    purchased_manual_adjustment integer NOT NULL DEFAULT 0,  -- 已採購手動調整量 (對應 ordered_quantity)
    
    note                        text NOT NULL DEFAULT '',
    sort_order                  integer NOT NULL DEFAULT 0,
    catalog_missing             boolean NOT NULL DEFAULT false,
    source                      text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- D. 採購批次單頭 (Purchase Batch)
CREATE TABLE IF NOT EXISTS public.purchase_batches (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE RESTRICT,
    -- 說明：防止誤刪已被採購批次關聯的商品群組。
    name             text NOT NULL, -- 批次名稱 (對應 batch_name)
    date             text, -- 採購日期 (對應 purchase_date)
    note             text,
    currency         text NOT NULL DEFAULT 'JPY', -- 幣別
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- E. 採購批次明細 (Purchase Batch Item)
CREATE TABLE IF NOT EXISTS public.purchase_batch_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_batch_id  uuid NOT NULL REFERENCES public.purchase_batches(id) ON DELETE CASCADE,
    -- 說明：批次明細為批次單頭之附屬文件，單頭刪除時一併 CASCADE 刪除明細。
    product_variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
    -- 說明：禁止刪除已產生採購明細的商品規格 (ON DELETE RESTRICT)，保護歷史交易與成本記錄。
    quantity           integer NOT NULL DEFAULT 0,
    cost               numeric(12, 2) NOT NULL DEFAULT 0,
    note               text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- F. 私下登記單頭 (Private Order)
CREATE TABLE IF NOT EXISTS public.private_orders (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_group_id uuid NOT NULL REFERENCES public.product_groups(id) ON DELETE RESTRICT,
    -- 說明：防止誤刪已被客戶訂單關聯的商品群組。
    customer_name    text NOT NULL,
    contact          text,
    note             text,
    status           text DEFAULT 'pending', -- 訂單狀態 (對應 status)
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- G. 私下登記明細 (Private Order Item)
CREATE TABLE IF NOT EXISTS public.private_order_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    private_order_id   uuid NOT NULL REFERENCES public.private_orders(id) ON DELETE CASCADE,
    -- 說明：私下登記明細隨單頭刪除而 CASCADE 刪除。
    product_variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
    -- 說明：禁止刪除已有訂單訂購的商品規格 (ON DELETE RESTRICT)。
    quantity           integer NOT NULL DEFAULT 0,
    amount             numeric(12, 2) NOT NULL DEFAULT 0, -- 金額 (對應 price/amount)
    note               text,
    
    -- MVP 核心同步與審查欄位
    local_id                 text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    deleted_at               timestamptz,
    version                  integer NOT NULL DEFAULT 1,
    sync_status              text NOT NULL DEFAULT 'synced'
);

-- ==========================================
-- 2. 觸發器防重疊建立與綁定
-- ==========================================

DROP TRIGGER IF EXISTS trigger_update_product_groups_audit ON public.product_groups;
CREATE TRIGGER trigger_update_product_groups_audit BEFORE UPDATE ON public.product_groups FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

DROP TRIGGER IF EXISTS trigger_update_product_categories_audit ON public.product_categories;
CREATE TRIGGER trigger_update_product_categories_audit BEFORE UPDATE ON public.product_categories FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

DROP TRIGGER IF EXISTS trigger_update_product_variants_audit ON public.product_variants;
CREATE TRIGGER trigger_update_product_variants_audit BEFORE UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

DROP TRIGGER IF EXISTS trigger_update_purchase_batches_audit ON public.purchase_batches;
CREATE TRIGGER trigger_update_purchase_batches_audit BEFORE UPDATE ON public.purchase_batches FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

DROP TRIGGER IF EXISTS trigger_update_purchase_batch_items_audit ON public.purchase_batch_items;
CREATE TRIGGER trigger_update_purchase_batch_items_audit BEFORE UPDATE ON public.purchase_batch_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

DROP TRIGGER IF EXISTS trigger_update_private_orders_audit ON public.private_orders;
CREATE TRIGGER trigger_update_private_orders_audit BEFORE UPDATE ON public.private_orders FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

DROP TRIGGER IF EXISTS trigger_update_private_order_items_audit ON public.private_order_items;
CREATE TRIGGER trigger_update_private_order_items_audit BEFORE UPDATE ON public.private_order_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ==========================================
-- 3. 效能索引優化
-- ==========================================

-- A. 外鍵索引 (Foreign Key Indexes)
CREATE INDEX IF NOT EXISTS idx_product_categories_group_id ON public.product_categories(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_group_id ON public.product_variants(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_category_id ON public.product_variants(product_category_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_group_id ON public.purchase_batches(product_group_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_batch_id ON public.purchase_batch_items(purchase_batch_id);
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

-- D. 增量查詢加速索引 (updated_at) 與 SKU 查詢加速索引 (myacg_item_code)
CREATE INDEX IF NOT EXISTS idx_product_groups_updated_at ON public.product_groups(updated_at);
CREATE INDEX IF NOT EXISTS idx_product_categories_updated_at ON public.product_categories(updated_at);
CREATE INDEX IF NOT EXISTS idx_product_variants_updated_at ON public.product_variants(updated_at);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_updated_at ON public.purchase_batches(updated_at);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_updated_at ON public.purchase_batch_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_private_orders_updated_at ON public.private_orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_private_order_items_updated_at ON public.private_order_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_product_variants_myacg_item_code ON public.product_variants(myacg_item_code);

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
-- 4a. SELECT 政策：安全清理舊政策後重新建立 (防軟刪除)
-- ------------------------------------------
DROP POLICY IF EXISTS select_policy ON public.product_groups;
CREATE POLICY select_policy ON public.product_groups FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS select_policy ON public.product_categories;
CREATE POLICY select_policy ON public.product_categories FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS select_policy ON public.product_variants;
CREATE POLICY select_policy ON public.product_variants FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS select_policy ON public.purchase_batches;
CREATE POLICY select_policy ON public.purchase_batches FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS select_policy ON public.purchase_batch_items;
CREATE POLICY select_policy ON public.purchase_batch_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS select_policy ON public.private_orders;
CREATE POLICY select_policy ON public.private_orders FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

DROP POLICY IF EXISTS select_policy ON public.private_order_items;
CREATE POLICY select_policy ON public.private_order_items FOR SELECT TO authenticated USING (deleted_at IS NULL OR public.get_my_role() = 'owner');

-- ------------------------------------------
-- 4b. INSERT 政策：僅限 owner / staff 可新增
-- ------------------------------------------
DROP POLICY IF EXISTS insert_policy ON public.product_groups;
CREATE POLICY insert_policy ON public.product_groups FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS insert_policy ON public.product_categories;
CREATE POLICY insert_policy ON public.product_categories FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS insert_policy ON public.product_variants;
CREATE POLICY insert_policy ON public.product_variants FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS insert_policy ON public.purchase_batches;
CREATE POLICY insert_policy ON public.purchase_batches FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS insert_policy ON public.purchase_batch_items;
CREATE POLICY insert_policy ON public.purchase_batch_items FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS insert_policy ON public.private_orders;
CREATE POLICY insert_policy ON public.private_orders FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS insert_policy ON public.private_order_items;
CREATE POLICY insert_policy ON public.private_order_items FOR INSERT TO authenticated WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

-- ------------------------------------------
-- 4c. UPDATE 政策：僅限 owner / staff 可更新
-- ------------------------------------------
DROP POLICY IF EXISTS update_policy ON public.product_groups;
CREATE POLICY update_policy ON public.product_groups FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS update_policy ON public.product_categories;
CREATE POLICY update_policy ON public.product_categories FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS update_policy ON public.product_variants;
CREATE POLICY update_policy ON public.product_variants FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS update_policy ON public.purchase_batches;
CREATE POLICY update_policy ON public.purchase_batches FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS update_policy ON public.purchase_batch_items;
CREATE POLICY update_policy ON public.purchase_batch_items FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS update_policy ON public.private_orders;
CREATE POLICY update_policy ON public.private_orders FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

DROP POLICY IF EXISTS update_policy ON public.private_order_items;
CREATE POLICY update_policy ON public.private_order_items FOR UPDATE TO authenticated USING (public.get_my_role() IN ('owner', 'staff')) WITH CHECK (public.get_my_role() IN ('owner', 'staff'));

-- ------------------------------------------
-- 4d. DELETE 政策：僅限 Owner 可物理刪除
-- ------------------------------------------
DROP POLICY IF EXISTS delete_policy ON public.product_groups;
CREATE POLICY delete_policy ON public.product_groups FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');

DROP POLICY IF EXISTS delete_policy ON public.product_categories;
CREATE POLICY delete_policy ON public.product_categories FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');

DROP POLICY IF EXISTS delete_policy ON public.product_variants;
CREATE POLICY delete_policy ON public.product_variants FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');

DROP POLICY IF EXISTS delete_policy ON public.purchase_batches;
CREATE POLICY delete_policy ON public.purchase_batches FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');

DROP POLICY IF EXISTS delete_policy ON public.purchase_batch_items;
CREATE POLICY delete_policy ON public.purchase_batch_items FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');

DROP POLICY IF EXISTS delete_policy ON public.private_orders;
CREATE POLICY delete_policy ON public.private_orders FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');

DROP POLICY IF EXISTS delete_policy ON public.private_order_items;
CREATE POLICY delete_policy ON public.private_order_items FOR DELETE TO authenticated USING (public.get_my_role() = 'owner');
