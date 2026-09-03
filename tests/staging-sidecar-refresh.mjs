import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const rootPath = fileURLToPath(new URL('../', import.meta.url));
const baseUrl = 'http://127.0.0.1:4190';
const chromePath = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(chromePath)) throw new Error(`Chrome not found: ${chromePath}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'next', '--host', '127.0.0.1', '--port', '4190', '--strictPort',
], { cwd: rootPath, stdio: ['ignore', 'pipe', 'pipe'] });
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
  try {
    if ((await fetch(baseUrl)).ok) break;
  } catch {}
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage();
const supabaseRequests = [];
page.on('request', request => {
  if (request.url().includes('.supabase.co/')) supabaseRequests.push(request.url());
});
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const sidecar = await import('/src/lib/stagingSidecarRefresh.ts');
    const firstBackup = await sidecar.createStagingSidecarRefreshBackup();
    let invalidRejected = false;
    try {
      await sidecar.reinitializeStagingSidecarAfterRefresh({
        backup: firstBackup,
        confirmedBackupHash: 'wrong',
        newProductVariantIdentityHash: 'a'.repeat(64),
      });
    } catch (error) {
      invalidRejected = String(error).includes('CONFIRMATION_MISMATCH');
    }
    const reset = await sidecar.reinitializeStagingSidecarAfterRefresh({
      backup: firstBackup,
      confirmedBackupHash: firstBackup.snapshotHash,
      newProductVariantIdentityHash: 'b'.repeat(64),
    });
    const afterBackup = await sidecar.createStagingSidecarRefreshBackup();
    return { firstBackup, invalidRejected, reset, afterBackup };
  });
  assert.equal(result.invalidRejected, true);
  assert.equal(result.firstBackup.snapshotHash.length, 64);
  assert.equal(result.reset.productVariantIdentityHash, 'b'.repeat(64));
  assert.ok(Object.values(result.afterBackup.storeCounts).every(count => count === 0));
  assert.deepEqual(supabaseRequests, []);
  console.log('PASS Staging sidecar backup is hashed before any reset');
  console.log('PASS reset requires the exact backup hash and creates an empty new sidecar');
  console.log('PASS sidecar workflow makes zero Supabase requests');
} finally {
  await browser.close();
  vite.kill('SIGTERM');
}
