-- Read-only 026b identity and data preconditions. No business values are returned.
with identity as (
  select
    coalesce((select array_agg(a.attname order by k.ordinality)
      from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum,ordinality)
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
      where c.conrelid='public.inventory_items'::regclass and c.contype='p'),array[]::text[]) primary_key,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='inventory_items' and column_name='id') id_exists,
    exists(select 1 from pg_constraint c where c.conrelid='public.inventory_items'::regclass and c.contype='u'
      and pg_get_constraintdef(c.oid)='UNIQUE (inventory_key)') inventory_key_unique,
    (select count(*) from pg_constraint c where c.confrelid='public.inventory_items'::regclass and c.contype='f') dependent_fk_count
), counts as (
  select count(*)::bigint row_count,
    count(*) filter(where inventory_key is null or btrim(inventory_key)='')::bigint null_inventory_key_count,
    (count(inventory_key)-count(distinct inventory_key))::bigint duplicate_inventory_key_count,
    count(*) filter(where to_jsonb(i)->>'id' is null or btrim(to_jsonb(i)->>'id')='')::bigint null_id_count,
    count(*) filter(where to_jsonb(i)->>'id' is not null and not (to_jsonb(i)->>'id'~*'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'))::bigint invalid_uuid_count,
    (count(to_jsonb(i)->>'id')-count(distinct to_jsonb(i)->>'id'))::bigint duplicate_id_count
  from public.inventory_items i
)
select jsonb_build_object(
  'result',case when counts.null_inventory_key_count=0 and counts.duplicate_inventory_key_count=0
    and (not identity.id_exists or (counts.null_id_count=0 and counts.invalid_uuid_count=0 and counts.duplicate_id_count=0))
    and identity.dependent_fk_count=0 then 'PASS' else 'BLOCK' end,
  'primaryKey',identity.primary_key,'idExists',identity.id_exists,'inventoryKeyUnique',identity.inventory_key_unique,
  'rowCount',counts.row_count,'nullInventoryKeyCount',counts.null_inventory_key_count,
  'duplicateInventoryKeyCount',counts.duplicate_inventory_key_count,'nullIdCount',counts.null_id_count,
  'invalidUuidCount',counts.invalid_uuid_count,'duplicateIdCount',counts.duplicate_id_count,
  'dependentForeignKeyCount',identity.dependent_fk_count,
  'dependentReferenceViolationCount',case when identity.dependent_fk_count=0 then 0 else null end
) as inventory_items_integrity
from identity cross join counts;
