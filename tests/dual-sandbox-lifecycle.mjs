import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SERVERS = [
  { mode: 'next', port: 4232, label: 'NEXT SANDBOX', db: 'daigou-erp-db-next-v1' },
  { mode: 'experimental', port: 4233, label: 'EXPERIMENTAL', db: 'daigou-erp-db-experimental-v1' },
];

if (!existsSync(SNAPSHOT_PATH) || !existsSync(CHROME_PATH)) throw new Error('Snapshot or Chrome is missing');
const snapshotBytes = [...await readFile(SNAPSHOT_PATH)];
const snapshotName = SNAPSHOT_PATH.split(/[\\/]/).at(-1);
const processes = SERVERS.map(({ mode, port }) => spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', mode, '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }));
const output = processes.map(() => '');
processes.forEach((child, index) => {
  child.stdout.on('data', chunk => { output[index] += String(chunk); });
  child.stderr.on('data', chunk => { output[index] += String(chunk); });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForServer(server, child, index) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${server.mode} exited early:\n${output[index]}`);
    try { if ((await fetch(`http://127.0.0.1:${server.port}/`)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`${server.mode} did not start:\n${output[index]}`);
}
const closeServers = () => processes.forEach(child => child.kill('SIGTERM'));
process.on('exit', closeServers);

let browser;
try {
  await Promise.all(SERVERS.map((server, index) => waitForServer(server, processes[index], index)));
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const pages = await Promise.all(SERVERS.map(async server => {
    const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    const requests = [];
    const page = await context.newPage();
    page.on('request', request => { if (/supabase\.co/i.test(request.url())) requests.push(request.url()); });
    await page.goto(`http://127.0.0.1:${server.port}/dashboard`, { waitUntil: 'networkidle' });
    await page.getByText(server.label, { exact: false }).first().waitFor();
    return { context, page, server, requests };
  }));

  const importSnapshot = page => page.evaluate(async ({ bytes, name }) => {
    const importer = await import('/src/lib/testSnapshotImport.ts');
    const candidate = await importer.prepareTestSnapshotFile(new File([new Uint8Array(bytes)], name));
    return importer.importTestSnapshot(candidate);
  }, { bytes: snapshotBytes, name: snapshotName });
  const productGroups = page => page.evaluate(async () => (await window.dataProvider.getProductGroups()).map(group => group.id));
  const clearSandbox = page => page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    await environment.clearSandboxData();
  });
  const productionSnapshot = page => page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot('daigou-erp-db');
  });

  const imported = await Promise.all(pages.map(({ page }) => importSnapshot(page)));
  assert.deepEqual(imported[0].counts, imported[1].counts, '兩 Sandbox 初次 Snapshot 筆數不同');

  await Promise.all(pages.map(({ page, server }) => page.evaluate(async mode => {
    const now = new Date().toISOString();
    await window.dataProvider.saveProductGroups([{
      id: `${mode}-lifecycle-only`, title: `${mode}-lifecycle-only`, status: 'active', created_at: now, updated_at: now,
    }]);
  }, server.mode)));
  await Promise.all(pages.map(({ page }) => page.reload({ waitUntil: 'networkidle' })));
  assert.ok((await productGroups(pages[0].page)).includes('next-lifecycle-only'));
  assert.ok((await productGroups(pages[1].page)).includes('experimental-lifecycle-only'));

  await clearSandbox(pages[0].page);
  await pages[0].page.reload({ waitUntil: 'networkidle' });
  await pages[1].page.reload({ waitUntil: 'networkidle' });
  assert.equal((await productGroups(pages[0].page)).length, 0, '清空 Next 後仍有資料');
  assert.ok((await productGroups(pages[1].page)).includes('experimental-lifecycle-only'), '清空 Next 影響 Experimental');

  await clearSandbox(pages[1].page);
  await pages[1].page.reload({ waitUntil: 'networkidle' });
  assert.equal((await productGroups(pages[1].page)).length, 0, '清空 Experimental 後仍有資料');

  const nextImport = await importSnapshot(pages[0].page);
  await pages[0].page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(nextImport.counts, (await importSnapshot(pages[1].page)).counts, '重新匯入兩 Sandbox 筆數不同');
  await Promise.all(pages.map(({ page }) => page.reload({ waitUntil: 'networkidle' })));

  const after = await Promise.all(pages.map(({ page }) => productionSnapshot(page)));
  assert.deepEqual(after[0], after[1], 'Production IndexedDB 在兩 context 中不一致');
  assert.deepEqual(pages.map(({ requests }) => requests), [[], []], 'Sandbox lifecycle 產生 Supabase request');

  console.log('PASS Snapshot import, F5, independent clear, and independent re-import lifecycle');
  console.log('PASS clearing either Sandbox leaves the other Sandbox unchanged');
  console.log('PASS Production IndexedDB and Supabase request count remain unchanged');
} finally {
  if (browser) await browser.close();
  closeServers();
}
