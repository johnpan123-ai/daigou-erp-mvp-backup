import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:4267';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'experimental', '--host', '127.0.0.1', '--port', '4267', '--strictPort'], { stdio: 'pipe' });
let output = '';
vite.stderr.on('data', bytes => { output += bytes; });
vite.stdout.on('data', bytes => { output += bytes; });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin)).ok) break; } catch { /* startup */ }
    if (i > 80 || vite.exitCode !== null) throw Error(output);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ executablePath: process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  const page = await browser.newPage();
  const liveRequests = [];
  await page.route('**/*.supabase.co/**', route => { liveRequests.push(route.request().url()); return route.abort(); });
  await page.goto(`${origin}/tests/fixtures/cloud-p0-2-react-harness.html?route=/outbound-shipments/out-react-1`);
  await page.getByRole('button', { name: '✏️', exact: true }).waitFor();
  await page.evaluate(() => window.__P0_REACT_HARNESS__.fallback('reconnect', ['outboundShipments']));
  await page.getByRole('button', { name: '✏️', exact: true }).click();
  const input = page.locator('input').first();
  await input.fill('DRAFT A');
  const change = async (id, patch) => page.evaluate(async ({ id, patch }) => {
    const h = window.__P0_REACT_HARNESS__;
    const row = h.server.outboundShipments.find(r => r.id === id) || { ...h.server.outboundShipments[0], id };
    await h.emitUpsert('outbound_shipments', { ...row, ...patch });
  }, { id, patch });
  const conflict = () => page.getByRole('alert').filter({ hasText: '資料已被其他使用者更新' }).count();
  await change('out-other', { title: 'Remote B', version: 2 });
  assert.equal(await conflict(), 0, 'unrelated record B must not conflict with draft A');
  await change('out-react-1', { version: 3, updated_at: '2026-09-22T00:00:00Z', updated_by: 'same-account' });
  assert.equal(await conflict(), 0, 'metadata-only update must not conflict');
  assert.equal(await input.inputValue(), 'DRAFT A');
  const cachedVersion = await page.evaluate(async () => {
    const { cloudCacheDb } = await import('/src/lib/db.ts');
    return (await cloudCacheDb.getOutboundShipments()).find(r => r.id === 'out-react-1').version;
  });
  assert.equal(cachedVersion, 3, 'metadata must advance the cached CAS version');
  await page.evaluate(() => window.__P0_REACT_HARNESS__.fallback('reconnect', ['outboundShipments']));
  assert.equal(await conflict(), 0, 'unchanged reconnect must not invent conflict');
  await change('out-react-1', { title: 'Remote A changed', version: 4, updated_by: 'same-account' });
  assert.equal(await conflict(), 1, 'same-account other client business change must conflict');
  assert.equal(await input.inputValue(), 'DRAFT A');
  await change('out-other', { title: 'Remote B again', version: 3 });
  assert.equal(await conflict(), 1, 'unrelated refresh must not clear the genuine conflict');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByText('Remote A changed', { exact: true }).waitFor();
  assert.equal(await conflict(), 0);
  await change('out-react-1', { title: 'Same account auto-converged', version: 5, updated_by: 'same-account' });
  await page.getByText('Same account auto-converged', { exact: true }).waitFor();
  assert.equal(await conflict(), 0, 'relevant same-account update without draft converges without prompt');
  await page.getByRole('button', { name: '✏️', exact: true }).click();
  await input.fill('Saved A only');
  await change('out-other', { title: 'B must survive A save', version: 6 });
  assert.equal(await conflict(), 0);
  await page.getByRole('button', { name: '儲存', exact: true }).click();
  await page.getByText('Saved A only', { exact: true }).waitFor();
  const untouched = await page.evaluate(() => window.__P0_REACT_HARNESS__.server.outboundShipments.find(r => r.id === 'out-other').title);
  assert.equal(untouched, 'B must survive A save', 'Saving A must not revert the stale page copy of B');
  const result = await page.evaluate(async () => {
    const h = window.__P0_REACT_HARNESS__;
    const row = h.server.outboundShipments.find(r => r.id === 'out-react-1');
    await h.emitSelfEcho('outbound_shipments', row);
    await h.emitDuplicate('outbound_shipments', row);
    return h.snapshot();
  });
  assert.equal(result.metrics.fullPulls, 0);
  assert.equal(await conflict(), 0);
  const ordering = await page.evaluate(async () => {
    const { CloudTargetedCache } = await import('/src/providers/cloud/cloudTargetedCache.ts');
    const { cloudCacheDb } = await import('/src/lib/db.ts');
    const h = window.__P0_REACT_HARNESS__;
    const base = h.server.outboundShipments.find(r => r.id === 'out-react-1');
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    let calls = 0;
    const cache = new CloudTargetedCache({ protectsDraft: () => false, query: async () => {
      const version = ++calls;
      if (version === 1) { started(); await new Promise(resolve => { release = resolve; }); }
      return [{ ...base, version: 10 + version, title: `ordered-${version}` }];
    }});
    const request = { reason: 'realtime', resources: ['outboundShipments'], changes: [{ table: 'outbound_shipments', databaseId: base.id, canonicalId: base.id, localId: null, resource: 'outboundShipments', kind: 'UPDATE' }] };
    const first = cache.refreshWithResult(request);
    await entered;
    const second = cache.refreshWithResult(request);
    release();
    await Promise.all([first, second]);
    const latest = (await cloudCacheDb.getOutboundShipments()).find(r => r.id === base.id);
    const old = new CloudTargetedCache({ protectsDraft: () => false, query: async () => [{ ...base, version: 1, title: 'STALE' }] });
    await old.refreshWithResult(request);
    const afterOld = (await cloudCacheDb.getOutboundShipments()).find(r => r.id === base.id);
    return { calls, latest: latest.title, afterOld: afterOld.title };
  });
  assert.deepEqual(ordering, { calls: 2, latest: 'ordered-2', afterOld: 'ordered-2' });
  assert.equal(liveRequests.length, 0);
  console.log('PASS real Outbound route: unrelated/metadata/same-account/draft/reconnect/echo/duplicate; fullPulls=0, liveCalls=0');
} finally {
  await browser?.close();
  vite.kill();
}
