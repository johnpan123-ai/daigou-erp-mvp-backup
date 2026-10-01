import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createServer } from 'vite';

// Disposable loopback PostgreSQL and PostgREST only. Never accept a remote URL.
const rawUrl = process.env.WACA_ISOLATED_PG_URL;
if (!rawUrl) throw new Error('Set WACA_ISOLATED_PG_URL for the disposable loopback database.');
const url = new URL(rawUrl);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '55492');
assert.ok(url.pathname.startsWith('/waca_v3_'));
const databaseName = `waca_v3_http_${randomBytes(4).toString('hex')}`;
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const testUrl = new URL(url); testUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const sql = new pg.Client({ connectionString: testUrl.toString() });
const secret = 'isolated-waca-postgrest-v3-secret-32-bytes';
const origin = 'http://127.0.0.1:4397';
const ownerId = '00000000-0000-4000-8000-000000000099';
let server;
let vite;
let serverOutput = '';

const jwt = sub => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role: 'authenticated', sub,
    exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const content = `${header}.${payload}`;
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
};
const call = async (path, body, token) => {
  const response = await fetch(`${origin}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
};

await admin.connect();
await admin.query(`create database ${databaseName}`);
await sql.connect();
try {
  await sql.query(readFileSync('tests/sql/waca-isolated-bootstrap.sql', 'utf8'));
  await sql.query('create schema extensions');
  await sql.query('create extension if not exists pgcrypto with schema extensions');
  await sql.query(readFileSync('supabase/sql/044_waca_cloud_ledger.sql', 'utf8'));
  server = spawn('wsl', ['-e', 'env',
    `PGRST_DB_URI=${testUrl.toString()}`,
    'PGRST_DB_SCHEMAS=public', 'PGRST_DB_ANON_ROLE=anon',
    `PGRST_JWT_SECRET=${secret}`, 'PGRST_SERVER_HOST=127.0.0.1',
    'PGRST_SERVER_PORT=4397', '/tmp/hippo-waca-v3-postgrest-bin/postgrest'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', bytes => { serverOutput += String(bytes); });
  server.stderr.on('data', bytes => { serverOutput += String(bytes); });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.ok) { ready = true; break; }
    } catch { /* startup */ }
    if (server.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Isolated PostgREST did not start: ${serverOutput.slice(-2000)}`);

  const owner = jwt(ownerId);
  const nonOwner = jwt('00000000-0000-4000-8000-000000000098');
  const fresh = await call('/rpc/erp_read_waca_snapshot', {}, owner);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal(fresh.data.revision, 0);
  assert.equal((await call('/rpc/erp_read_waca_snapshot', {}, nonOwner)).status, 403);
  assert.equal((await call('/rpc/erp_read_waca_snapshot', {}, null)).status, 401);

  const snapshot = {
    revision: 0,
    orders: [{ key: 'WACA::HTTP-A', orderNumber: 'HTTP-A', status: '完成付款', purchasedAt: '2026-09-28' }],
    items: [{ key: 'WACA::HTTP-A::F', orderKey: 'WACA::HTTP-A', feature: 'F',
      productCode: 'G001', productTitle: 'Test group', spec1: 'Test variant', spec2: '', specCode: '',
      quantity: 11, subtotal: 110, productVariantId: 'v-11', match: 'MANUAL_MATCH', diagnostic: null }],
    mappings: [{ feature: 'F', productVariantId: 'v-11', method: 'MANUAL', confirmedAt: '2026-09-28' }],
    batches: [{ id: 'HTTP-B1', fileName: 'waca.xlsx', importedAt: '2026-09-28', rows: 1,
      inserted: 1, updated: 0, unchanged: 0, conflictRows: [], result: {} }],
    masterLinks: [], cutoverAudit: [],
  };
  for (let revision = 0; revision < 5; revision++) {
    const committed = await call('/rpc/erp_commit_waca_snapshot', {
      p_snapshot: snapshot, p_expected_revision: revision, p_update_auto_quantity: true,
    }, owner);
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    assert.equal(committed.data.revision, revision + 1);
    assert.equal(committed.data.effectiveQuantity, 11);
  }
  const saved = await call('/rpc/erp_read_waca_snapshot', {}, owner);
  assert.equal(saved.data.orders.length, 1);
  assert.equal(saved.data.items.length, 1);
  assert.equal(saved.data.items[0].productVariantId, '00000000-0000-4000-8000-000000000011');
  assert.equal(saved.data.cutoverAudit[0].legacyWacaQuantity, 8);
  const stale = await call('/rpc/erp_commit_waca_snapshot', {
    p_snapshot: snapshot, p_expected_revision: 0, p_update_auto_quantity: true,
  }, owner);
  assert.ok(stale.status >= 400);
  const directWrite = await call('/waca_orders', { order_key: 'BYPASS', status: '完成付款', payload: {} }, owner);
  assert.ok(directWrite.status >= 400, 'Owner HTTP table INSERT must be RPC-only');
  const { rows } = await sql.query('select waca_auto_quantity from public.product_variants where local_id=$1', ['v-11']);
  assert.equal(rows[0].waca_auto_quantity, 11);
  assert.equal((await sql.query('select count(*)::integer n from public.waca_orders')).rows[0].n, 1);

  // Exercise the actual domain -> existing snapshot RPC -> SQL recompute path.
  // Old durable item keys must survive feature normalization: the RPC upserts
  // keys rather than deleting omitted rows, so rekeying would double count.
  vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  const { importWacaRows, normalizeWacaText } = await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const { repositoryFromSnapshot, snapshotFromRepository } = await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const signedId = '00000000-0000-4000-8000-000000000011';
  const capId = '00000000-0000-4000-8000-000000000012';
  await sql.query(`insert into public.product_variants(id,local_id,myacg_item_code,product_title,variant_name)
    values ($1,'v-12','G002','Test group','Cap')`, [capId]);
  const variants = (await sql.query('select * from public.product_variants')).rows;
  const master = variants.map(v => ({ mainCode: 'GP-TEST', childCode: v.myacg_item_code,
    variantId: v.id, productGroupId: 'test-group', productTitle: v.product_title,
    variantTitle: v.variant_name, active: true }));
  const row = (specCode, spec1, quantity, overrides = {}) => ({ orderStatus: '完成付款',
    orderNumber: 'HTTP-A', purchasedAt: '2026-10-02', productCode: 'G001', productTitle: 'Test group',
    specCode, spec1, spec2: '', quantity, subtotal: quantity * 100, ...overrides });
  const capRow = row('G002', 'Cap', 1);
  const oldFeature = JSON.stringify([capRow.productCode, capRow.productTitle, capRow.spec1, capRow.spec2].map(normalizeWacaText));
  const oldKey = snapshot.items[0].key;
  const seeded = { ...saved.data,
    items: [{ ...capRow, key: oldKey, orderKey: 'WACA::HTTP-A', feature: oldFeature,
      productVariantId: signedId, match: 'AUTO_MATCH', diagnostic: null }],
    mappings: [{ feature: oldFeature, productVariantId: signedId, myacgMainId: 'GP-TEST',
      myacgVariantId: 'G001', method: 'AUTO', confirmedAt: '2026-10-01' }],
  };
  const seed = await call('/rpc/erp_commit_waca_snapshot', {
    p_snapshot: seeded, p_expected_revision: saved.data.revision, p_update_auto_quantity: true,
  }, owner);
  assert.equal(seed.status, 200, 'isolated old wrong mapping seed');
  const inputs = [row('G001', 'Test variant', 3), capRow, row('', 'Cap', 9, { orderNumber: 'BLANK-SPEC' }),
    row('G002', 'Cap', 7, { orderNumber: 'CANCEL', orderStatus: '取消' }),
    row('G002', 'Cap', 8, { orderNumber: 'FAIL', orderStatus: '失敗' })];
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = (await call('/rpc/erp_read_waca_snapshot', {}, owner)).data;
    const repo = repositoryFromSnapshot(current, variants);
    const result = importWacaRows(inputs, repo, master, `SPEC-${attempt}`);
    assert.equal(result.errors.length, 0);
    assert.equal(repo.autoQuantities.get(signedId), 3);
    assert.equal(repo.autoQuantities.get(capId), 1);
    assert.equal(repo.items.get(oldKey).productVariantId, capId);
    const committed = await call('/rpc/erp_commit_waca_snapshot', {
      p_snapshot: snapshotFromRepository(current, repo, current.batches),
      p_expected_revision: current.revision, p_update_auto_quantity: true,
    }, owner);
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    assert.equal(committed.data.effectiveQuantity, 13, 'source sum includes the pending 9, not assigned ERP quantity');
    const actual = (await sql.query('select id,waca_auto_quantity from public.product_variants')).rows;
    assert.equal(actual.find(v => v.id === signedId).waca_auto_quantity, 3);
    assert.equal(actual.find(v => v.id === capId).waca_auto_quantity, 1);
    assert.equal((await sql.query('select count(*)::integer n from public.waca_order_items')).rows[0].n, 5);
    const back = (await call('/rpc/erp_read_waca_snapshot', {}, owner)).data;
    assert.equal(back.items.find(item => item.key === oldKey).productVariantId, capId);
    assert.equal(back.items.find(item => item.specCode === '').productVariantId, '');
    assert.equal(back.items.find(item => item.specCode === '').diagnostic, 'SPEC_CODE_MISSING');
    assert.deepEqual(back.cutoverAudit, saved.data.cutoverAudit, 'historical audit remains unchanged');
  }
  console.log('PASS isolated PostgREST spec-code rematch, stable legacy SQL keys, signed=3/cap=1, blank pending, status rules and 5x idempotency');
  console.log('PASS isolated PostgREST 16.4: owner/anon/non-owner ACL, RPC 5x idempotency, 8→11, CAS, direct-write deny');
} finally {
  await vite?.close();
  server?.kill();
  await sql.end();
  await admin.query(`drop database ${databaseName} with (force)`);
  await admin.end();
}
