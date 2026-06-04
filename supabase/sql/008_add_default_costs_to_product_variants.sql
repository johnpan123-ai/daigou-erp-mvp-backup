-- Migration: Add default_jpy_cost and default_twd_cost to public.product_variants
ALTER TABLE public.product_variants
ADD COLUMN IF NOT EXISTS default_jpy_cost numeric,
ADD COLUMN IF NOT EXISTS default_twd_cost numeric;
