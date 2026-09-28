-- Disposable 15-resource core shape for executing the 028 + 045 writer.
-- It is intentionally minimal and must never be applied to any real project.
create publication supabase_realtime;
create table public.inventory_items(
  id uuid unique, inventory_key text primary key,
  product_id uuid, latest_catalog_import_id uuid, deleted_at timestamptz
);
create table public.product_groups(id uuid primary key,title text);
create table public.product_categories(id uuid primary key,product_group_id uuid);
alter table public.product_variants add column product_group_id uuid;
alter table public.product_variants add column product_category_id uuid;
create table public.bundle_components(id uuid primary key,bundle_variant_id uuid,component_variant_id uuid);
create table public.purchase_batches(id uuid primary key,product_group_id uuid);
create table public.purchase_batch_items(id uuid primary key,purchase_batch_id uuid,product_variant_id uuid);
create table public.private_orders(id uuid primary key,product_group_id uuid);
create table public.private_order_items(id uuid primary key,private_order_id uuid,product_variant_id uuid);
create table public.sales_orders(id uuid primary key);
create table public.sales_order_items(id uuid primary key,order_id uuid,product_variant_id uuid);
create table public.japan_packages(id uuid primary key);
create table public.japan_package_items(
  id uuid primary key,japan_package_id uuid,product_group_id uuid,product_variant_id uuid,
  purchase_batch_id uuid,purchase_batch_item_id uuid
);
create table public.outbound_shipments(id uuid primary key);
create table public.outbound_shipment_items(
  id uuid primary key,outbound_shipment_id uuid,japan_package_item_id uuid,
  product_group_id uuid,product_variant_id uuid
);
insert into public.product_groups(id) values('00000000-0000-4000-8000-000000000021');
update public.product_variants set product_group_id='00000000-0000-4000-8000-000000000021';
