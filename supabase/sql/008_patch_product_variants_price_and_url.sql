-- =========================================================================
-- 小河馬採購工作台 - 擴充商品規格單價與連結欄位 (Phase 3-H-4)
-- 檔案名稱: 008_patch_product_variants_price_and_url.sql
-- =========================================================================

-- 1. 在 product_variants 資料表新增 price_jpy, price_twd, product_url 欄位
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS price_jpy integer NOT NULL DEFAULT 0;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS price_twd integer NOT NULL DEFAULT 0;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS product_url text;

-- 說明：
-- price_jpy: 日幣標準單價成本（對應一般日本商品）
-- price_twd: 台幣單價成本（對應代理版商品）
-- product_url: 個別規格商品的原始連結網址
