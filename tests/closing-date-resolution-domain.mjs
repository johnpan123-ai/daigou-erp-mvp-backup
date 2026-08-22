import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4281;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_PATH = fileURLToPath(new URL('../src/lib/closingDateResolutionDomain.ts', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const source = await readFile(SOURCE_PATH, 'utf8');
assert.doesNotMatch(
  source,
  /dataProvider|indexedDB|IDBDatabase|supabase|fetch\s*\(|saveProductGroups|closing_date\s*[:=]/u,
  'Domain Foundation must remain pure and must not depend on runtime storage, Provider, network, or ProductGroup writes',
);
for (const contractName of [
  'VerifiedMappingRegistryEntry',
  'ResolutionBatch',
  'ResolutionResult',
  'RankedResolutionCandidate',
  'ApplyBatchAudit',
  'ApplyItemAudit',
  'ApplyResolutionBatchRequest',
  'ApplyResolutionBatchResponse',
  'ClosingDateResolutionStoreContract',
]) {
  assert.match(source, new RegExp(`export interface ${contractName}\\b`, 'u'), `Missing domain contract: ${contractName}`);
}

const vite = spawn(process.execPath, [
  VITE,
  '--mode', 'next',
  '--host', '127.0.0.1',
  '--port', String(PORT),
  '--strictPort',
], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const waitForVite = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
};

let browser;
try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const forbiddenRequests = [];
  page.on('request', request => {
    if (/\/api\/|\.supabase\.co\//iu.test(request.url())) forbiddenRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const domain = await import('/src/lib/closingDateResolutionDomain.ts');
    const now = '2026-08-21T02:00:00.000Z';
    const wanrong = {
      sourceSupplier: 'wanrong',
      sourceProductId: '12345',
      sourceCatalogId: 'catalog-77',
    };
    const dreamlink = {
      sourceSupplier: 'dreamlink',
      sourceProductId: '12345',
      sourceCatalogId: 'catalog-77',
    };
    const makeCandidate = (overrides = {}) => ({
      id: 'candidate-default',
      source: wanrong,
      catalogTitle: 'Catalog Product',
      rawDeadline: '2026-09-18',
      suggestedClosingDate: '2026-09-16',
      ruleVersion: 'closing-date-rule-v1',
      snapshotVersion: 'catalog-snapshot-20260821',
      confidence: 1,
      matchMethod: 'FUZZY_INFERRED',
      ...overrides,
    });
    const makeResult = (overrides = {}) => domain.createResolutionResult({
      id: 'result-1',
      batchId: 'batch-1',
      erpProductGroupId: 'group-1',
      erpTitleAtAnalysis: 'ERP Product',
      productUpdatedAtAtAnalysis: '2026-08-20T00:00:00.000Z',
      closingDateAtAnalysis: '2026-08-30',
      candidates: [makeCandidate({
        id: 'candidate-exact',
        matchMethod: 'EXACT_MODEL_CODE',
        identifiers: { modelCode: 'MODEL-100' },
      })],
      ruleVersion: 'closing-date-rule-v1',
      snapshotVersion: 'catalog-snapshot-20260821',
      analyzedAt: now,
      ...overrides,
    });

    const sourceIdentity = {
      wanrongKey: domain.sourceProductKey(wanrong),
      dreamlinkKey: domain.sourceProductKey(dreamlink),
      sameProduct: domain.sameSourceProduct(wanrong, dreamlink),
      rankedCrossSupplier: domain.rankTopThreeCandidates([
        makeCandidate({ id: 'wanrong-12345', source: wanrong }),
        makeCandidate({ id: 'dreamlink-12345', source: dreamlink }),
      ]).map(candidate => `${candidate.source.sourceSupplier}:${candidate.source.sourceProductId}`),
      sameProductAcrossCatalogSnapshots: domain.rankTopThreeCandidates([
        makeCandidate({ id: 'wanrong-catalog-old', source: { ...wanrong, sourceCatalogId: 'catalog-old' } }),
        makeCandidate({ id: 'wanrong-catalog-new', source: { ...wanrong, sourceCatalogId: 'catalog-new' } }),
      ]).length,
    };

    const mapping = domain.createVerifiedMapping({
      id: 'mapping-1',
      erpProductGroupId: 'group-1',
      source: wanrong,
      verificationMethod: 'MANUAL_TOP3_SELECTION',
      verifiedAt: now,
      verifiedBy: 'next-owner',
    });
    const fuzzyCandidate = makeCandidate({ id: 'candidate-fuzzy', confidence: 1 });
    const mappingClassifications = {
      active: domain.classifyResolutionCandidate({
        erpProductGroupId: 'group-1',
        candidate: fuzzyCandidate,
        activeVerifiedMapping: mapping,
      }),
      wrongGroup: domain.classifyResolutionCandidate({
        erpProductGroupId: 'group-other',
        candidate: fuzzyCandidate,
        activeVerifiedMapping: mapping,
      }),
      revoked: domain.classifyResolutionCandidate({
        erpProductGroupId: 'group-1',
        candidate: fuzzyCandidate,
        activeVerifiedMapping: domain.revokeVerifiedMapping(mapping, now, 'incorrect mapping'),
      }),
    };
    let fuzzyVerifiedMappingRejected = false;
    try {
      domain.createVerifiedMapping({
        ...mapping,
        id: 'invalid-fuzzy-mapping',
        verificationMethod: 'FUZZY_INFERRED',
      });
    } catch {
      fuzzyVerifiedMappingRejected = true;
    }
    let candidateVersionMismatchRejected = false;
    try {
      makeResult({
        candidates: [makeCandidate({
          id: 'candidate-wrong-snapshot',
          snapshotVersion: 'catalog-snapshot-stale',
        })],
      });
    } catch {
      candidateVersionMismatchRejected = true;
    }

    const ranked = domain.rankTopThreeCandidates([
      makeCandidate({ id: 'fuzzy-high', confidence: 1, matchMethod: 'FUZZY_INFERRED' }),
      makeCandidate({ id: 'jan', source: { ...wanrong, sourceProductId: 'jan', sourceCatalogId: 'catalog-jan' }, confidence: 0.91, matchMethod: 'EXACT_JAN' }),
      makeCandidate({ id: 'model', source: { ...wanrong, sourceProductId: 'model', sourceCatalogId: 'catalog-model' }, confidence: 0.95, matchMethod: 'EXACT_MODEL_CODE' }),
      makeCandidate({ id: 'unverified', source: { ...wanrong, sourceProductId: 'other', sourceCatalogId: 'catalog-other' }, confidence: 1, matchMethod: 'UNVERIFIED' }),
    ]);

    const classificationByMethod = Object.fromEntries([
      'ACTIVE_VERIFIED_MAPPING',
      'IMPORT_DIRECT_ID_BINDING',
      'EXACT_JAN',
      'EXACT_SOURCE_PRODUCT_ID',
      'EXACT_MODEL_CODE',
      'PARSER_INFERRED',
      'FUZZY_INFERRED',
      'UNVERIFIED',
    ].map((matchMethod, index) => [matchMethod, domain.classifyResolutionCandidate({
      erpProductGroupId: 'group-1',
      candidate: makeCandidate({
        id: `classification-${index}`,
        source: { ...wanrong, sourceProductId: `classification-${index}` },
        matchMethod,
      }),
    }).classification]));
    const redClassifications = {
      service: domain.classifyResolutionCandidate({
        erpProductGroupId: 'group-1',
        serviceError: { code: 'UPSTREAM', message: 'unavailable', retryable: true },
      }),
      empty: domain.classifyResolutionCandidate({ erpProductGroupId: 'group-1' }),
      retrievedButRejected: domain.classifyResolutionCandidate({
        erpProductGroupId: 'group-1',
        retrievedButRejected: true,
      }),
      missingDeadline: domain.classifyResolutionCandidate({
        erpProductGroupId: 'group-1',
        candidate: makeCandidate({ rawDeadline: null }),
      }),
    };

    const batchInput = {
      id: 'batch-1',
      idempotencyKey: 'resolution:20260821:groups-1-2',
      inputHash: 'sha256:input-1',
      snapshotVersion: 'catalog-snapshot-20260821',
      ruleVersion: 'closing-date-rule-v1',
      productGroupIds: ['group-1', 'group-2'],
      createdAt: now,
    };
    const queued = domain.createResolutionBatch(batchInput);
    const running = domain.transitionResolutionBatch(queued, 'RUNNING', now);
    const cancelling = domain.transitionResolutionBatch(running, 'CANCELLING', now);
    const cancelled = domain.transitionResolutionBatch(cancelling, 'CANCELLED', now);
    let invalidTransitionRejected = false;
    try {
      domain.transitionResolutionBatch(cancelled, 'RUNNING', now);
    } catch {
      invalidTransitionRejected = true;
    }
    const failedRetryable = {
      ...running,
      status: 'FAILED',
      failure: { code: 'SERVICE', message: 'temporary', retryable: true },
    };
    const failedPermanent = {
      ...failedRetryable,
      failure: { code: 'INVALID_INPUT', message: 'permanent', retryable: false },
    };
    const completedPartial = {
      ...running,
      status: 'COMPLETED',
      progress: { ...running.progress, retryableServiceErrorCount: 1 },
    };
    const jobState = {
      statuses: [queued.status, running.status, cancelling.status, cancelled.status],
      cancelQueued: domain.canCancelResolutionBatch(queued),
      cancelRunning: domain.canCancelResolutionBatch(running),
      cancelCompleted: domain.canCancelResolutionBatch(completedPartial),
      retryFailed: domain.canRetryResolutionBatch(failedRetryable),
      retryPermanent: domain.canRetryResolutionBatch(failedPermanent),
      retryPartial: domain.canRetryResolutionBatch(completedPartial),
      invalidTransitionRejected,
    };

    const firstIdempotent = domain.resolveIdempotentResolutionBatch([], batchInput);
    const duplicateIdempotent = domain.resolveIdempotentResolutionBatch(firstIdempotent.logicalBatches, {
      ...batchInput,
      id: 'batch-duplicate-must-not-be-created',
    });
    let idempotencyConflictRejected = false;
    try {
      domain.resolveIdempotentResolutionBatch(firstIdempotent.logicalBatches, {
        ...batchInput,
        id: 'batch-conflict',
        inputHash: 'sha256:different-input',
      });
    } catch {
      idempotencyConflictRejected = true;
    }

    const applicable = makeResult();
    const currentProduct = {
      erpProductGroupId: 'group-1',
      updatedAt: '2026-08-20T00:00:00.000Z',
      closingDate: '2026-08-30',
    };
    const readyPlan = domain.planAtomicClosingDateApply({
      resolutionBatchId: 'batch-1',
      selections: [{ result: applicable, approval: 'GREEN_AUTO' }],
      currentProducts: [currentProduct],
    });
    const readyAudit = domain.createApplyAuditBundle({
      applyBatchId: 'apply-1',
      applyItemIds: ['apply-item-1'],
      idempotencyKey: 'apply:batch-1:v1',
      plan: readyPlan,
      createdAt: now,
    });
    const stalePlan = domain.planAtomicClosingDateApply({
      resolutionBatchId: 'batch-1',
      selections: [{ result: applicable, approval: 'GREEN_AUTO' }],
      currentProducts: [{
        ...currentProduct,
        updatedAt: '2026-08-21T00:00:00.000Z',
        closingDate: '2026-09-01',
      }],
    });
    const secondResult = makeResult({
      id: 'result-2',
      erpProductGroupId: 'group-2',
      candidates: [makeCandidate({
        id: 'candidate-2',
        source: { ...wanrong, sourceProductId: 'product-2' },
        matchMethod: 'EXACT_SOURCE_PRODUCT_ID',
      })],
    });
    const mixedConflictPlan = domain.planAtomicClosingDateApply({
      resolutionBatchId: 'batch-1',
      selections: [
        { result: applicable, approval: 'GREEN_AUTO' },
        { result: secondResult, approval: 'GREEN_AUTO' },
      ],
      currentProducts: [
        currentProduct,
        {
          erpProductGroupId: 'group-2',
          updatedAt: 'stale-after-analysis',
          closingDate: '2026-08-30',
        },
      ],
    });
    const mixedConflictAudit = domain.createApplyAuditBundle({
      applyBatchId: 'apply-conflict',
      applyItemIds: ['apply-conflict-item-1', 'apply-conflict-item-2'],
      idempotencyKey: 'apply:batch-1:conflict',
      plan: mixedConflictPlan,
      createdAt: now,
    });

    return {
      sourceIdentity,
      mappingClassifications,
      fuzzyVerifiedMappingRejected,
      candidateVersionMismatchRejected,
      ranked: ranked.map(candidate => ({ id: candidate.id, rank: candidate.rank })),
      classificationByMethod,
      redClassifications,
      jobState,
      idempotency: {
        firstCreated: firstIdempotent.created,
        duplicateCreated: duplicateIdempotent.created,
        duplicateBatchId: duplicateIdempotent.batch.id,
        logicalBatchCount: duplicateIdempotent.logicalBatches.length,
        idempotencyConflictRejected,
      },
      applicable: {
        classification: applicable.classification,
        selectedCandidateId: applicable.selectedCandidateId,
      },
      readyPlan,
      readyAudit,
      stalePlan,
      mixedConflictPlan,
      mixedConflictAudit,
      rollback: domain.createAtomicRollbackResult('simulated transaction failure', 'tx-test-1'),
    };
  });

  assert.notEqual(result.sourceIdentity.wanrongKey, result.sourceIdentity.dreamlinkKey);
  assert.equal(result.sourceIdentity.sameProduct, false);
  assert.deepEqual(result.sourceIdentity.rankedCrossSupplier.sort(), ['dreamlink:12345', 'wanrong:12345']);
  assert.equal(result.sourceIdentity.sameProductAcrossCatalogSnapshots, 1);

  assert.deepEqual(result.mappingClassifications.active, { classification: 'GREEN', reason: 'ACTIVE_VERIFIED_MAPPING' });
  assert.equal(result.mappingClassifications.wrongGroup.classification, 'YELLOW');
  assert.equal(result.mappingClassifications.revoked.classification, 'YELLOW');
  assert.equal(result.fuzzyVerifiedMappingRejected, true);
  assert.equal(result.candidateVersionMismatchRejected, true);

  assert.deepEqual(result.ranked, [
    { id: 'jan', rank: 1 },
    { id: 'model', rank: 2 },
    { id: 'fuzzy-high', rank: 3 },
  ]);
  assert.deepEqual(result.classificationByMethod, {
    ACTIVE_VERIFIED_MAPPING: 'YELLOW',
    IMPORT_DIRECT_ID_BINDING: 'GREEN',
    EXACT_JAN: 'GREEN',
    EXACT_SOURCE_PRODUCT_ID: 'GREEN',
    EXACT_MODEL_CODE: 'GREEN',
    PARSER_INFERRED: 'YELLOW',
    FUZZY_INFERRED: 'YELLOW',
    UNVERIFIED: 'YELLOW',
  });
  assert.equal(result.redClassifications.service.classification, 'RED');
  assert.equal(result.redClassifications.empty.classification, 'RED');
  assert.deepEqual(result.redClassifications.retrievedButRejected, {
    classification: 'RED',
    reason: 'RETRIEVED_BUT_REJECTED',
  });
  assert.equal(result.redClassifications.missingDeadline.classification, 'RED');

  assert.deepEqual(result.jobState.statuses, ['QUEUED', 'RUNNING', 'CANCELLING', 'CANCELLED']);
  assert.equal(result.jobState.cancelQueued, true);
  assert.equal(result.jobState.cancelRunning, true);
  assert.equal(result.jobState.cancelCompleted, false);
  assert.equal(result.jobState.retryFailed, true);
  assert.equal(result.jobState.retryPermanent, false);
  assert.equal(result.jobState.retryPartial, true);
  assert.equal(result.jobState.invalidTransitionRejected, true);

  assert.equal(result.idempotency.firstCreated, true);
  assert.equal(result.idempotency.duplicateCreated, false);
  assert.equal(result.idempotency.duplicateBatchId, 'batch-1');
  assert.equal(result.idempotency.logicalBatchCount, 1);
  assert.equal(result.idempotency.idempotencyConflictRejected, true);

  assert.deepEqual(result.applicable, { classification: 'GREEN', selectedCandidateId: 'candidate-exact' });
  assert.equal(result.readyPlan.status, 'READY');
  assert.equal(result.readyPlan.writeIntents.length, 1);
  assert.equal(result.readyPlan.transactionResult.writeCount, 0, 'Domain Foundation plans writes but never executes them');
  assert.equal(result.readyAudit.batch.resolutionBatchId, 'batch-1');
  assert.equal(result.readyAudit.items[0].resolutionResultId, 'result-1');
  assert.equal(result.readyAudit.items[0].beforeClosingDate, '2026-08-30');
  assert.equal(result.readyAudit.items[0].afterClosingDate, '2026-09-16');

  assert.equal(result.stalePlan.status, 'CONFLICT');
  assert.equal(result.stalePlan.writeIntents.length, 0);
  assert.deepEqual(
    result.stalePlan.conflicts.map(item => item.code).sort(),
    ['CLOSING_DATE_CHANGED', 'STALE_PRODUCT'],
  );
  assert.equal(result.mixedConflictPlan.status, 'CONFLICT');
  assert.equal(result.mixedConflictPlan.attemptedItems.length, 2);
  assert.equal(result.mixedConflictPlan.writeIntents.length, 0, 'One conflict must make the whole logical apply batch 0-write');
  assert.equal(result.mixedConflictPlan.transactionResult.outcome, 'NOT_STARTED_CONFLICT');
  assert.equal(result.mixedConflictPlan.transactionResult.writeCount, 0);
  assert.equal(result.mixedConflictAudit.batch.requestedCount, 2);
  assert.equal(result.mixedConflictAudit.batch.appliedCount, 0);
  assert.equal(result.mixedConflictAudit.items.every(item => item.result === 'CONFLICT'), true);
  assert.deepEqual(result.rollback, {
    outcome: 'ROLLED_BACK',
    atomic: true,
    committed: false,
    rolledBack: true,
    writeCount: 0,
    reason: 'simulated transaction failure',
    transactionId: 'tx-test-1',
  });

  assert.deepEqual(forbiddenRequests, [], 'Offline contract tests must issue 0 Catalog/Supabase requests');

  console.log('PASS source identity is supplier-scoped; Wanrong/DreamLink numeric IDs are never merged');
  console.log('PASS revoked/fuzzy mappings cannot qualify as active GREEN verified mappings');
  console.log('PASS Top 3, GREEN/YELLOW/RED, and rule/snapshot contracts are deterministic');
  console.log('PASS job state transitions, cancel/retry eligibility, and idempotency are enforced');
  console.log('PASS stale ProductGroup/closing_date conflicts make the whole apply batch 0-write');
  console.log('PASS analysis-to-apply audit links and rollback contracts remain offline/pure');
  console.log('PASS Production Supabase requests = 0; DB/Schema writes = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
