import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 4284;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env.CORE_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME_PATH)) throw new Error(`Chrome not found: ${CHROME_PATH}`);

const purchaseRecordsSource = readFileSync(new URL('../src/pages/PurchaseRecords.tsx', import.meta.url), 'utf8');
const workbenchSource = readFileSync(
  new URL('../src/components/closingDateResolution/ClosingDateResolutionWorkbench.tsx', import.meta.url),
  'utf8',
);
const applySource = readFileSync(new URL('../src/lib/closingDateWorkbenchAtomicApply.ts', import.meta.url), 'utf8');
assert.match(purchaseRecordsSource, /lazy\([\s\S]*ClosingDateResolutionWorkbench/u);
assert.doesNotMatch(
  purchaseRecordsSource,
  /from ['"]\.\.\/lib\/closingDateBatchGateway['"]|from ['"]\.\.\/lib\/closingDateResolutionSidecarRepository['"]/u,
  'PurchaseRecords must not eagerly import Gateway or Sidecar repository',
);
assert.doesNotMatch(
  `${workbenchSource}\n${applySource}`,
  /supabase|canWriteCloud|saveProductGroups|dataProvider/u,
  'Workbench must not access Supabase or use a Provider whole-array save',
);
assert.match(applySource, /database\.transaction\(MAIN_STORE_NAME, 'readwrite'\)/u);
assert.match(applySource, /planAtomicClosingDateApply/u);

const vite = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], {
  cwd: ROOT,
  env: {
    ...process.env,
    VITE_ENABLE_CLOSING_DATE_WORKBENCH_STORAGE: 'true',
    VITE_ENABLE_CLOSING_DATE_BATCH_GATEWAY: 'true',
    VITE_ENABLE_CLOSING_DATE_WORKBENCH_UI: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try { if ((await fetch(BASE_URL)).ok) return; } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error(`Vite start timeout:\n${viteOutput}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  await context.addInitScript(() => {
    localStorage.setItem('erp_provider_mode', 'next');
  });
  const page = await context.newPage();
  const productionSupabaseRequests = [];
  const pageErrors = [];
  const catalogRequests = [];
  page.on('request', request => {
    if (/\.supabase\.co\//iu.test(request.url())) productionSupabaseRequests.push(request.url());
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/catalog/search**', async route => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get('q') || '';
    catalogRequests.push(query);
    await sleep(35);
    let products = [];
    if (query.includes('路西法')) {
      products = [{
        id: 'candidate-green',
        name: 'figma 路西法',
        url: 'https://catalog.invalid/figma-lucifer',
        catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-18T08:00:00.000Z' },
      }];
    } else if (query.includes('峰月律')) {
      products = [{
        id: 'candidate-yellow',
        name: '黏土人 峰月律',
        url: 'https://catalog.invalid/nendoroid-ritsu',
        catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-07T08:00:00.000Z' },
      }];
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ products }),
    });
  });

  await page.goto(`${BASE_URL}/purchase-records`, { waitUntil: 'domcontentloaded' });

  const contractResult = await page.evaluate(async () => {
    const domain = await import('/src/lib/closingDateResolutionDomain.ts');
    const repositoryModule = await import('/src/lib/closingDateResolutionSidecarRepository.ts');
    const schema = await import('/src/lib/closingDateResolutionSidecarSchema.ts');
    const applyModule = await import('/src/lib/closingDateWorkbenchAtomicApply.ts');
    const runtimeModule = await import('/src/lib/closingDateWorkbenchRuntime.ts');
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const now = '2026-08-21T08:30:00.000Z';
    const databaseNames = [];
    const repositories = [];
    const clone = value => JSON.parse(JSON.stringify(value));
    const deleteDatabase = name => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`Delete blocked: ${name}`));
    });
    const makeName = suffix => `${environment.NEXT_SANDBOX_INDEXED_DB_NAME}-workbench-${suffix}-${crypto.randomUUID()}`;
    const openMain = name => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const putGroups = async (name, groups) => {
      const database = await openMain(name);
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('kv', 'readwrite');
        transaction.objectStore('kv').put(groups, 'erp_product_groups');
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
    };
    const readGroups = async name => {
      const database = await openMain(name);
      const groups = await new Promise((resolve, reject) => {
        const request = database.transaction('kv', 'readonly').objectStore('kv').get('erp_product_groups');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return groups;
    };
    const groups = [
      { id: 'contract-green', title: 'ERP Green', purchase_date: '', priority: 'Low', closing_date: '', release_month: '', has_official_site: false, product_url: '', created_at: now, updated_at: now },
      { id: 'contract-yellow', title: 'ERP Yellow', purchase_date: '', priority: 'Low', closing_date: '', release_month: '', has_official_site: false, product_url: '', created_at: now, updated_at: now },
    ];
    const mainName = makeName('main');
    const sidecarName = `${schema.NEXT_CLOSING_DATE_SIDECAR_DB_NAME}-workbench-${crypto.randomUUID()}`;
    databaseNames.push(mainName, sidecarName);
    await putGroups(mainName, groups);
    const repository = repositoryModule.createNextClosingDateResolutionRepository({ databaseName: sidecarName });
    repositories.push(repository);
    await repository.initialize();
    const sourceGreen = { sourceSupplier: 'wanrong', sourceProductId: 'green-source', sourceCatalogId: 'snapshot-1' };
    const mapping = domain.createVerifiedMapping({
      id: 'mapping-contract-green', erpProductGroupId: 'contract-green', source: sourceGreen,
      verificationMethod: 'MANUAL_TOP3_SELECTION', verifiedAt: now, verifiedBy: 'next-owner',
    });
    const makeCompleted = (id, closingDates = ['', '']) => {
      let batch = domain.createResolutionBatch({
        id, idempotencyKey: `idempotency-${id}`, inputHash: `input-${id}`,
        snapshotVersion: 'snapshot-1', ruleVersion: 'closing-date-minus-two-v1',
        productGroupIds: groups.map(group => group.id), createdAt: now,
      });
      batch = domain.transitionResolutionBatch(batch, 'RUNNING', now);
      batch = domain.transitionResolutionBatch(batch, 'COMPLETED', now);
      const green = domain.createResolutionResult({
        id: `${id}:green`, batchId: id, erpProductGroupId: groups[0].id,
        erpTitleAtAnalysis: groups[0].title, productUpdatedAtAtAnalysis: now,
        closingDateAtAnalysis: closingDates[0] || null, activeVerifiedMapping: mapping,
        candidates: [{ id: `${id}:candidate-green`, source: sourceGreen, catalogTitle: 'Catalog Green',
          rawDeadline: '2026-09-18', suggestedClosingDate: '2026-09-16',
          ruleVersion: batch.ruleVersion, snapshotVersion: batch.snapshotVersion,
          confidence: 1, matchMethod: 'ACTIVE_VERIFIED_MAPPING' }],
        ruleVersion: batch.ruleVersion, snapshotVersion: batch.snapshotVersion, analyzedAt: now,
      });
      const yellow = domain.createResolutionResult({
        id: `${id}:yellow`, batchId: id, erpProductGroupId: groups[1].id,
        erpTitleAtAnalysis: groups[1].title, productUpdatedAtAtAnalysis: now,
        closingDateAtAnalysis: closingDates[1] || null,
        candidates: [{ id: `${id}:candidate-yellow`, source: { sourceSupplier: 'dreamlink', sourceProductId: 'yellow-source' }, catalogTitle: 'Catalog Yellow',
          rawDeadline: '2026-09-20', suggestedClosingDate: '2026-09-18',
          ruleVersion: batch.ruleVersion, snapshotVersion: batch.snapshotVersion,
          confidence: 1, matchMethod: 'FUZZY_INFERRED' }],
        ruleVersion: batch.ruleVersion, snapshotVersion: batch.snapshotVersion, analyzedAt: now,
      });
      batch = { ...batch, progress: { totalCount: 2, completedCount: 2, greenCount: 1, yellowCount: 1, redCount: 0, serviceErrorCount: 0, retryableServiceErrorCount: 0 } };
      return { batch, results: [green, yellow] };
    };

    const original = clone(await readGroups(mainName));
    const first = makeCompleted('contract-batch-1');
    await repository.commitResolutionAnalysis({ mappings: [mapping], batch: first.batch, results: first.results });
    const afterAnalysis = clone(await readGroups(mainName));
    const manualMapping = domain.createVerifiedMapping({
      id: 'mapping-contract-yellow', erpProductGroupId: groups[1].id,
      source: first.results[1].candidates[0].source,
      verificationMethod: 'MANUAL_TOP3_SELECTION', verifiedAt: now, verifiedBy: 'next-owner',
    });
    await repository.saveVerifiedMapping(manualMapping);
    const afterRemember = clone(await readGroups(mainName));
    const selections = [
      { result: first.results[0], approval: 'GREEN_AUTO', mappingId: mapping.id },
      { result: { ...first.results[1], selectedCandidateId: first.results[1].candidates[0].id }, approval: 'MANUAL_CONFIRMED', mappingId: manualMapping.id },
    ];
    const applied = await applyModule.applyClosingDateResolutionBatch({
      repository, resolutionBatch: first.batch, selections,
      applyBatchId: 'contract-apply-1', applyItemIds: ['contract-apply-item-1', 'contract-apply-item-2'],
      idempotencyKey: 'contract-apply-idempotency-1', databaseName: mainName, appliedAt: now,
    });
    const afterApply = clone(await readGroups(mainName));
    const duplicate = await applyModule.applyClosingDateResolutionBatch({
      repository, resolutionBatch: first.batch, selections,
      applyBatchId: 'contract-apply-1', applyItemIds: ['contract-apply-item-1', 'contract-apply-item-2'],
      idempotencyKey: 'contract-apply-idempotency-1', databaseName: mainName, appliedAt: now,
    });

    const second = makeCompleted('contract-batch-2', ['2026/09/16', '2026/09/18']);
    await repository.commitResolutionAnalysis({ mappings: [mapping], batch: second.batch, results: second.results });
    const staleGroups = clone(await readGroups(mainName));
    staleGroups[1].closing_date = '2026/10/01';
    await putGroups(mainName, staleGroups);
    const beforeConflict = clone(await readGroups(mainName));
    const conflict = await applyModule.applyClosingDateResolutionBatch({
      repository, resolutionBatch: second.batch,
      selections: [
        { result: second.results[0], approval: 'GREEN_AUTO' },
        { result: { ...second.results[1], selectedCandidateId: second.results[1].candidates[0].id }, approval: 'MANUAL_CONFIRMED' },
      ],
      applyBatchId: 'contract-apply-2', applyItemIds: ['contract-conflict-item-1', 'contract-conflict-item-2'],
      idempotencyKey: 'contract-apply-idempotency-2', databaseName: mainName, appliedAt: now,
    });
    const afterConflict = clone(await readGroups(mainName));

    const third = makeCompleted('contract-batch-3', [afterConflict[0].closing_date, afterConflict[1].closing_date]);
    await repository.commitResolutionAnalysis({ mappings: [mapping], batch: third.batch, results: third.results });
    const beforeRollback = clone(await readGroups(mainName));
    const rolledBack = await applyModule.applyClosingDateResolutionBatch({
      repository, resolutionBatch: third.batch,
      selections: [{ result: third.results[0], approval: 'GREEN_AUTO' }],
      applyBatchId: 'contract-apply-3', applyItemIds: ['contract-rollback-item'],
      idempotencyKey: 'contract-apply-idempotency-3', databaseName: mainName, appliedAt: now,
      faultInjector(point) { if (point === 'AFTER_PRODUCT_GROUPS_PUT') throw new Error('TEST_ATOMIC_ROLLBACK'); },
    });
    const afterRollback = clone(await readGroups(mainName));

    let interrupted = domain.createResolutionBatch({
      id: 'contract-interrupted', idempotencyKey: 'contract-interrupted-idem', inputHash: 'contract-interrupted-input',
      snapshotVersion: 'snapshot-1', ruleVersion: 'closing-date-minus-two-v1',
      productGroupIds: [groups[0].id], createdAt: now,
    });
    interrupted = domain.transitionResolutionBatch(interrupted, 'RUNNING', now);
    await repository.createResolutionJob(interrupted);
    const reconciled = await runtimeModule.reconcileInterruptedClosingDateJobs({
      repository,
      gateway: { hasInMemoryRunner: () => false },
    }, '2026-08-21T08:31:00.000Z');
    const interruptedAfter = reconciled.find(batch => batch.id === interrupted.id);
    const listed = await repository.listResolutionBatches(20);

    const productFieldsExceptClosing = value => value.map(({ closing_date, ...rest }) => rest);
    const result = {
      analysisZeroWrite: JSON.stringify(original) === JSON.stringify(afterAnalysis),
      rememberZeroWrite: JSON.stringify(original) === JSON.stringify(afterRemember),
      applyStatus: applied.status,
      appliedDates: afterApply.map(group => group.closing_date),
      nonClosingFieldsUnchanged: JSON.stringify(productFieldsExceptClosing(original)) === JSON.stringify(productFieldsExceptClosing(afterApply)),
      duplicateStatus: duplicate.status,
      conflictStatus: conflict.status,
      conflictZeroWrite: JSON.stringify(beforeConflict) === JSON.stringify(afterConflict),
      rollbackStatus: rolledBack.status,
      rollbackZeroWrite: JSON.stringify(beforeRollback) === JSON.stringify(afterRollback),
      interruptedStatus: interruptedAfter?.status,
      interruptedRetryable: interruptedAfter?.failure?.retryable,
      completedReviewListed: listed.some(batch => batch.id === first.batch.id && batch.status === 'COMPLETED'),
    };
    repositories.forEach(item => item.close());
    for (const name of databaseNames) await deleteDatabase(name);
    return result;
  });

  assert.equal(contractResult.analysisZeroWrite, true);
  assert.equal(contractResult.rememberZeroWrite, true);
  assert.equal(contractResult.applyStatus, 'APPLIED');
  assert.deepEqual(contractResult.appliedDates, ['2026/09/16', '2026/09/18']);
  assert.equal(contractResult.nonClosingFieldsUnchanged, true);
  assert.equal(contractResult.duplicateStatus, 'APPLIED');
  assert.equal(contractResult.conflictStatus, 'CONFLICT');
  assert.equal(contractResult.conflictZeroWrite, true);
  assert.equal(contractResult.rollbackStatus, 'ROLLED_BACK');
  assert.equal(contractResult.rollbackZeroWrite, true);
  assert.equal(contractResult.interruptedStatus, 'FAILED');
  assert.equal(contractResult.interruptedRetryable, true);
  assert.equal(contractResult.completedReviewListed, true);

  await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const repositoryModule = await import('/src/lib/closingDateResolutionSidecarRepository.ts');
    const domain = await import('/src/lib/closingDateResolutionDomain.ts');
    const now = '2026-08-21T09:00:00.000Z';
    const groups = [
      { id: 'ui-green', title: '代理版 figma 地獄征服者 Helltaker 路西法', purchase_date: '', priority: 'Low', closing_date: '', release_month: '', has_official_site: false, product_url: '', source_type: 'proxy', created_at: now, updated_at: now },
      { id: 'ui-yellow', title: '代理版 GSC 黏土人 3121 BanG Dream! 夢限大MewType 峰月律', purchase_date: '', priority: 'Low', closing_date: '', release_month: '', has_official_site: false, product_url: '', source_type: 'proxy', created_at: now, updated_at: now },
      { id: 'ui-red', title: '代理版 不存在 商品紅色', purchase_date: '', priority: 'Low', closing_date: '', release_month: '', has_official_site: false, product_url: '', source_type: 'proxy', created_at: now, updated_at: now },
    ];
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(environment.NEXT_SANDBOX_INDEXED_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = {
      erp_product_groups: groups,
      erp_product_categories: [], erp_product_variants: [], erp_inventory: [],
      erp_purchase_batches: [], erp_purchase_batch_items: [], erp_private_orders: [],
      erp_private_order_items: [], erp_bundle_components: [], erp_japan_packages: [],
      erp_japan_package_items: [], erp_outbound_shipments: [], erp_outbound_shipment_items: [],
      erp_sales_order_items: [], erp_sales_orders: [],
    };
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      Object.entries(values).forEach(([key, value]) => store.put(value, key));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    const repository = repositoryModule.createNextClosingDateResolutionRepository();
    await repository.initialize();
    await repository.saveVerifiedMapping(domain.createVerifiedMapping({
      id: 'ui-mapping-green', erpProductGroupId: 'ui-green',
      source: { sourceSupplier: 'wanrong', sourceProductId: 'candidate-green' },
      verificationMethod: 'MANUAL_TOP3_SELECTION', verifiedAt: now, verifiedBy: 'next-owner',
    }));
    repository.close();
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('代理版 figma 地獄征服者 Helltaker 路西法').waitFor();
  const unopenedResources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  assert.equal(unopenedResources.some(name => /ClosingDateResolutionWorkbench/u.test(name)), false);

  for (const id of ['ui-green', 'ui-yellow', 'ui-red']) {
    await page.getByTestId(`purchase-record-select-${id}`).first().check();
  }
  await page.getByTestId('open-closing-date-workbench').click();
  await page.getByTestId('closing-date-workbench').waitFor();
  await page.getByTestId('closing-date-workbench-analyze').click();
  await page.getByText('分析完成').first().waitFor({ timeout: 30_000 });
  assert.equal(await page.getByText(/綠色｜可驗證來源（1）/u).count(), 1);
  assert.equal(await page.getByText(/黃色｜需要人工確認（1）/u).count(), 1);
  assert.equal(await page.getByText(/紅色｜不可套用（1）/u).count(), 1);

  const yellowCandidate = page.locator('[data-testid^="closing-date-candidate-"]').filter({ hasText: '黏土人 峰月律' });
  await yellowCandidate.locator('input[type="radio"]').check();
  const mainBeforeRemember = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot(environment.NEXT_SANDBOX_INDEXED_DB_NAME);
  });
  await page.locator('[data-testid^="closing-date-remember-"]').click();
  await page.getByText('已建立 Verified Mapping；尚未修改結單日。').waitFor();
  const mainAfterRemember = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    return environment.readPhysicalIndexedDbSnapshot(environment.NEXT_SANDBOX_INDEXED_DB_NAME);
  });
  assert.deepEqual(mainAfterRemember, mainBeforeRemember);

  const requestsBeforeClose = catalogRequests.length;
  await page.getByTestId('closing-date-workbench-close').click();
  await page.getByTestId('closing-date-workbench').waitFor({ state: 'detached' });
  await sleep(900);
  assert.equal(catalogRequests.length, requestsBeforeClose, 'Closing Workbench must stop UI polling/network work');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('代理版 figma 地獄征服者 Helltaker 路西法').waitFor();
  for (const id of ['ui-green', 'ui-yellow', 'ui-red']) {
    await page.getByTestId(`purchase-record-select-${id}`).first().check();
  }
  await page.getByTestId('open-closing-date-workbench').click();
  await page.getByText('最近 Batch').waitFor();
  await page.getByText(/分析完成・3 筆/u).first().click();
  await page.getByText('figma 路西法').waitFor();

  await page.getByTestId('closing-date-workbench-analyze').click();
  await page.getByTestId('closing-date-workbench-cancel').waitFor();
  await page.getByTestId('closing-date-workbench-cancel').click();
  await page.getByText('已取消').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('closing-date-workbench-retry').click();
  await page.getByText('分析完成').first().waitFor({ timeout: 30_000 });

  assert.equal(productionSupabaseRequests.length, 0);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    status: 'PASS',
    contractResult,
    ui: {
      classifications: { green: 1, yellow: 1, red: 1 },
      completedReviewReload: true,
      cancelRetry: true,
      chooseAndRememberMainWrite: 0,
      catalogRequests: catalogRequests.length,
      productionSupabaseRequests: 0,
    },
  }, null, 2));
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => vite.once('exit', resolve)),
    sleep(2_000),
  ]);
}
