import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT_PATH = fileURLToPath(new URL('../', import.meta.url));
const BASE_URL = 'http://127.0.0.1:4198';
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SNAPSHOT_PATH = process.env.P0_GH_SNAPSHOT || 'C:\\Users\\小河馬\\Downloads\\workbench-backup-2026-08-15.json';

if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);
if (!existsSync(SNAPSHOT_PATH)) throw new Error(`Snapshot not found: ${SNAPSHOT_PATH}`);

const sourceText = readFileSync(SNAPSHOT_PATH, 'utf8');
const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'next', '--host', '127.0.0.1', '--port', '4198', '--strictPort',
], { cwd: ROOT_PATH, stdio: ['ignore', 'pipe', 'pipe'] });

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(250);
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
}

await waitForServer();
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'next'));
const page = await context.newPage();
const productionSupabaseRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) productionSupabaseRequests.push(request.url());
});

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const immediate = await page.evaluate(async text => {
    const importer = await import('/src/lib/testSnapshotImport.ts');
    const probe = await import('/src/lib/nextRawDbIntegrityProbe.ts');
    const file = new File([text], 'workbench-backup-2026-08-15.json', { type: 'application/json' });
    const candidate = await importer.prepareTestSnapshotFile(file);
    const result = await importer.importTestSnapshot(candidate);
    const source = probe.parseWorkbenchBackup(text);
    const raw = await probe.readNextRawCollections();
    return {
      importCounts: result.verifiedCounts,
      report: await probe.buildNextRawIntegrityReport(source, raw),
    };
  }, sourceText);

  assert.equal(
    Object.values(immediate.report.collectionHashes).every(entry => entry.equal),
    true,
    'JSON → importer → immediate Next raw must preserve every probed collection exactly',
  );
  assert.deepEqual(immediate.report.referentialIntegrity.increasedRelations, []);

  await page.reload({ waitUntil: 'networkidle' });
  const afterAppReload = await page.evaluate(async text => {
    const probe = await import('/src/lib/nextRawDbIntegrityProbe.ts');
    const source = probe.parseWorkbenchBackup(text);
    const raw = await probe.readNextRawCollections();
    return probe.buildNextRawIntegrityReport(source, raw);
  }, sourceText);

  assert.equal(
    Object.values(afterAppReload.collectionHashes).every(entry => entry.equal),
    true,
    'App reload must not rewrite the imported raw collections',
  );
  assert.deepEqual(afterAppReload.referentialIntegrity.increasedRelations, []);
  assert.deepEqual(productionSupabaseRequests, [], 'Next diagnostic/import must make zero Production Supabase requests');

  console.log(JSON.stringify({
    source: SNAPSHOT_PATH,
    immediateCounts: immediate.report.collectionCounts,
    immediateHashesEqual: Object.fromEntries(Object.entries(immediate.report.collectionHashes).map(([key, value]) => [key, value.equal])),
    afterReloadHashesEqual: Object.fromEntries(Object.entries(afterAppReload.collectionHashes).map(([key, value]) => [key, value.equal])),
    orphanIncrease: afterAppReload.referentialIntegrity.increasedRelations,
    targetGroups: afterAppReload.targetGroups.map(group => ({
      id: group.id,
      source: group.source.totals,
      nextRaw: group.nextRaw.totals,
      differences: group.differences,
    })),
    productionSupabaseRequests: productionSupabaseRequests.length,
  }, null, 2));
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
