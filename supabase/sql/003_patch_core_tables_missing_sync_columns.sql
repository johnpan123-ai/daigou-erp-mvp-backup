-- =========================================================================
-- 小河馬採購工作台 - 核心 ERP 資料表同步與調整欄位修補 SQL (Phase 3-D-Patch)
-- 檔案名稱: 003_patch_core_tables_missing_sync_columns.sql
-- 
-- 【說明】
-- 1. 本檔案用於解決 Supabase 中現有資料表已存在，導致 002 DDL 中新增欄位（如 sync_status 等）未被成功寫入的問題。
-- 2. 採用 ALTER TABLE ... ADD COLUMN IF NOT EXISTS 方式，保證安全性。
-- 3. 自動補齊索引與審查 Trigger。
-- 4. **請手動複製到 Supabase SQL Editor 執行，請勿直接修改程式**。
-- =========================================================================

-- ==========================================
-- 0. 公用觸發器函數防重疊建立
-- ==========================================
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
-- 1. 修補 7 張表的核心同步欄位與索引
-- ==========================================

-- ------------------------------------------
-- A. product_groups
-- ------------------------------------------
ALTER TABLE public.product_groups ADD COLUMN IF NOT EXISTS local_id text;
ALTER TABLE public.product_groups ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.product_groups ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.product_groups ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid();
ALTER TABLE public.product_groups ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.product_groups ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.product_groups ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';

DROP TRIGGER IF EXISTS trigger_update_product_groups_audit ON public.product_groups;
CREATE TRIGGER trigger_update_product_groups_audit BEFORE UPDATE ON public.product_groups FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ------------------------------------------
-- B. product_categories
-- ------------------------------------------
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS local_id text;
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid();
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.product_categories ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';

DROP TRIGGER IF EXISTS trigger_update_product_categories_audit ON public.product_categories;
CREATE TRIGGER trigger_update_product_categories_audit BEFORE UPDATE ON public.product_categories FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ------------------------------------------
-- C. product_variants (包含手動調整量欄位)
-- ------------------------------------------
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS local_id text;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid();
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';

-- 補齊 UI 特有手動調整量欄位
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS myacg_manual_adjustment integer NOT NULL DEFAULT 0;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS waca_manual_adjustment integer NOT NULL DEFAULT 0;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS private_manual_adjustment integer NOT NULL DEFAULT 0;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS purchased_manual_adjustment integer NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS trigger_update_product_variants_audit ON public.product_variants;
CREATE TRIGGER trigger_update_product_variants_audit BEFORE UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ------------------------------------------
-- D. purchase_batches
-- ------------------------------------------
ALTER TABLE public.purchase_batches ADD COLUMN IF NOT EXISTS local_id text;
ALTER TABLE public.purchase_batches ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.purchase_batches ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.purchase_batches ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid();
ALTER TABLE public.purchase_batches ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.purchase_batches ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.purchase_batches ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
ALTER TABLE public.purchase_batches ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'JPY';

DROP TRIGGER IF EXISTS trigger_update_purchase_batches_audit ON public.purchase_batches;
CREATE TRIGGER trigger_update_purchase_batches_audit BEFORE UPDATE ON public.purchase_batches FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ------------------------------------------
-- E. purchase_batch_items
-- ------------------------------------------
ALTER TABLE public.purchase_batch_items ADD COLUMN IF NOT EXISTS local_id text;
ALTER TABLE public.purchase_batch_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.purchase_batch_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.purchase_batch_items ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid();
ALTER TABLE public.purchase_batch_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.purchase_batch_items ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.purchase_batch_items ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';

DROP TRIGGER IF EXISTS trigger_update_purchase_batch_items_audit ON public.purchase_batch_items;
CREATE TRIGGER trigger_update_purchase_batch_items_audit BEFORE UPDATE ON public.purchase_batch_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ------------------------------------------
-- F. private_orders
-- ------------------------------------------
ALTER TABLE public.private_orders ADD COLUMN IF NOT EXISTS local_id text;
ALTER TABLE public.private_orders ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.private_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.private_orders ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid();
ALTER TABLE public.private_orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.private_orders ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.private_orders ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
ALTER TABLE public.private_orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';

DROP TRIGGER IF EXISTS trigger_update_private_orders_audit ON public.private_orders;
CREATE TRIGGER trigger_update_private_orders_audit BEFORE UPDATE ON public.private_orders FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ------------------------------------------
-- G. private_order_items
-- ------------------------------------------
ALTER TABLE public.private_order_items ADD COLUMN IF NOT EXISTS local_id text;
ALTER TABLE public.private_order_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.private_order_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.private_order_items ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid();
ALTER TABLE public.private_order_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.private_order_items ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE public.private_order_items ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';

DROP TRIGGER IF EXISTS trigger_update_private_order_items_audit ON public.private_order_items;
CREATE TRIGGER trigger_update_private_order_items_audit BEFORE UPDATE ON public.private_order_items FOR EACH ROW EXECUTE FUNCTION public.sync_audit_columns();

-- ==========================================
-- 2. 補齊效能索引優化
-- ==========================================

-- A. 外鍵索引
CREATE INDEX IF NOT EXISTS idx_product_categories_group_id ON public.product_categories(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_group_id ON public.product_variants(product_group_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_category_id ON public.product_variants(product_category_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_group_id ON public.purchase_batches(product_group_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_batch_id ON public.purchase_batch_items(purchase_batch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_variant_id ON public.purchase_batch_items(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_private_orders_group_id ON public.private_orders(product_group_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_order_id ON public.private_order_items(private_order_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_variant_id ON public.private_order_items(product_variant_id);

-- B. 搜尋性能與軟刪除索引 (排除已軟刪除資料)
CREATE INDEX IF NOT EXISTS idx_product_groups_active ON public.product_groups(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_product_variants_active ON public.product_variants(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_batches_active ON public.purchase_batches(id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_private_orders_active ON public.private_orders(id) WHERE deleted_at IS NULL;

-- C. 本地 IDB 與雲端同步加速索引
CREATE INDEX IF NOT EXISTS idx_product_groups_local_id ON public.product_groups(local_id);
CREATE INDEX IF NOT EXISTS idx_product_categories_local_id ON public.product_categories(local_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_local_id ON public.product_variants(local_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_local_id ON public.purchase_batches(local_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_local_id ON public.purchase_batch_items(local_id);
CREATE INDEX IF NOT EXISTS idx_private_orders_local_id ON public.private_orders(local_id);
CREATE INDEX IF NOT EXISTS idx_private_order_items_local_id ON public.private_order_items(local_id);

-- D. 增量查詢加速索引與 SKU 查詢加速索引
CREATE INDEX IF NOT EXISTS idx_product_groups_updated_at ON public.product_groups(updated_at);
CREATE INDEX IF NOT EXISTS idx_product_categories_updated_at ON public.product_categories(updated_at);
CREATE INDEX IF NOT EXISTS idx_product_variants_updated_at ON public.product_variants(updated_at);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_updated_at ON public.purchase_batches(updated_at);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_items_updated_at ON public.purchase_batch_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_private_orders_updated_at ON public.private_orders(updated_at);
CREATE INDEX IF NOT EXISTS idx_private_order_items_updated_at ON public.private_order_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_product_variants_myacg_item_code ON public.product_variants(myacg_item_code);
