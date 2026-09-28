import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOUD_FIELD_CAS_REACT_PORT || '4223';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/tests/fixtures/cloud-p0-2-react-harness.html?route=%2Fpurchasing`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--configLoader', 'runner',
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    try { if ((await fetch(BASE_URL)).ok) break; } catch { /* server starting */ }
    if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
    await sleep(250);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('erp_provider_mode', 'experimental'));
  const page = await context.newPage();
  const cloudRequests = [];
  page.on('request', request => { if (/\.supabase\.co\//iu.test(request.url())) cloudRequests.push(request.url()); });
  try {
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__?.snapshot().metrics));
    await page.locator('.summary-card').first().click();
    await page.getByRole('button', { name: '新增採購批次' }).click();
    const input = page.locator('#purchase-batch-modal input').first();
    await input.fill('保留中的使用者草稿');

    const eventResult = await page.evaluate(async () => {
      const module = await import('/src/providers/cloud/cloudFieldCas.ts');
      const failure = {
        ok: false,
        code: 'FIELD_CONFLICT',
        entity: 'purchase_batch_items',
        recordId: '10000000-0000-4000-8000-000000000001',
        conflicts: [{ field: 'quantity', expected: 5, current: 7 }],
      };
      const error = new module.CloudFieldMutationError(failure);
      module.notifyCloudFieldMutationConflict(error);
      module.notifyCloudFieldMutationConflict(error);
      return { code: error.code, conflicts: error.conflicts };
    });

    const banner = page.locator('[data-cloud-field-conflict]');
    await banner.waitFor();
    assert.equal(await banner.textContent(), '資料已由其他裝置更新，請重新確認後再儲存。×');
    assert.equal(await page.locator('[data-cloud-field-conflict]').count(), 1, 'Duplicate conflict emitted duplicate UI');
    assert.equal(await input.inputValue(), '保留中的使用者草稿', 'Conflict UI cleared the active draft');
    assert.equal(eventResult.code, 'FIELD_CONFLICT');
    assert.deepEqual(eventResult.conflicts, [{ field: 'quantity', expected: 5, current: 7 }]);
    assert.equal(cloudRequests.length, 0);
    console.log('PASS actual React conflict banner is non-duplicating and preserves the active modal draft');
    console.log('PASS structured conflict metadata survives the provider-to-UI boundary');
  } finally {
    await context.close();
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
