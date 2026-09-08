import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SQL = readFileSync(new URL('../tools/staging-p0-4/sql/staging_p0_4_authenticated_test_harness.sql', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../src/pages/StagingP04AuthenticatedHarness.tsx', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const PORT = process.env.P0_4_AUTH_HARNESS_TEST_PORT || '4234';
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const stable = value => JSON.stringify(value, Object.keys(value).sort());
const clone = value => JSON.parse(JSON.stringify(value));

class FakeAuthenticatedRpcServer {
  batches = new Map();
  items = new Map();
  idempotency = new Map();
  sequence = 1000;
  marker = null;

  response(data, error = null) { return Promise.resolve({ data, error }); }

  residual(marker) {
    const batchIds = [...this.batches.values()].filter(batch => batch.name.startsWith(marker)).map(batch => batch.id);
    return {
      purchaseBatches: batchIds.length,
      purchaseBatchItems: [...this.items.values()].filter(item => batchIds.includes(item.purchase_batch_id)).length,
      idempotencyKeys: [...this.idempotency.values()].filter(entry => batchIds.includes(entry.request.batchId)
        || entry.request.batchOperations?.[0]?.values?.name?.startsWith(marker)).length,
    };
  }

  async rpc(functionName, args = {}) {
    if (functionName === 'erp_p0_4_authenticated_test_status') {
      return this.response({
        authenticated: true, editor: true, role: 'owner',
        prerequisites: { productGroupId: uuid(1), productVariantId: uuid(2) },
      });
    }
    if (functionName === 'erp_p0_4_authenticated_test_residuals') return this.response(this.residual(args.p_marker));
    if (functionName === 'erp_p0_4_authenticated_test_cleanup') {
      const before = this.residual(args.p_marker);
      const batchIds = [...this.batches.values()].filter(batch => batch.name.startsWith(args.p_marker)).map(batch => batch.id);
      for (const [id, item] of this.items) if (batchIds.includes(item.purchase_batch_id)) this.items.delete(id);
      for (const id of batchIds) this.batches.delete(id);
      for (const [key, entry] of this.idempotency) if (batchIds.includes(entry.request.batchId)
        || entry.request.batchOperations?.[0]?.values?.name?.startsWith(args.p_marker)) this.idempotency.delete(key);
      return this.response({ ok: true, deleted: before, residual: this.residual(args.p_marker) });
    }
    assert.equal(functionName, 'erp_apply_purchase_batch_transaction');
    return this.response(this.apply(args.p_idempotency_key, args.p_request));
  }

  apply(key, request) {
    const fingerprint = JSON.stringify(request);
    const previous = this.idempotency.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' };
      return { ...clone(previous.result), replayed: true };
    }
    const batches = new Map([...this.batches].map(([id, row]) => [id, clone(row)]));
    const items = new Map([...this.items].map(([id, row]) => [id, clone(row)]));
    const fail = (code, entity = undefined, recordId = undefined) => ({ ok: false, code, entity, recordId });

    if (request.operationType === 'edit' && !batches.has(request.batchId)) return fail('RECORD_DELETED_OR_MISSING', 'purchase_batches', request.batchId);
    for (const operation of request.itemOperations) {
      if (operation.kind !== 'create') {
        const current = items.get(operation.id);
        if (!current || current.purchase_batch_id !== request.batchId) return fail('RECORD_DELETED_OR_MISSING', 'purchase_batch_items', operation.id);
      }
    }

    for (const operation of request.batchOperations) {
      if (operation.kind === 'create') batches.set(operation.id, { id: operation.id, ...clone(operation.values), version: 1 });
      if (operation.kind === 'patch') {
        const current = batches.get(operation.id);
        for (const [field, expected] of Object.entries(operation.expected || {})) {
          if (current[field] !== expected) return fail('FIELD_CONFLICT', 'purchase_batches', operation.id);
        }
        batches.set(operation.id, { ...current, ...clone(operation.changes), version: current.version + 1 });
      }
    }
    for (const operation of request.itemOperations) {
      if (operation.kind === 'create') {
        if (operation.values.product_variant_id !== uuid(2)) return fail('TRANSACTION_CONSTRAINT_FAILED', 'purchase_batch_items', operation.id);
        items.set(operation.id, { id: operation.id, ...clone(operation.values), version: 1 });
      } else if (operation.kind === 'patch') {
        const current = items.get(operation.id);
        for (const [field, expected] of Object.entries(operation.expected || {})) {
          if (current[field] !== expected) return fail('FIELD_CONFLICT', 'purchase_batch_items', operation.id);
        }
        items.set(operation.id, { ...current, ...clone(operation.changes), version: current.version + 1 });
      } else if (operation.kind === 'delete') {
        const current = items.get(operation.id);
        if (current.version !== operation.expectedVersion) return fail('STALE_DELETE', 'purchase_batch_items', operation.id);
        items.set(operation.id, { ...current, deleted_at: 'now', version: current.version + 1 });
      }
    }
    this.batches = batches;
    this.items = items;
    const batch = batches.get(request.batchId);
    const result = {
      ok: true, operationType: request.operationType, idempotencyKey: key, replayed: false,
      batch: clone(batch),
      items: [...items.values()].filter(item => item.purchase_batch_id === request.batchId && !item.deleted_at).map(clone),
    };
    this.idempotency.set(key, { fingerprint, request: clone(request), result: clone(result) });
    return result;
  }
}

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const module = await vite.ssrLoadModule('/src/lib/stagingP04AuthenticatedHarness.ts');
  assert.doesNotThrow(() => module.assertP04HarnessBoundary({
    projectRef: 'rhfdjsklfrgpoqsaqpkn', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging',
  }));
  for (const boundary of [
    { projectRef: 'twzpqyesbtnfxdkorluf', runtimeRole: 'production', viteMode: 'production', deploymentEnvironment: 'production' },
    { projectRef: 'twzpqyesbtnfxdkorluf', runtimeRole: 'experimental', viteMode: 'experimental', deploymentEnvironment: 'staging' },
    { projectRef: 'rhfdjsklfrgpoqsaqpkn', runtimeRole: 'production', viteMode: 'production', deploymentEnvironment: 'production' },
  ]) assert.throws(() => module.assertP04HarnessBoundary(boundary), /P0_4_STAGING_TEST_HARNESS_DISABLED/u);

  // The immutable controller boundary is authoritative even when the React/UI
  // route guard is completely bypassed. Rejected construction makes zero RPCs.
  for (const boundary of [
    { projectRef: 'twzpqyesbtnfxdkorluf', runtimeRole: 'production', viteMode: 'production', deploymentEnvironment: 'production' },
    { projectRef: 'twzpqyesbtnfxdkorluf', runtimeRole: 'experimental', viteMode: 'experimental', deploymentEnvironment: 'experimental' },
    { projectRef: 'unknown-project', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: '', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: undefined, runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging' },
    { projectRef: 'rhfdjsklfrgpoqsaqpkn', runtimeRole: 'local', viteMode: 'development', deploymentEnvironment: 'development' },
    { projectRef: 'rhfdjsklfrgpoqsaqpkn', runtimeRole: 'staging', viteMode: undefined, deploymentEnvironment: 'staging' },
  ]) {
    const rpcCalls = [];
    assert.throws(
      () => new module.StagingP04AuthenticatedHarness(boundary, async functionName => {
        rpcCalls.push(functionName);
        return { data: null, error: null };
      }),
      /P0_4_STAGING_TEST_HARNESS_DISABLED/u,
    );
    assert.equal(rpcCalls.length, 0, `Rejected controller must make zero RPCs: ${JSON.stringify(boundary)}`);
  }

  // Defense in depth: even an artificial caller that bypasses both React and
  // the constructor cannot reach apply/cleanup/residual with a Production or
  // unknown identity. This directly exercises the final RPC boundaries.
  for (const projectRef of ['twzpqyesbtnfxdkorluf', 'unknown-project', '', undefined]) {
    const rpcCalls = [];
    const bypassed = Object.create(module.StagingP04AuthenticatedHarness.prototype);
    Object.defineProperties(bypassed, {
      environment: { value: Object.freeze({
        projectRef,
        runtimeRole: projectRef === 'twzpqyesbtnfxdkorluf' ? 'production' : 'staging',
        viteMode: projectRef === 'twzpqyesbtnfxdkorluf' ? 'production' : 'staging',
        deploymentEnvironment: projectRef === 'twzpqyesbtnfxdkorluf' ? 'production' : 'staging',
      }) },
      invokeRpc: { value: async functionName => {
        rpcCalls.push(functionName);
        return { data: null, error: null };
      } },
      marker: { value: 'P0-4-IDEMPOTENCY-TEST-BOUNDARY-BYPASS' },
    });
    const request = { operationType: 'create', batchId: uuid(900), batchOperations: [], itemOperations: [] };
    await assert.rejects(async () => bypassed.apply(uuid(901), request), /P0_4_STAGING_TEST_HARNESS_DISABLED/u);
    await assert.rejects(async () => bypassed.cleanup(), /P0_4_STAGING_TEST_HARNESS_DISABLED/u);
    await assert.rejects(async () => bypassed.residuals(), /P0_4_STAGING_TEST_HARNESS_DISABLED/u);
    assert.equal(rpcCalls.length, 0, `Final boundaries must make zero RPCs: ${String(projectRef)}`);
  }

  const mutableInput = {
    projectRef: 'rhfdjsklfrgpoqsaqpkn', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging',
  };
  const immutableServer = new FakeAuthenticatedRpcServer();
  const immutableHarness = new module.StagingP04AuthenticatedHarness(mutableInput, immutableServer.rpc.bind(immutableServer));
  mutableInput.projectRef = 'twzpqyesbtnfxdkorluf';
  assert.equal(immutableHarness.environment.projectRef, 'rhfdjsklfrgpoqsaqpkn');
  assert.equal(Object.isFrozen(immutableHarness.environment), true);

  let sequence = 10;
  const createUuid = () => uuid(sequence++);
  for (const scenario of module.P0_4_HARNESS_SCENARIOS.map(entry => entry.id)) {
    const server = new FakeAuthenticatedRpcServer();
    const harness = new module.StagingP04AuthenticatedHarness({
      projectRef: 'rhfdjsklfrgpoqsaqpkn', runtimeRole: 'staging', viteMode: 'staging', deploymentEnvironment: 'staging',
    }, server.rpc.bind(server), createUuid, () => new Date('2026-09-08T12:00:00Z'));
    assert.match(harness.marker, /^P0-4-IDEMPOTENCY-TEST-/u);
    assert.equal((await harness.loadStatus()).editor, true);
    const result = await harness.run(scenario);
    assert.equal(result.passed, true, scenario);
    const cleanup = await harness.cleanup();
    assert.deepEqual(cleanup.residual, { purchaseBatches: 0, purchaseBatchItems: 0, idempotencyKeys: 0 }, scenario);
  }
} finally {
  await vite.close();
}

assert.match(SQL, /request\.headers[\s\S]+rhfdjsklfrgpoqsaqpkn\.supabase\.co/u);
assert.match(SQL, /auth\.uid\(\) IS NULL OR NOT public\.is_editor\(auth\.uid\(\)\)/u);
assert.match(SQL, /\^P0-4-IDEMPOTENCY-TEST-/u);
assert.match(SQL, /batch\.updated_by = v_actor/u);
assert.match(SQL, /idem\.actor_id = v_actor/u);
assert.match(SQL, /REVOKE ALL ON FUNCTION public\.erp_p0_4_authenticated_test_cleanup\(text\) FROM anon/u);
assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.erp_p0_4_authenticated_test_cleanup\(text\) TO authenticated/u);
assert.doesNotMatch(SQL, /service_role|BYPASSRLS|ALTER TABLE|DISABLE ROW LEVEL SECURITY/u);
assert.match(PAGE, /STAGING TEST ONLY/u);
assert.match(PAGE, /token exposure = 0/u);
assert.match(APP, /\/__staging\/p0-4-auth-harness/u);

if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
const browserVite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/staging-p0-4-auth-harness-vite.config.mjs',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
browserVite.stdout.on('data', chunk => { output += String(chunk); });
browserVite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const url = `http://127.0.0.1:${PORT}/tests/fixtures/staging-p0-4-auth-harness.html`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (browserVite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(url)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    const cloudRequests = [];
    page.on('request', request => { if (/\.supabase\.co\//u.test(request.url())) cloudRequests.push(request.url()); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('p0-4-auth-harness').waitFor();
    await page.getByText('STAGING TEST ONLY', { exact: true }).waitFor();
    await page.getByTestId('harness-project-ref').getByText('rhfdjsklfrgpoqsaqpkn').waitFor();
    await page.getByTestId('harness-authenticated').getByText('present').waitFor();
    await page.getByTestId('harness-role').getByText('owner').waitFor();
    await page.getByTestId('harness-editor').getByText('true').waitFor();
    const select = page.locator('#p0-4-case');
    for (const scenario of ['normal-create', 'concurrent-duplicate', 'cross-batch-protection']) {
      await select.selectOption(scenario);
      assert.equal(await select.inputValue(), scenario);
    }
    assert.equal(cloudRequests.length, 0, 'Page render and case selection must not call Cloud');
  } finally {
    await browser.close();
  }
} finally {
  browserVite.kill();
}

const productionPort = String(Number(PORT) + 1);
const productionVite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--config', 'tests/fixtures/staging-p0-4-auth-harness-vite.config.mjs',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', productionPort, '--strictPort',
], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, P0_4_HARNESS_FIXTURE_TARGET: 'production' },
});
let productionOutput = '';
productionVite.stdout.on('data', chunk => { productionOutput += String(chunk); });
productionVite.stderr.on('data', chunk => { productionOutput += String(chunk); });
try {
  const url = `http://127.0.0.1:${productionPort}/tests/fixtures/staging-p0-4-auth-harness.html`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (productionVite.exitCode !== null) throw new Error(`Production fixture Vite exited early:\n${productionOutput}`);
    try { if ((await fetch(url)).ok) break; } catch { /* starting */ }
    if (attempt === 79) throw new Error(`Production fixture Vite start timeout:\n${productionOutput}`);
    await sleep(250);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    const cloudRequests = [];
    page.on('request', request => { if (/\.supabase\.co\//u.test(request.url())) cloudRequests.push(request.url()); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('p0-4-harness-blocked').waitFor();
    await page.getByText('此測試入口只允許隔離的 Staging runtime。', { exact: true }).waitFor();
    assert.equal(await page.locator('button').count(), 0);
    assert.equal(cloudRequests.length, 0, 'Production hard-block must happen before an RPC request');
  } finally {
    await browser.close();
  }
} finally {
  productionVite.kill();
}

console.log('PASS Staging-only and Production hard-block boundaries');
console.log('PASS App authenticated session reuse with token exposure=0');
console.log('PASS all 11 functional harness scenarios through the normal authenticated RPC contract');
console.log('PASS fixture marker scope, actor scope, cleanup, and residual=0 contract');
console.log('PASS actual React Staging test UI render and interaction without credential access');
