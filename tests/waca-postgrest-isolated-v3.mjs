import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

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
  console.log('PASS isolated PostgREST 16.4: owner/anon/non-owner ACL, RPC 5x idempotency, 8→11, CAS, direct-write deny');
} finally {
  server?.kill();
  await sql.end();
  await admin.query(`drop database ${databaseName} with (force)`);
  await admin.end();
}
