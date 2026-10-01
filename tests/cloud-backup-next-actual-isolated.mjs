import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const index = process.argv.indexOf('--backup');
if (index < 0) throw new Error('Use --backup <local Cloud backup>; disposable browser only');
const path = resolve(process.argv[index + 1]);
const raw = await readFile(path, 'utf8');
const modules = await createServer({ configFile: false,
  cacheDir: join(tmpdir(), 'actual-cloud-next-module-' + process.pid),
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
let expected;
try {
  const bridge = await modules.ssrLoadModule('/src/providers/cloud/cloudBackupToNext.ts');
  expected = await bridge.prepareCloudBackupForNextRestore(raw, { fileName: 'actual-cloud-backup.json' });
  assert.equal(expected.summary.targetResourceCount, 24);
  assert.equal(expected.summary.blockingOrphanCount, 0);
} finally { await modules.close(); }
const origin = 'http://127.0.0.1:4395';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode','next','--host','127.0.0.1',
  '--port','4395','--strictPort','--configLoader','runner'], { stdio: 'ignore',
  env: { ...process.env, VITE_DEPLOYMENT_ENV: 'next' } });
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(origin)).ok) break; } catch { /* starting */ }
    if (attempt === 99 || vite.exitCode !== null) throw new Error('ISOLATED_NEXT_BOOTSTRAP_FAILED');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  browser = await chromium.launch({ headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext(); const page = await context.newPage();
  let cloudRequests = 0; const errors = [];
  await context.route(/https:\/\/.*\.supabase\.co\//u, route => { cloudRequests += 1; return route.abort(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/settings', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.dataProvider));
  await page.getByTestId('settings-restore-file-input').setInputFiles(path);
  await page.getByTestId('cloud-restore-preview').waitFor({ timeout: 90_000 });
  assert.equal(await page.getByTestId('cloud-restore-resource-count').textContent(), '24');
  assert.equal(await page.getByTestId('cloud-restore-orphan-count').textContent(), '0');
  page.once('dialog', dialog => dialog.accept());
  await page.getByTestId('cloud-restore-confirm').click();
  await page.getByTestId('cloud-restore-success').waitFor({ timeout: 90_000 });
  const read = () => page.evaluate(async () => {
    const provider = window.dataProvider;
    const waca = await provider.getNextWacaSnapshot();
    const { readDeadlineDurableBackup } = await import('/src/lib/closingDateSidecarBackup.ts');
    const deadline = await readDeadlineDurableBackup('next');
    const [groups, variants, inventory] = await Promise.all([
      provider.getProductGroups(), provider.getProductVariants({raw:true}), provider.getInventory()]);
    return { groups: groups.length, variants: variants.length, inventory: inventory.length,
      orders: waca.orders.length, items: waca.items.length, mappings: waca.mappings.length,
      audit: waca.cutoverAudit.length, state: waca.cutoverState?.mode,
      deadline: Object.fromEntries(Object.entries(deadline).map(([store,rows]) => [store,rows.length])) };
  });
  const actual = await read(); const data = expected.workbenchData;
  assert.equal(actual.groups, data.productGroups.length);
  assert.equal(actual.variants, data.productVariants.length);
  assert.equal(actual.inventory, data.inventory.length);
  assert.equal(actual.orders, data.wacaOrders.length);
  assert.equal(actual.items, data.wacaItems.length);
  assert.equal(actual.mappings, data.wacaMappings.length);
  assert.equal(actual.audit, data.wacaCutoverAudit.length);
  await page.reload({waitUntil:'networkidle'}); await page.waitForFunction(() => Boolean(window.dataProvider));
  assert.deepEqual(await read(), actual); assert.equal(cloudRequests,0); assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ result:'PASS', actual, relationships: 'PASS', reload:'PASS',
    cloudRequests, normalNextTouched:false, liveRestore:0 }));
} finally { await browser?.close(); vite.kill(); }
