import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = process.env.CLOSING_DATE_CLOUD_PARITY_PORT || '4312';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/tests/fixtures/cloud-p0-2-react-harness.html`;
const CHROME = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);

const purchaseRecordsSource = readFileSync(new URL('../src/pages/PurchaseRecords.tsx', import.meta.url), 'utf8');
const cloudApplySource = readFileSync(new URL('../src/lib/cloudClosingDateWorkbenchApply.ts', import.meta.url), 'utf8');
assert.match(purchaseRecordsSource, /applyCloudClosingDateResolutionBatch/u);
assert.match(purchaseRecordsSource, /applySelections=\{closingDateWorkbenchMode === 'cloud'/u);
assert.doesNotMatch(cloudApplySource, /updated_at\s*:/u, 'Cloud apply must not synthesize server-owned updated_at');
assert.doesNotMatch(cloudApplySource, /location\.reload|window\.location/u);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'experimental', '--host', '127.0.0.1', '--port', PORT, '--strictPort',
], {
  cwd: ROOT,
  env: {
    ...process.env,
    VITE_SUPABASE_URL: 'https://rhfdjsklfrgpoqsaqpkn.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'local-test-no-network',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
vite.stdout.on('data', chunk => { output += String(chunk); });
vite.stderr.on('data', chunk => { output += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (let attempt = 0; attempt < 80; attempt += 1) {
  if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
  try { if ((await fetch(BASE_URL)).ok) break; } catch { /* starting */ }
  if (attempt === 79) throw new Error(`Vite start timeout:\n${output}`);
  await sleep(250);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ids = {
  multi: '94000000-0000-4000-8000-000000000001',
  delayed: '94000000-0000-4000-8000-000000000002',
  single: '94000000-0000-4000-8000-000000000003',
  empty: '94000000-0000-4000-8000-000000000004',
  failure: '94000000-0000-4000-8000-000000000005',
};

const candidate = (id, name, deadlineAt, sku) => ({
  id,
  name,
  url: `https://catalog.invalid/${id}`,
  brand: { name: 'Good Smile Company' },
  janCode: `45805902${id.slice(-5)}`,
  sku,
  catalog: { supplier: { code: id.includes('second') ? 'dreamlink' : 'wanrong' }, deadlineAt },
});

try {
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  let delayedRequestStarted = false;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.route('**/api/catalog/search**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q') || '';
    if (query.includes('查詢失敗')) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'CATALOG_UNAVAILABLE' }) });
      return;
    }
    let products = [];
    if (query.includes('峰月律')) {
      products = [
        candidate('candidate-first', '黏土人 峰月律', '2026-10-10T08:00:00.000Z', 'NENDOROID-RITSU-A'),
        candidate('candidate-second', '黏土人 峰月律', '2026-10-20T08:00:00.000Z', 'NENDOROID-RITSU-B'),
      ];
    } else if (query.includes('切換測試')) {
      delayedRequestStarted = true;
      await sleep(900);
      products = [candidate('candidate-delayed', '黏土人 切換測試商品', '2026-12-12T08:00:00.000Z', 'DELAYED-A')];
    } else if (query.includes('單一候選')) {
      products = [candidate('candidate-single', '黏土人 單一候選商品', '2026-11-11T08:00:00.000Z', 'SINGLE-A')];
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ products }) });
  });

  await page.goto(
    `${FIXTURE_URL}?route=${encodeURIComponent('/purchase-records')}&closingDateWorkbench=1&providerMode=cloud`,
    { waitUntil: 'domcontentloaded' },
  );
  try {
    await page.waitForFunction(() => Boolean(window.__P0_REACT_HARNESS__));
    await page.getByText('訂購紀錄表', { exact: true }).first().waitFor({ timeout: 30_000 });
  } catch (error) {
    throw new Error(`Cloud parity fixture did not become ready: ${pageErrors.join(' | ')}`, { cause: error });
  }
  // AuthProvider deliberately normalizes the sandbox boot to local. Switch the
  // already stubbed provider identity after mount, then use a real route state
  // change to prove the Cloud-only button branch rather than a helper in isolation.
  await page.evaluate(() => localStorage.setItem('erp_provider_mode', 'cloud'));
  await page.getByRole('button', { name: /代理版商品/u }).click();
  await page.getByText('代理版 GSC 黏土人 峰月律', { exact: true }).waitFor();

  const access = await page.evaluate(async () => {
    const module = await import('/src/lib/closingDateWorkbenchAccess.ts');
    const provider = await import('/src/providers/providerMode.ts');
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return {
      cloud: module.getClosingDateWorkbenchMode('cloud', null, false),
      next: module.getClosingDateWorkbenchMode('next', 'next', true),
      nextDisabled: module.getClosingDateWorkbenchMode('next', 'next', false),
      local: module.getClosingDateWorkbenchMode('local', null, true),
      actualProvider: provider.getProviderMode(),
      actualBuild: environment.getBuildSandboxMode(),
      actualMode: module.getClosingDateWorkbenchMode(),
    };
  });
  assert.deepEqual(access, {
    cloud: 'cloud', next: 'next', nextDisabled: null, local: null,
    actualProvider: 'cloud', actualBuild: 'experimental', actualMode: 'cloud',
  });

  const selected = new Set();
  const chooseOnly = async id => {
    for (const current of [...selected]) {
      if (current === id) continue;
      await page.getByTestId(`purchase-record-select-${current}`).first().uncheck();
      selected.delete(current);
    }
    if (!selected.has(id)) {
      await page.getByTestId(`purchase-record-select-${id}`).first().check();
      selected.add(id);
    }
  };
  const closeWorkbench = async () => {
    await page.getByTestId('closing-date-workbench-close').click();
    await page.getByTestId('closing-date-workbench').waitFor({ state: 'detached' });
  };
  const openAndAnalyze = async id => {
    await chooseOnly(id);
    assert.equal(await page.getByRole('button', { name: '🔍 自動查詢結單日', exact: true }).count(), 0);
    if (await page.getByTestId('open-closing-date-workbench').count() === 0) {
      throw new Error(`Workbench entry missing: ${JSON.stringify({ access, selected: [...selected], body: (await page.locator('body').innerText()).slice(-1200) })}`);
    }
    await page.getByTestId('open-closing-date-workbench').click();
    await page.getByTestId('closing-date-workbench').waitFor();
    await page.getByTestId('closing-date-workbench-analyze').click();
  };

  const beforeMulti = await page.evaluate(id => structuredClone(
    window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === id),
  ), ids.multi);
  await openAndAnalyze(ids.multi);
  await page.getByTestId(`closing-date-result-${ids.multi}`).waitFor({ timeout: 30_000 });
  const multiResult = page.getByTestId(`closing-date-result-${ids.multi}`);
  assert.equal(await multiResult.locator('[data-testid^="closing-date-candidate-"]').count(), 2);
  const second = multiResult.locator('[data-testid^="closing-date-candidate-"]').filter({ hasText: '建議結單：2026/10/18' });
  await second.locator('input[type="radio"]').check();
  assert.match(await page.getByTestId('closing-date-workbench-notice').textContent(), /只有最後確認後才會/u);

  for (const width of [1366, 1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.getByTestId('closing-date-workbench').evaluate(node => ({
      rect: node.querySelector('section').getBoundingClientRect().toJSON(),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(geometry.rect.left >= 0 && geometry.rect.right <= width + 1, `Workbench clipped at ${width}`);
    assert.ok(geometry.scrollWidth <= geometry.innerWidth + 1, `Horizontal overflow at ${width}`);
    assert.equal(await page.getByText('訂購紀錄表', { exact: true }).first().count(), 1, 'Mounted route content was replaced');
  }
  await page.setViewportSize({ width: 1366, height: 900 });

  await page.getByTestId('closing-date-workbench-apply').click();
  await page.getByTestId('closing-date-apply-confirmation').waitFor();
  await page.getByTestId('closing-date-apply-confirm').click();
  await page.getByTestId('closing-date-workbench').waitFor({ state: 'detached' });
  await page.getByTestId('closing-date-apply-success').waitFor();
  const afterMulti = await page.evaluate(id => structuredClone(
    window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === id),
  ), ids.multi);
  assert.equal(afterMulti.closing_date, '2026/10/18', 'Selecting the second candidate applied the first candidate');
  const operationEvidence = await page.evaluate(async ({ id, before }) => {
    const fieldCas = await import('/src/providers/cloud/cloudFieldCas.ts');
    const payload = await import('/src/providers/cloud/cloudEntityPayload.ts');
    const saved = window.__P0_REACT_HARNESS__.snapshot().productGroupSaveCalls.at(-1).find(row => row.id === id);
    return fieldCas.buildCloudCollectionMutationPlan(
      'product_groups',
      [payload.toCloudFieldRow('product_groups', before)],
      [payload.toCloudFieldRow('product_groups', saved)],
      { deleteMissing: false },
    );
  }, { id: ids.multi, before: beforeMulti });
  assert.equal(operationEvidence.length, 1);
  assert.deepEqual(Object.keys(operationEvidence[0].changes), ['closing_date']);
  assert.equal(operationEvidence[0].observedVersion, 4);

  const callsAfterMulti = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().productGroupSaveCalls.length);
  await openAndAnalyze(ids.empty);
  await page.getByTestId(`closing-date-result-${ids.empty}`).waitFor({ timeout: 30_000 });
  await page.getByText(/均未取得候選/u).first().waitFor();
  assert.equal(await page.getByTestId('closing-date-workbench-apply').isDisabled(), true);
  await closeWorkbench();
  assert.equal(
    await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().productGroupSaveCalls.length),
    callsAfterMulti,
    'Empty result wrote a closing date',
  );

  await openAndAnalyze(ids.failure);
  await page.getByTestId(`closing-date-result-${ids.failure}`).waitFor({ timeout: 30_000 });
  await page.getByText(/Catalog/u).first().waitFor();
  assert.equal(await page.getByTestId('closing-date-workbench-apply').isDisabled(), true);
  await closeWorkbench();

  await openAndAnalyze(ids.delayed);
  await page.waitForFunction(() => true, null, { timeout: 50 });
  while (!delayedRequestStarted) await sleep(10);
  await closeWorkbench();
  await chooseOnly(ids.single);
  await page.getByTestId('open-closing-date-workbench').click();
  await page.getByTestId('closing-date-workbench-analyze').click();
  await page.getByTestId(`closing-date-result-${ids.single}`).waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId(`closing-date-result-${ids.single}`).count(), 1);
  assert.equal(await page.getByTestId(`closing-date-result-${ids.delayed}`).count(), 0, 'Late A result was shown for B');
  const singleCandidate = page.getByTestId(`closing-date-result-${ids.single}`).locator('[data-testid^="closing-date-candidate-"]');
  assert.equal(await singleCandidate.count(), 1);
  await singleCandidate.locator('input[type="radio"]').check();
  await page.getByTestId('closing-date-workbench-apply').click();
  await page.getByTestId('closing-date-apply-cancel').click();
  await closeWorkbench();
  assert.equal(
    await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().productGroupSaveCalls.length),
    callsAfterMulti,
    'Cancel after selecting a single result changed the date',
  );

  await openAndAnalyze(ids.single);
  await page.getByTestId(`closing-date-result-${ids.single}`).waitFor({ timeout: 30_000 });
  await page.getByTestId(`closing-date-result-${ids.single}`).locator('[data-testid^="closing-date-candidate-"] input[type="radio"]').check();
  const singleBeforeConflict = await page.evaluate(id => structuredClone(
    window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === id),
  ), ids.single);
  await page.evaluate(async id => {
    const harness = window.__P0_REACT_HARNESS__;
    const rows = structuredClone(harness.server.productGroups);
    const row = rows.find(item => item.id === id);
    row.updated_at = '2026-09-24T01:00:00.000Z';
    row.version += 1;
    harness.setServerRows('product_groups', rows);
    await harness.setCacheRows('product_groups', rows);
  }, ids.single);
  await page.getByTestId('closing-date-workbench-apply').click();
  await page.getByTestId('closing-date-apply-confirm').click();
  await page.getByText(/STALE_PRODUCT/u).waitFor();
  assert.equal(await page.getByTestId('closing-date-workbench').count(), 1);
  assert.equal(
    await page.evaluate(id => window.__P0_REACT_HARNESS__.server.productGroups.find(row => row.id === id).closing_date, ids.single),
    singleBeforeConflict.closing_date,
  );
  await closeWorkbench();

  await openAndAnalyze(ids.multi);
  await page.getByTestId(`closing-date-result-${ids.multi}`).waitFor({ timeout: 30_000 });
  await page.getByTestId(`closing-date-result-${ids.multi}`).locator('[data-testid^="closing-date-candidate-"]').first().locator('input[type="radio"]').check();
  await page.evaluate(() => window.__P0_REACT_HARNESS__.failNextProductGroupSave('CLOUD_RESULT_UNKNOWN'));
  const callsBeforeUnknown = await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().productGroupSaveCalls.length);
  await page.getByTestId('closing-date-workbench-apply').click();
  await page.getByTestId('closing-date-apply-confirm').click();
  await page.getByText('CLOUD_RESULT_UNKNOWN').waitFor();
  await sleep(300);
  assert.equal(
    await page.evaluate(() => window.__P0_REACT_HARNESS__.snapshot().productGroupSaveCalls.length),
    callsBeforeUnknown + 1,
    'UNKNOWN result automatically retried',
  );
  assert.equal(await page.getByTestId('closing-date-workbench').count(), 1);
  assert.deepEqual(
    pageErrors.filter(message => !/503 \(Service Unavailable\)/u.test(message)),
    [],
  );

  console.log(JSON.stringify({
    status: 'PASS',
    route: '/purchase-records',
    modes: access,
    multipleCandidates: 2,
    selectedSecondCandidate: afterMulti.closing_date,
    cloudPatchFields: Object.keys(operationEvidence[0].changes),
    cancelWrites: 0,
    emptyResultWrites: 0,
    lateResultIsolation: 'PASS',
    casConflict: 'STALE_PRODUCT / 0 write',
    unknownAutoRetry: 0,
    responsive: [1366, 1280, 390],
  }, null, 2));
  await context.close();
} finally {
  await browser.close();
  vite.kill('SIGTERM');
  await Promise.race([new Promise(resolve => vite.once('exit', resolve)), sleep(2_000)]);
}
