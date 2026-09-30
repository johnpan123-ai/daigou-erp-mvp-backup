import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { CANONICAL_FRESH_INSTALL_V3 } from '../supabase/canonicalFreshInstallV3.mjs';
import { buildMigrationEffectRegistry } from '../tools/schema-reconciliation/migrationEffectRegistry.mjs';
import { planSchemaDelta } from '../tools/schema-reconciliation/reconcile.mjs';
import { diffStructuralSnapshots, fingerprintStructuralSnapshot } from '../tools/schema-reconciliation/schemaContract.mjs';
import { classifyLiveSchemaDifferences, LIVE_SCHEMA_CLASSIFICATIONS }
  from '../tools/schema-reconciliation/liveSchemaReconciliationRegistry.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const snapshotSql = await read('../tools/schema-reconciliation/sql/live-schema-snapshot-readonly.sql');
const inventorySql = await read('../tools/schema-reconciliation/sql/026b-inventory-preconditions-readonly.sql');
const repair = '048_erp2_live_canonical_contract_reconciliation.sql';

async function createDatabase() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    create schema extensions; create extension pgcrypto with schema extensions;
    create role authenticated; create role anon; create role service_role;
    create role staging_refresh_target_reader; create role staging_refresh_restore_writer;
    create schema auth; create schema storage; create schema realtime;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create publication supabase_realtime;
  `);
  return db;
}

async function apply(db, files, label) {
  for (const file of files) {
    try { await db.exec(await read(`../supabase/sql/${file}`)); }
    catch (error) { throw new Error(`${label}:${file}:${error.message}`, { cause: error }); }
  }
}

async function capture(db) {
  const snapshot = (await db.query(snapshotSql)).rows[0].erp_schema_snapshot;
  snapshot.integrity.inventoryItems = (await db.query(inventorySql)).rows[0].inventory_items_integrity;
  snapshot.completeness.inventoryIntegrity = true;
  snapshot.identity.projectRef = 'rhfdjsklfrgpoqsaqpkn';
  return snapshot;
}

const finalDb = await createDatabase();
const liveLikeDb = await createDatabase();
try {
  await apply(finalDb, CANONICAL_FRESH_INSTALL_V3, 'fresh-final');
  const target = await capture(finalDb);
  const pre048 = CANONICAL_FRESH_INSTALL_V3.slice(0, CANONICAL_FRESH_INSTALL_V3.indexOf(repair));
  await apply(liveLikeDb, pre048, 'post-047-live-like');

  await liveLikeDb.exec(`
    alter table public.product_groups add column proxy_agent text;
    alter table public.product_groups add column show_in_purchase_list boolean not null default false;
    alter table public.product_groups alter column purchase_date type date using nullif(purchase_date,'')::date;
    alter table public.purchase_batches alter column date type date using nullif(date,'')::date;
    alter table public.product_variants
      alter column private_manual_adjustment drop not null,
      alter column private_manual_adjustment drop default,
      alter column purchased_manual_adjustment drop not null,
      alter column purchased_manual_adjustment drop default;
    alter table public.private_orders drop constraint private_orders_product_group_id_fkey;
    alter table public.private_orders add constraint private_orders_product_group_id_fkey
      foreign key(product_group_id) references public.product_groups(id) on delete cascade;
    alter table public.purchase_batches drop constraint purchase_batches_product_group_id_fkey;
    alter table public.purchase_batches add constraint purchase_batches_product_group_id_fkey
      foreign key(product_group_id) references public.product_groups(id) on delete cascade;

    drop policy select_policy on public.inventory_items;
    create policy select_policy on public.inventory_items for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
    drop policy select_policy on public.private_order_items;
    create policy select_policy on public.private_order_items for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
    drop policy select_policy on public.product_categories;
    create policy select_policy on public.product_categories for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
    drop policy select_policy on public.product_groups;
    create policy select_policy on public.product_groups for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
    drop policy select_policy on public.product_variants;
    create policy select_policy on public.product_variants for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
    drop policy select_policy on public.purchase_batch_items;
    create policy select_policy on public.purchase_batch_items for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));
    drop policy select_policy on public.purchase_batches;
    create policy select_policy on public.purchase_batches for select to authenticated using(deleted_at is null or public.is_owner(auth.uid()));

    drop policy insert_policy on public.sales_orders;
    create policy insert_policy on public.sales_orders for insert to authenticated with check(public.is_owner_or_staff(auth.uid()));
    drop policy update_policy on public.sales_orders;
    create policy update_policy on public.sales_orders for update to authenticated using(public.is_owner_or_staff(auth.uid())) with check(public.is_owner_or_staff(auth.uid()));
    drop policy delete_policy on public.sales_orders;
    create policy delete_policy on public.sales_orders for delete to authenticated using(public.is_owner_or_staff(auth.uid()));
    drop policy insert_policy on public.sales_order_items;
    create policy insert_policy on public.sales_order_items for insert to authenticated with check(public.is_owner_or_staff(auth.uid()));
    drop policy update_policy on public.sales_order_items;
    create policy update_policy on public.sales_order_items for update to authenticated using(public.is_owner_or_staff(auth.uid())) with check(public.is_owner_or_staff(auth.uid()));
    drop policy delete_policy on public.sales_order_items;
    create policy delete_policy on public.sales_order_items for delete to authenticated using(public.is_owner_or_staff(auth.uid()));

    grant maintain,references,trigger,truncate on table
      public.bundle_components,public.dashboard_category_images,
      public.japan_package_items,public.japan_packages,public.outbound_shipment_items,public.outbound_shipments,
      public.private_order_items,public.private_orders,public.product_categories,public.product_groups,
      public.product_variants,public.profiles,public.purchase_batch_items,public.purchase_batches,
      public.sales_order_items,public.sales_orders to anon,authenticated;
    grant maintain,references,trigger,truncate on table public.erp_cloud_restore_epoch to authenticated;
    grant select,insert,update,delete on table
      public.bundle_components,public.dashboard_category_images,
      public.japan_package_items,public.japan_packages,public.outbound_shipment_items,public.outbound_shipments,
      public.private_order_items,public.private_orders,public.product_categories,public.product_groups,
      public.product_variants,public.purchase_batch_items,public.purchase_batches,
      public.sales_order_items,public.sales_orders to authenticated;
    grant select on table public.profiles,public.erp_cloud_restore_epoch to authenticated;
    grant all privileges on table public.product_groups to service_role;

    create function public.erp_p0_4_authenticated_test_status() returns jsonb language sql as $$select '{}'::jsonb$$;
    create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin end$$;
    create policy staging_refresh_target_reader_select on public.product_groups for select to staging_refresh_target_reader using(true);
    create policy staging_refresh_restore_writer_select on public.product_groups for select to staging_refresh_restore_writer using(true);
    create policy staging_refresh_restore_writer_insert on public.product_groups for insert to staging_refresh_restore_writer with check(true);
    create policy staging_refresh_restore_writer_delete on public.product_groups for delete to staging_refresh_restore_writer using(true);
  `);

  const before = await capture(liveLikeDb);
  const registry = await buildMigrationEffectRegistry();
  const beforePlan = planSchemaDelta(before, registry, { expectedSnapshot: target });
  const planned048 = beforePlan.migrations.find(item => item.migrationId === '048');
  assert.equal(planned048.state, 'NEEDS_APPLY');
  assert.equal(planned048.safeToApply, true);
  assert.deepEqual(beforePlan.applyPlan.map(item => item.migrationId), ['048']);
  const beforeDiff = diffStructuralSnapshots(target, before);
  assert.equal(beforeDiff.semanticDifferences.length, 41);

  await apply(liveLikeDb, [repair], 'live-like-048');
  const after = await capture(liveLikeDb);
  assert.equal(fingerprintStructuralSnapshot(after), fingerprintStructuralSnapshot(target));
  assert.equal(diffStructuralSnapshots(target, after).semanticDifferences.length, 0);
  const once = fingerprintStructuralSnapshot(after);
  await apply(liveLikeDb, [repair], 'live-like-048-replay');
  assert.equal(fingerprintStructuralSnapshot(await capture(liveLikeDb)), once);
  const serviceRole = (await liveLikeDb.query(`select
    has_table_privilege('service_role','public.product_groups','SELECT') can_select,
    has_table_privilege('service_role','public.product_groups','TRUNCATE') can_truncate`)).rows[0];
  assert.deepEqual(serviceRole, { can_select: true, can_truncate: true });
  console.log('PASS post-047 Live-like fixture plans only 048 and converges idempotently without changing service_role');

  const classified = classifyLiveSchemaDifferences([
    { path: 'tables.public.product_groups.columns.proxy_agent', category: 'COLUMN', before: null, after: {} },
    { path: 'tables.public.product_groups.grants.anon', category: 'TABLE_GRANT', before: [], after: ['TRUNCATE'] },
    { path: 'functions.public.erp_p0_4_authenticated_test_status()', category: 'FUNCTION', before: null, after: {} },
    { path: 'tables.public.dashboard_category_images.columns.local_id', category: 'COLUMN', before: {}, after: null },
  ]);
  assert.deepEqual(classified.items.map(item => item.classification), [
    LIVE_SCHEMA_CLASSIFICATIONS.A, LIVE_SCHEMA_CLASSIFICATIONS.C,
    LIVE_SCHEMA_CLASSIFICATIONS.B, LIVE_SCHEMA_CLASSIFICATIONS.D,
  ]);
  const blocked = classifyLiveSchemaDifferences([
    { path: 'tables.public.unreviewed.columns.secret', category: 'COLUMN', before: null, after: {} },
  ]);
  assert.equal(blocked.result, 'BLOCKED');
  assert.equal(blocked.counts[LIVE_SCHEMA_CLASSIFICATIONS.E], 1);
  const unprovenNormalization = classifyLiveSchemaDifferences([{
    path: 'tables.public.product_groups.constraints', category: 'CONSTRAINT', before: {}, after: {},
  }], { canonicalDifferencePaths: ['tables.public.product_groups.constraints'] });
  assert.equal(unprovenNormalization.result, 'BLOCKED');
  assert.equal(unprovenNormalization.items[0].ruleId, 'normalization-claim-not-proven');
  console.log('PASS machine-readable reconciliation registry classifies A/B/C/D and fails closed on E');
} finally {
  await finalDb.close();
  await liveLikeDb.close();
}

console.log(JSON.stringify({ result: 'PASS', liveMutation: 0, migrationApply: 0, cloudflareDeploy: 0 }));
