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
    await sleep(250);
    let products = [];
    if (query.includes('路西法')) {
      products = [{
        id: 'candidate-green',
        name: 'figma 路西法',
        url: 'https://catalog.invalid/figma-lucifer',
        janCode: '4580590200001',
        sku: 'FIGMA-LUCIFER',
        catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-18T08:00:00.000Z' },
      }];
    } else if (query.includes('峰月律')) {
      products = [{
        id: 'candidate-yellow',
        name: '黏土人 峰月律',
        url: 'https://catalog.invalid/nendoroid-ritsu',
        brand: { name: 'Good Smile Company' },
        janCode: '4580590200002',
        sku: 'NENDOROID-3121',
        catalog: { supplier: { code: 'wanrong' }, deadlineAt: '2026-09-07T08:00:00.000Z' },
      }];
    } else if (query.includes('商品紅色')) {
      products = [{
        id: 'candidate-red-conflict',
        name: '1/7 Scale Figure 商品紅色',
        catalog: { supplier: { code: 'dreamlink' }, deadlineAt: '2026-09-30T08:00:00.000Z' },
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
    const reviewModule = await import('/src/lib/closingDateWorkbenchReviewOrder.ts');
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
      { id: 'contract-exact', title: 'ERP Exact', purchase_date: '', priority: 'Low', closing_date: '', release_month: '', has_official_site: false, product_url: '', created_at: now, updated_at: now },
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
      const exact = domain.createResolutionResult({
        id: `${id}:exact`, batchId: id, erpProductGroupId: groups[2].id,
        erpTitleAtAnalysis: groups[2].title, productUpdatedAtAtAnalysis: now,
        closingDateAtAnalysis: closingDates[2] || null,
        candidates: [{ id: `${id}:candidate-exact`, source: { sourceSupplier: 'wanrong', sourceProductId: 'exact-source' }, catalogTitle: 'Catalog Exact',
          rawDeadline: '2026-09-22', suggestedClosingDate: '2026-09-20',
          ruleVersion: batch.ruleVersion, snapshotVersion: batch.snapshotVersion,
          confidence: 1, matchMethod: 'EXACT_MODEL_CODE' }],
        ruleVersion: batch.ruleVersion, snapshotVersion: batch.snapshotVersion, analyzedAt: now,
      });
      batch = { ...batch, progress: { totalCount: 3, completedCount: 3, greenCount: 2, yellowCount: 1, redCount: 0, serviceErrorCount: 0, retryableServiceErrorCount: 0 } };
      return { batch, results: [green, yellow, exact] };
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
    const unconfirmedYellowSelection = domain.createApplySelectionFromResolutionResult(first.results[1]);
    const redResult = domain.createResolutionResult({
      id: 'contract-red', batchId: first.batch.id, erpProductGroupId: groups[1].id,
      erpTitleAtAnalysis: groups[1].title, productUpdatedAtAtAnalysis: now,
      closingDateAtAnalysis: null, candidates: [], ruleVersion: first.batch.ruleVersion,
      snapshotVersion: first.batch.snapshotVersion, analyzedAt: now,
    });
    const redSelection = domain.createApplySelectionFromResolutionResult(redResult);
    const pendingYellowSelection = domain.createApplySelectionFromResolutionResult(first.results[1], {
      selectedCandidateId: first.results[1].candidates[0].id,
      pendingMapping: manualMapping,
    });
    const beforeApplyMappings = await applyModule.findAtomicClosingDateVerifiedMappings(groups.map(group => group.id), mainName);
    const afterRadioSelection = clone(await readGroups(mainName));
    const selections = [
      domain.createApplySelectionFromResolutionResult(first.results[0]),
      pendingYellowSelection,
      domain.createApplySelectionFromResolutionResult(first.results[2]),
    ];
    if (!selections.every(Boolean)) throw new Error('Expected three apply-eligible selections');
    const applyIdentity = applyModule.createClosingDateApplyIdentity(first.batch, selections);
    const applied = await applyModule.applyClosingDateResolutionBatch({
      resolutionBatch: first.batch, selections,
      ...applyIdentity, databaseName: mainName, appliedAt: now,
    });
    const afterApply = clone(await readGroups(mainName));
    const mappingsAfterApply = await applyModule.findAtomicClosingDateVerifiedMappings(groups.map(group => group.id), mainName);
    const auditsAfterApply = await applyModule.getAtomicClosingDateApplyAudits(mainName);
    const duplicate = await applyModule.applyClosingDateResolutionBatch({
      resolutionBatch: first.batch, selections,
      ...applyIdentity, databaseName: mainName, appliedAt: now,
    });
    const mappingsAfterDuplicate = await applyModule.findAtomicClosingDateVerifiedMappings(groups.map(group => group.id), mainName);
    const auditsAfterDuplicate = await applyModule.getAtomicClosingDateApplyAudits(mainName);

    const singleGroups = clone(await readGroups(mainName));
    singleGroups[2].closing_date = '';
    await putGroups(mainName, singleGroups);
    let singleBatch = domain.createResolutionBatch({
      id: 'contract-batch-single', idempotencyKey: 'idempotency-contract-batch-single',
      inputHash: 'input-contract-batch-single', snapshotVersion: 'snapshot-1',
      ruleVersion: 'closing-date-minus-two-v1', productGroupIds: [groups[2].id], createdAt: now,
    });
    singleBatch = domain.transitionResolutionBatch(singleBatch, 'RUNNING', now);
    singleBatch = domain.transitionResolutionBatch(singleBatch, 'COMPLETED', now);
    singleBatch = { ...singleBatch, progress: { totalCount: 1, completedCount: 1, greenCount: 1, yellowCount: 0, redCount: 0, serviceErrorCount: 0, retryableServiceErrorCount: 0 } };
    const singleResult = domain.createResolutionResult({
      id: 'contract-batch-single:exact', batchId: singleBatch.id,
      erpProductGroupId: groups[2].id, erpTitleAtAnalysis: groups[2].title,
      productUpdatedAtAtAnalysis: now, closingDateAtAnalysis: null,
      candidates: [{ id: 'contract-batch-single:candidate-exact', source: { sourceSupplier: 'wanrong', sourceProductId: 'single-exact-source' }, catalogTitle: 'Catalog Single Exact',
        rawDeadline: '2026-09-22', suggestedClosingDate: '2026-09-20',
        ruleVersion: singleBatch.ruleVersion, snapshotVersion: singleBatch.snapshotVersion,
        confidence: 1, matchMethod: 'EXACT_MODEL_CODE' }],
      ruleVersion: singleBatch.ruleVersion, snapshotVersion: singleBatch.snapshotVersion, analyzedAt: now,
    });
    await repository.commitResolutionAnalysis({ mappings: [], batch: singleBatch, results: [singleResult] });
    const singleSelections = [domain.createApplySelectionFromResolutionResult(singleResult)];
    if (!singleSelections.every(Boolean)) throw new Error('Expected one apply-eligible selection');
    const singleIdentity = applyModule.createClosingDateApplyIdentity(singleBatch, singleSelections);
    const singleApplied = await applyModule.applyClosingDateResolutionBatch({
      resolutionBatch: singleBatch, selections: singleSelections,
      ...singleIdentity, databaseName: mainName, appliedAt: now,
    });
    const afterSingleApply = clone(await readGroups(mainName));

    let multiYellowBatch = domain.createResolutionBatch({
      id: 'contract-batch-three-yellow', idempotencyKey: 'idempotency-contract-batch-three-yellow',
      inputHash: 'input-contract-batch-three-yellow', snapshotVersion: 'snapshot-1',
      ruleVersion: 'closing-date-minus-two-v1', productGroupIds: groups.map(group => group.id), createdAt: now,
    });
    multiYellowBatch = domain.transitionResolutionBatch(multiYellowBatch, 'RUNNING', now);
    multiYellowBatch = domain.transitionResolutionBatch(multiYellowBatch, 'COMPLETED', now);
    const multiYellowResults = groups.map((group, index) => domain.createResolutionResult({
      id: `contract-batch-three-yellow:${index}`, batchId: multiYellowBatch.id,
      erpProductGroupId: group.id, erpTitleAtAnalysis: group.title,
      productUpdatedAtAtAnalysis: now, closingDateAtAnalysis: afterSingleApply[index].closing_date || null,
      candidates: [
        { id: `contract-three-yellow:${index}:first`, source: { sourceSupplier: 'dreamlink', sourceProductId: `three-yellow-${index}-first` }, catalogTitle: `First ${index}`,
          rawDeadline: `2026-10-0${index + 3}`, suggestedClosingDate: `2026-10-0${index + 1}`,
          ruleVersion: multiYellowBatch.ruleVersion, snapshotVersion: multiYellowBatch.snapshotVersion,
          confidence: 0.95, matchMethod: 'FUZZY_INFERRED' },
        { id: `contract-three-yellow:${index}:last`, source: { sourceSupplier: 'wanrong', sourceProductId: `three-yellow-${index}-last` }, catalogTitle: `Last ${index}`,
          rawDeadline: `2026-11-0${index + 3}`, suggestedClosingDate: `2026-11-0${index + 1}`,
          ruleVersion: multiYellowBatch.ruleVersion, snapshotVersion: multiYellowBatch.snapshotVersion,
          confidence: 0.94, matchMethod: 'FUZZY_INFERRED' },
      ],
      ruleVersion: multiYellowBatch.ruleVersion, snapshotVersion: multiYellowBatch.snapshotVersion, analyzedAt: now,
    }));
    const multiYellowSelections = multiYellowResults.map((result, index) => {
      const candidate = index === 0 ? result.candidates[1] : result.candidates[0];
      return domain.createApplySelectionFromResolutionResult(result, {
        selectedCandidateId: candidate.id,
        pendingMapping: domain.createVerifiedMapping({
          id: `mapping-contract-three-yellow-${index}`, erpProductGroupId: result.erpProductGroupId,
          source: candidate.source, verificationMethod: 'MANUAL_TOP3_SELECTION', verifiedAt: now, verifiedBy: 'next-owner',
        }),
      });
    });
    if (!multiYellowSelections.every(Boolean)) throw new Error('Expected three manually selected yellow results');
    const multiYellowIdentity = applyModule.createClosingDateApplyIdentity(multiYellowBatch, multiYellowSelections);
    const multiYellowApplied = await applyModule.applyClosingDateResolutionBatch({
      resolutionBatch: multiYellowBatch, selections: multiYellowSelections,
      ...multiYellowIdentity, databaseName: mainName, appliedAt: now,
    });
    const afterMultiYellowApply = clone(await readGroups(mainName));
    const mappingsAfterMultiYellow = await applyModule.findAtomicClosingDateVerifiedMappings(groups.map(group => group.id), mainName);
    const firstGroupMapping = mappingsAfterMultiYellow.find(item => item.erpProductGroupId === groups[0].id);

    const second = makeCompleted('contract-batch-2', ['2026/09/16', '2026/09/18', '2026/09/20']);
    await repository.commitResolutionAnalysis({ mappings: [mapping], batch: second.batch, results: second.results });
    const secondYellowMapping = domain.createVerifiedMapping({
      id: 'mapping-contract-yellow-second', erpProductGroupId: groups[1].id,
      source: second.results[1].candidates[0].source,
      verificationMethod: 'MANUAL_TOP3_SELECTION', verifiedAt: now, verifiedBy: 'next-owner',
    });
    const staleGroups = clone(await readGroups(mainName));
    staleGroups[1].closing_date = '2026/10/01';
    await putGroups(mainName, staleGroups);
    const beforeConflict = clone(await readGroups(mainName));
    const mappingsBeforeConflict = await applyModule.findAtomicClosingDateVerifiedMappings(groups.map(group => group.id), mainName);
    const auditsBeforeConflict = await applyModule.getAtomicClosingDateApplyAudits(mainName);
    const conflict = await applyModule.applyClosingDateResolutionBatch({
      resolutionBatch: second.batch,
      selections: [
        domain.createApplySelectionFromResolutionResult(second.results[0]),
        domain.createApplySelectionFromResolutionResult(second.results[1], {
          selectedCandidateId: second.results[1].candidates[0].id,
          pendingMapping: secondYellowMapping,
        }),
        domain.createApplySelectionFromResolutionResult(second.results[2]),
      ],
      applyBatchId: 'contract-apply-2', applyItemIds: ['contract-conflict-item-1', 'contract-conflict-item-2', 'contract-conflict-item-3'],
      idempotencyKey: 'contract-apply-idempotency-2', databaseName: mainName, appliedAt: now,
    });
    const afterConflict = clone(await readGroups(mainName));
    const mappingsAfterConflict = await applyModule.findAtomicClosingDateVerifiedMappings(groups.map(group => group.id), mainName);
    const auditsAfterConflict = await applyModule.getAtomicClosingDateApplyAudits(mainName);

    const third = makeCompleted('contract-batch-3', [afterConflict[0].closing_date, afterConflict[1].closing_date]);
    await repository.commitResolutionAnalysis({ mappings: [mapping], batch: third.batch, results: third.results });
    const beforeRollback = clone(await readGroups(mainName));
    const mappingsBeforeRollback = await applyModule.findAtomicClosingDateVerifiedMappings(groups.map(group => group.id), mainName);
    const auditsBeforeRollback = await applyModule.getAtomicClosingDateApplyAudits(mainName);
    const faultPoints = [
      'BEFORE_PRODUCT_GROUPS_PUT',
      'AFTER_PRODUCT_GROUPS_PUT',
      'AFTER_VERIFIED_MAPPINGS_PUT',
      'AFTER_APPLY_AUDIT_PUT',
    ];
    const rollbackChecks = [];
    for (const [index, faultPoint] of faultPoints.entries()) {
      const rolledBack = await applyModule.applyClosingDateResolutionBatch({
        resolutionBatch: third.batch,
        selections: [{ result: third.results[0], approval: 'GREEN_AUTO' }],
        applyBatchId: `contract-apply-rollback-${index}`,
        applyItemIds: [`contract-rollback-item-${index}`],
        idempotencyKey: `contract-apply-idempotency-rollback-${index}`,
        databaseName: mainName, appliedAt: now,
        faultInjector(point) { if (point === faultPoint) throw new Error(`TEST_ATOMIC_ROLLBACK:${faultPoint}`); },
      });
      const afterRollback = clone(await readGroups(mainName));
      const mappingsAfterRollback = await applyModule.findAtomicClosingDateVerifiedMappings(groups.map(group => group.id), mainName);
      const auditsAfterRollback = await applyModule.getAtomicClosingDateApplyAudits(mainName);
      rollbackChecks.push({
        status: rolledBack.status,
        zeroWrite: JSON.stringify(beforeRollback) === JSON.stringify(afterRollback)
          && JSON.stringify(mappingsBeforeRollback) === JSON.stringify(mappingsAfterRollback)
          && JSON.stringify(auditsBeforeRollback) === JSON.stringify(auditsAfterRollback),
      });
    }

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
    const reviewCandidate = (id, supplier, identity, rank) => ({
      id, rank, resolutionIdentityId: identity,
      source: { sourceSupplier: supplier, sourceProductId: id },
    });
    const sameIdentityOrder = reviewModule.orderClosingDateReviewCandidates([
      reviewCandidate('same-dreamlink', 'dreamlink', 'identity:same', 1),
      reviewCandidate('same-wanrong', 'wanrong', 'identity:same', 2),
    ]).map(candidate => candidate.id);
    const differentIdentityOrder = reviewModule.orderClosingDateReviewCandidates([
      reviewCandidate('different-dreamlink', 'dreamlink', 'identity:a', 1),
      reviewCandidate('different-wanrong', 'wanrong', 'identity:b', 2),
    ]).map(candidate => candidate.id);
    const result = {
      analysisZeroWrite: JSON.stringify(original) === JSON.stringify(afterAnalysis),
      radioSelectionZeroWrite: JSON.stringify(original) === JSON.stringify(afterRadioSelection)
        && beforeApplyMappings.length === 0,
      unconfirmedYellowBlocked: unconfirmedYellowSelection === null,
      redBlocked: redSelection === null,
      applyStatus: applied.status,
      appliedDates: afterApply.map(group => group.closing_date),
      nonClosingFieldsUnchanged: JSON.stringify(productFieldsExceptClosing(original)) === JSON.stringify(productFieldsExceptClosing(afterApply)),
      mappingAndAuditCommitted: mappingsAfterApply.some(item => item.id === manualMapping.id)
        && auditsAfterApply.length === 1,
      duplicateStatus: duplicate.status,
      duplicateMappingPrevented: mappingsAfterDuplicate.length === mappingsAfterApply.length,
      duplicateApplyBatchCount: auditsAfterDuplicate.length,
      duplicateApplyItemCount: auditsAfterDuplicate[0]?.items.length,
      singleApplyStatus: singleApplied.status,
      singleApplyDate: afterSingleApply[2].closing_date,
      threeYellowApplyStatus: multiYellowApplied.status,
      threeYellowAppliedDates: afterMultiYellowApply.map(group => group.closing_date),
      changedSelectionSavedLastOnly: firstGroupMapping?.source.sourceProductId === 'three-yellow-0-last'
        && !mappingsAfterMultiYellow.some(item => item.source.sourceProductId === 'three-yellow-0-first'),
      sameIdentityWanrongFirst: sameIdentityOrder.join(',') === 'same-wanrong,same-dreamlink',
      differentIdentityWanrongFirst: differentIdentityOrder.join(',') === 'different-wanrong,different-dreamlink',
      conflictStatus: conflict.status,
      conflictZeroWrite: JSON.stringify(beforeConflict) === JSON.stringify(afterConflict)
        && JSON.stringify(mappingsBeforeConflict) === JSON.stringify(mappingsAfterConflict)
        && JSON.stringify(auditsBeforeConflict) === JSON.stringify(auditsAfterConflict),
      rollbackStatus: rollbackChecks.every(check => check.status === 'ROLLED_BACK') ? 'ROLLED_BACK' : 'FAILED',
      rollbackZeroWrite: rollbackChecks.every(check => check.zeroWrite),
      rollbackFaultPoints: faultPoints.length,
      interruptedStatus: interruptedAfter?.status,
      interruptedRetryable: interruptedAfter?.failure?.retryable,
      completedReviewListed: listed.some(batch => batch.id === first.batch.id && batch.status === 'COMPLETED'),
    };
    repositories.forEach(item => item.close());
    for (const name of databaseNames) await deleteDatabase(name);
    return result;
  });

  assert.equal(contractResult.analysisZeroWrite, true);
  assert.equal(contractResult.radioSelectionZeroWrite, true);
  assert.equal(contractResult.unconfirmedYellowBlocked, true);
  assert.equal(contractResult.redBlocked, true);
  assert.equal(contractResult.duplicateMappingPrevented, true);
  assert.equal(contractResult.applyStatus, 'APPLIED');
  assert.deepEqual(contractResult.appliedDates, ['2026/09/16', '2026/09/18', '2026/09/20']);
  assert.equal(contractResult.nonClosingFieldsUnchanged, true);
  assert.equal(contractResult.mappingAndAuditCommitted, true);
  assert.equal(contractResult.duplicateStatus, 'APPLIED');
  assert.equal(contractResult.duplicateApplyBatchCount, 1);
  assert.equal(contractResult.duplicateApplyItemCount, 3);
  assert.equal(contractResult.singleApplyStatus, 'APPLIED');
  assert.equal(contractResult.singleApplyDate, '2026/09/20');
  assert.equal(contractResult.threeYellowApplyStatus, 'APPLIED');
  assert.deepEqual(contractResult.threeYellowAppliedDates, ['2026/11/01', '2026/10/02', '2026/10/03']);
  assert.equal(contractResult.changedSelectionSavedLastOnly, true);
  assert.equal(contractResult.sameIdentityWanrongFirst, true);
  assert.equal(contractResult.differentIdentityWanrongFirst, true);
  assert.equal(contractResult.conflictStatus, 'CONFLICT');
  assert.equal(contractResult.conflictZeroWrite, true);
  assert.equal(contractResult.rollbackStatus, 'ROLLED_BACK');
  assert.equal(contractResult.rollbackZeroWrite, true);
  assert.equal(contractResult.rollbackFaultPoints, 4);
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
      { id: 'ui-red', title: '代理版 GSC 黏土人 商品紅色', purchase_date: '', priority: 'Low', closing_date: '', release_month: '', has_official_site: false, product_url: '', source_type: 'proxy', created_at: now, updated_at: now },
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
  const classificationHeadings = await page.locator('h3').allTextContents();
  assert.equal(
    await page.getByText(/綠色｜可驗證來源（1）/u).count(),
    1,
    JSON.stringify(classificationHeadings),
  );
  assert.equal(
    await page.getByText(/黃色｜需要人工確認（1）/u).count(),
    1,
    JSON.stringify(classificationHeadings),
  );
  assert.equal(
    await page.getByText(/紅色｜不可套用（1）/u).count(),
    1,
    JSON.stringify(classificationHeadings),
  );
  const redResultUi = page.locator('[data-testid="closing-date-result-ui-red"]');
  await redResultUi.getByText('查看被安全排除的候選', { exact: true }).click();
  const rejectedText = await redResultUi.locator('[data-testid^="closing-date-rejected-"]').textContent();
  assert.match(rejectedText, /1\/7 Scale Figure 商品紅色/u);
  assert.match(rejectedText, /供應商：DreamLink/u);
  assert.match(rejectedText, /Native Rank：#1/u);
  assert.match(rejectedText, /Query：商品紅色/u);
  assert.match(rejectedText, /PRODUCT_TYPE_CONFLICT/u);
  const greenResult = page.locator('[data-testid="closing-date-result-ui-green"]');
  assert.equal(await greenResult.getByText('✓ 已驗證', { exact: true }).count(), 1);

  const yellowCandidate = page.locator('[data-testid^="closing-date-candidate-"]').filter({ hasText: '黏土人 峰月律' });
  const yellowPrimaryText = await yellowCandidate.locator('[data-testid^="closing-date-primary-"]').textContent();
  const yellowDetailsText = await yellowCandidate.locator('[data-testid^="closing-date-details-"]').textContent();
  assert.match(yellowPrimaryText, /#1/u);
  assert.match(yellowPrimaryText, /廠牌：Good Smile Company/u);
  assert.match(yellowPrimaryText, /供應商：萬榮/u);
  assert.match(yellowPrimaryText, /JAN：4580590200002/u);
  assert.match(yellowPrimaryText, /型號：NENDOROID-3121/u);
  assert.match(yellowPrimaryText, /官方結單：2026\/09\/07/u);
  assert.match(yellowPrimaryText, /建議結單：2026\/09\/05/u);
  assert.doesNotMatch(yellowPrimaryText, /PARSER_INFERRED|Native Rank|Query P|Match Evidence|Source ID|T08:00:00/u);
  assert.match(yellowDetailsText, /Supplier：wanrong/u);
  assert.match(yellowDetailsText, /Native Rank：#1/u);
  assert.match(yellowDetailsText, /Matched Query：P/u);
  assert.match(yellowDetailsText, /Match Evidence：/u);
  assert.match(yellowDetailsText, /Raw Deadline：2026-09-07T08:00:00.000Z/u);
  const beforeSelection = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const applyModule = await import('/src/lib/closingDateWorkbenchAtomicApply.ts');
    return {
      main: await environment.readPhysicalIndexedDbSnapshot(environment.NEXT_SANDBOX_INDEXED_DB_NAME),
      mappings: await applyModule.findAtomicClosingDateVerifiedMappings(['ui-yellow']),
    };
  });
  await yellowCandidate.locator('input[type="radio"]').check();
  await page.getByText(/將於最後套用時記住此選擇/u).waitFor();
  assert.equal(await page.locator('[data-testid^="closing-date-remember-"]').count(), 0);
  const afterSelection = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const applyModule = await import('/src/lib/closingDateWorkbenchAtomicApply.ts');
    return {
      main: await environment.readPhysicalIndexedDbSnapshot(environment.NEXT_SANDBOX_INDEXED_DB_NAME),
      mappings: await applyModule.findAtomicClosingDateVerifiedMappings(['ui-yellow']),
    };
  });
  assert.deepEqual(afterSelection, beforeSelection, 'Radio selection must remain in-memory only');

  await page.reload({ waitUntil: 'networkidle' });
  const mappingsAfterSelectionReload = await page.evaluate(async () => {
    const applyModule = await import('/src/lib/closingDateWorkbenchAtomicApply.ts');
    return applyModule.findAtomicClosingDateVerifiedMappings(['ui-yellow']);
  });
  assert.deepEqual(mappingsAfterSelectionReload, beforeSelection.mappings, 'F5 before Apply must not persist a Mapping');
  for (const id of ['ui-green', 'ui-yellow', 'ui-red']) {
    await page.getByTestId(`purchase-record-select-${id}`).first().check();
  }
  await page.getByTestId('open-closing-date-workbench').click();
  await page.getByText(/分析完成・3 筆/u).first().click();
  const reloadedYellowCandidate = page.locator('[data-testid^="closing-date-candidate-"]').filter({ hasText: '黏土人 峰月律' });
  await reloadedYellowCandidate.locator('input[type="radio"]').check();
  await page.getByText(/已選 2 \/ 3 筆/u).waitFor();

  const requestsBeforeClose = catalogRequests.length;
  await page.getByTestId('closing-date-workbench-apply').click();
  await page.getByTestId('closing-date-apply-confirmation').waitFor();
  await page.getByTestId('closing-date-apply-confirm').click();
  await page.getByTestId('closing-date-workbench').waitFor({ state: 'detached' });
  await page.getByTestId('closing-date-apply-success').waitFor();
  assert.match(await page.getByTestId('closing-date-apply-success').textContent(), /已成功套用 2 筆結單日/u);
  const datesAfterUiApply = await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const snapshot = await environment.readPhysicalIndexedDbSnapshot(environment.NEXT_SANDBOX_INDEXED_DB_NAME);
    return Object.fromEntries(snapshot.erp_product_groups.map(group => [group.id, group.closing_date]));
  });
  assert.equal(datesAfterUiApply['ui-green'], '2026/09/16');
  assert.equal(datesAfterUiApply['ui-yellow'], '2026/09/05');
  assert.equal(datesAfterUiApply['ui-red'], '');
  await sleep(900);
  assert.equal(catalogRequests.length, requestsBeforeClose, 'Closing Workbench must stop UI polling/network work');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /已結單/u }).click();
  await page.getByText('代理版 figma 地獄征服者 Helltaker 路西法').waitFor();
  for (const id of ['ui-green', 'ui-yellow']) {
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

  await page.evaluate(async () => {
    const environment = await import('/src/lib/testSandboxEnvironment.ts');
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(environment.NEXT_SANDBOX_INDEXED_DB_NAME, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('kv', 'readwrite');
      const store = transaction.objectStore('kv');
      const request = store.get('erp_product_groups');
      request.onsuccess = () => {
        const groups = request.result;
        const staleGroup = groups.find(group => group.id === 'ui-green');
        staleGroup.closing_date = '2026/12/31';
        store.put(groups, 'erp_product_groups');
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
  await page.getByTestId('closing-date-workbench-apply').click();
  await page.getByTestId('closing-date-apply-confirmation').waitFor();
  await page.getByTestId('closing-date-apply-confirm').click();
  await page.getByText(/偵測到資料衝突，整批 0 write/u).waitFor();
  assert.equal(await page.getByTestId('closing-date-workbench').count(), 1, 'Conflict must keep Workbench open');

  assert.equal(productionSupabaseRequests.length, 0);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    status: 'PASS',
    contractResult,
    ui: {
      classifications: { green: 1, yellow: 1, red: 1 },
      completedReviewReload: true,
      cancelRetry: true,
      radioSelectionPersistentWrite: 0,
      preApplyReloadMappingWrite: 0,
      customApplyConfirmation: true,
      successfulApplyAutoClose: true,
      successfulApplyToast: true,
      conflictKeepsWorkbenchOpen: true,
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
