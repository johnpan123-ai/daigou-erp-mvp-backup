import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SERVERS = [
  { mode: 'next', port: 4202, label: 'NEXT SANDBOX', db: 'daigou-erp-db-next-v1', prefix: '__hippo_next_sandbox__::' },
  { mode: 'experimental', port: 4203, label: 'EXPERIMENTAL', db: 'daigou-erp-db-experimental-v1', prefix: '__hippo_experimental_sandbox__::' },
];

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const processes = SERVERS.map(({ mode, port }) => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
    '--mode', mode, '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += String(chunk); });
  child.stderr.on('data', chunk => { child.output += String(chunk); });
  return child;
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer(server, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${server.mode} exited early:\n${child.output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(250);
  }
  throw new Error(`${server.mode} did not start:\n${child.output}`);
}

const closeServers = () => processes.forEach(child => child.kill('SIGTERM'));
process.on('exit', closeServers);

let browser;
try {
  await Promise.all(SERVERS.map((server, index) => waitForServer(server, processes[index])));
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const pages = await Promise.all(SERVERS.map(async server => {
    const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    const requests = [];
    const page = await context.newPage();
    page.on('request', request => {
      if (/supabase\.co/i.test(request.url())) requests.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${server.port}/dashboard`, { waitUntil: 'networkidle' });
    await page.getByText(server.label, { exact: false }).first().waitFor();
    return { context, page, server, requests };
  }));

  const boot = await Promise.all(pages.map(({ page, server }) => page.evaluate(expected => ({
    mode: localStorage.getItem('erp_provider_mode'),
    title: document.title,
    dbs: expected,
  }), server)));
  assert.deepEqual(boot.map(item => item.mode), ['next', 'experimental']);
  assert.equal(boot[0].title, '[NEXT] 小河馬 ERP');
  assert.equal(boot[1].title, '[EXPERIMENTAL] 小河馬 ERP');

  const ownRows = await Promise.all(pages.map(({ page, server }) => page.evaluate(async ({ mode }) => {
    const now = new Date().toISOString();
    await window.dataProvider.saveProductGroups([{
      id: `${mode}-only-group`, title: `${mode.toUpperCase()}-ONLY-TEST`, status: 'active', created_at: now, updated_at: now,
    }]);
    localStorage.setItem('erp_search_term', `${mode}-only-search`);
    sessionStorage.setItem('erp_session_marker', `${mode}-only-session`);
    const groups = await window.dataProvider.getProductGroups();
    return groups.filter(group => group.id.endsWith('-only-group')).map(group => group.id);
  }, { mode: server.mode })));
  assert.deepEqual(ownRows, [['next-only-group'], ['experimental-only-group']]);

  const crossVisibility = await Promise.all(pages.map(({ page }) => page.evaluate(async () => {
    const groups = await window.dataProvider.getProductGroups();
    return groups.filter(group => String(group.id).includes('-only-group')).map(group => group.id).sort();
  })));
  assert.deepEqual(crossVisibility[0], ['next-only-group']);
  assert.deepEqual(crossVisibility[1], ['experimental-only-group']);

  const storage = await Promise.all(pages.map(({ page, server }) => page.evaluate(async expected => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      db: (await environment.readPhysicalIndexedDbSnapshot(expected.db)).erp_product_groups ?? [],
      search: environment.readPhysicalLocalStorageValue(`${expected.prefix}erp_search_term`),
      session: environment.readPhysicalSessionStorageValue(`${expected.prefix}erp_session_marker`),
      production: await environment.readPhysicalIndexedDbSnapshot('daigou-erp-db'),
    };
  }, server)));
  assert.equal(storage[0].search, 'next-only-search');
  assert.equal(storage[1].search, 'experimental-only-search');
  assert.equal(storage[0].session, 'next-only-session');
  assert.equal(storage[1].session, 'experimental-only-session');
  assert.ok(storage[0].db.some(row => row.id === 'next-only-group'));
  assert.ok(storage[1].db.some(row => row.id === 'experimental-only-group'));
  const productionGroups = [storage[0].production.erp_product_groups ?? [], storage[1].production.erp_product_groups ?? []];
  assert.ok(!productionGroups[0].some(row => row.id === 'next-only-group' || row.id === 'experimental-only-group'));
  assert.ok(!productionGroups[1].some(row => row.id === 'next-only-group' || row.id === 'experimental-only-group'));

  const networkResults = await Promise.all(pages.map(({ page }) => page.evaluate(async () => {
    const { supabase } = await import('/src/providers/cloud/supabaseClient.ts');
    try {
      await fetch(`${supabase.supabaseUrl}/rest/v1/product_groups?select=id`);
      return false;
    } catch (error) {
      return error?.name === 'TestSandboxProductionNetworkBlockedError'
        || String(error).includes('Test Sandbox blocked');
    }
  })));
  assert.deepEqual(networkResults, [true, true]);
  assert.deepEqual(pages.map(({ requests }) => requests), [[], []]);

  console.log('PASS Next and Experimental boot with distinct labels, titles, DBs, and storage namespaces');
  console.log('PASS NEXT-ONLY-TEST and EXPERIMENTAL-ONLY-TEST remain isolated');
  console.log('PASS both Sandbox Supabase request paths are fail-closed with zero requests leaving the browser');
} finally {
  if (browser) await browser.close();
  closeServers();
}
