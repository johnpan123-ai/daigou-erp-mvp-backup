import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4282;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_PATH = fileURLToPath(
  new URL('../src/lib/closingDateResolutionSidecarRepository.ts', import.meta.url),
);
const SCHEMA_PATH = fileURLToPath(
  new URL('../src/lib/closingDateResolutionSidecarSchema.ts', import.meta.url),
);
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const [repositorySource, schemaSource] = await Promise.all([
  readFile(REPOSITORY_PATH, 'utf8'),
  readFile(SCHEMA_PATH, 'utf8'),
]);
assert.doesNotMatch(
  repositorySource,
  /dataProvider|saveProductGroups|Supabase|\.supabase\.co|fetch\s*\(|daigou-erp-db-next-v1/u,
  'Sidecar repository must not access ERP Provider, Supabase, Catalog, or the main Next DB',
);
assert.doesNotMatch(
  schemaSource,
  /\bProductGroup\b|erp_product_groups|\.closing_date\s*=|["']closing_date["']\s*:/u,
  'Sidecar schema must not modify or mirror the ProductGroup schema',
);

const expectedStores = [
  'closing_date_verified_mappings',
  'closing_date_resolution_batches',
  'closing_date_resolution_results',
  'closing_date_resolution_candidates',
  'closing_date_apply_batches',
  'closing_date_apply_items',
].sort();
for (const storeName of expectedStores) {
  assert.match(schemaSource, new RegExp(`['\"]${storeName}['\"]`, 'u'));
}

const vite = spawn(process.execPath, [
  VITE,
  '--configLoader', 'runner',
  '--mode', 'next',
  '--host', '127.0.0.1',
  '--port', String(PORT),
  '--strictPort',
], {
  cwd: ROOT,
  env: {
    ...process.env,
    VITE_ENABLE_CLOSING_DATE_WORKBENCH_STORAGE: 'true',
  },
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
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();
  const productionSupabaseRequests = [];
  const pageErrors = [];
  page.on('request', request => {
    if (/\.supabase\.co\//iu.test(request.url())) productionSupabaseRequests.push(request.url());
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const testResult = await page.evaluate(async () => {
    const domain = await import('/src/lib/closingDateResolutionDomain.ts');
    const repositoryModule = await import('/src/lib/closingDateResolutionSidecarRepository.ts');
    const schema = await import('/src/lib/closingDateResolutionSidecarSchema.ts');
    const createdDatabaseNames = [];
    const repositories = [];
    const now = '2026-08-21T03:00:00.000Z';

    const deleteDatabase = databaseName => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error(`Unable to delete ${databaseName}`));
      request.onblocked = () => reject(new Error(`Delete blocked for ${databaseName}`));
    });

    const makeDatabaseName = suffix => (
      `${schema.NEXT_CLOSING_DATE_SIDECAR_DB_NAME}-contract-${suffix}`
    );

    const registerDatabase = async suffix => {
      const databaseName = makeDatabaseName(suffix);
      await deleteDatabase(databaseName);
      createdDatabaseNames.push(databaseName);
      return databaseName;
    };

    const makeAggregate = (suffix = 'base', idempotencyKey = `resolution-${suffix}`) => {
      const wanrong = {
        sourceSupplier: 'wanrong',
        sourceProductId: '12345',
        sourceCatalogId: 'wanrong-catalog-20260821',
      };
      const dreamlink = {
        sourceSupplier: 'dreamlink',
        sourceProductId: '12345',
        sourceCatalogId: 'dreamlink-catalog-20260821',
      };
      const activeMapping = domain.createVerifiedMapping({
        id: `mapping-active-${suffix}`,
        erpProductGroupId: `group-${suffix}`,
        source: wanrong,
        resolutionIdentityId: `identity-${suffix}`,
        verificationMethod: 'MANUAL_TOP3_SELECTION',
        verifiedAt: now,
        verifiedBy: 'next-owner',
      });
      const revokedMapping = domain.revokeVerifiedMapping(
        domain.createVerifiedMapping({
          id: `mapping-revoked-${suffix}`,
          erpProductGroupId: `group-${suffix}`,
          source: dreamlink,
          verificationMethod: 'EXACT_SOURCE_PRODUCT_ID',
          verifiedAt: now,
          verifiedBy: 'next-owner',
        }),
        now,
        'superseded supplier listing',
      );
      const batch = domain.createResolutionBatch({
        id: `batch-${suffix}`,
        idempotencyKey,
        inputHash: `sha256:${suffix}`,
        snapshotVersion: 'catalog-snapshot-v1',
        ruleVersion: 'closing-date-rule-v1',
        productGroupIds: [`group-${suffix}`],
        createdAt: now,
      });
      const result = domain.createResolutionResult({
        id: `result-${suffix}`,
        batchId: batch.id,
        erpProductGroupId: `group-${suffix}`,
        erpTitleAtAnalysis: `ERP Product ${suffix}`,
        productUpdatedAtAtAnalysis: '2026-08-20T00:00:00.000Z',
        closingDateAtAnalysis: null,
        activeVerifiedMapping: activeMapping,
        candidates: [
          {
            id: `candidate-wanrong-${suffix}`,
            source: wanrong,
            resolutionIdentityId: `identity-${suffix}`,
            catalogTitle: `Wanrong Product ${suffix}`,
            catalogUrl: `https://catalog.invalid/wanrong/${suffix}`,
            identifiers: { modelCode: `MODEL-${suffix}` },
            rawDeadline: '2026-09-18',
            suggestedClosingDate: '2026-09-16',
            ruleVersion: batch.ruleVersion,
            snapshotVersion: batch.snapshotVersion,
            confidence: 1,
            matchMethod: 'ACTIVE_VERIFIED_MAPPING',
          },
          {
            id: `candidate-dreamlink-${suffix}`,
            source: dreamlink,
            catalogTitle: `DreamLink Product ${suffix}`,
            rawDeadline: '2026-09-20',
            suggestedClosingDate: '2026-09-18',
            ruleVersion: batch.ruleVersion,
            snapshotVersion: batch.snapshotVersion,
            confidence: 0.98,
            matchMethod: 'FUZZY_INFERRED',
          },
        ],
        ruleVersion: batch.ruleVersion,
        snapshotVersion: batch.snapshotVersion,
        analyzedAt: now,
      });
      return {
        mappings: [activeMapping, revokedMapping],
        batch,
        results: [result],
      };
    };

    const allZero = counts => Object.values(counts).every(count => count === 0);
    const databaseNamesBefore = new Set(
      (await indexedDB.databases()).map(database => database.name).filter(Boolean),
    );

    let nonNextRejected = false;
    try {
      repositoryModule.assertNextClosingDateSidecarAccess('test', true);
    } catch {
      nonNextRejected = true;
    }
    let unsafeDatabaseNameRejected = false;
    try {
      repositoryModule.createNextClosingDateResolutionRepository({
        databaseName: 'daigou-erp-db',
      });
    } catch {
      unsafeDatabaseNameRejected = true;
    }

    try {
      const primaryDatabaseName = await registerDatabase('primary');
      const repository = repositoryModule.createNextClosingDateResolutionRepository({
        databaseName: primaryDatabaseName,
      });
      repositories.push(repository);
      const metadata = await repository.initialize();
      const initialCounts = await repository.getStoreCounts();

      const aggregate = makeAggregate();
      const committed = await repository.commitResolutionAnalysis(aggregate);
      const countsAfterCommit = await repository.getStoreCounts();
      const roundTripBatch = await repository.getResolutionBatch(aggregate.batch.id);
      const roundTripByKey = await repository.findBatchByIdempotencyKey(
        aggregate.batch.idempotencyKey,
      );
      const roundTripResult = await repository.getResolutionResult(aggregate.results[0].id);
      const activeMappings = await repository.findActiveMappings([
        aggregate.results[0].erpProductGroupId,
        aggregate.results[0].erpProductGroupId,
      ]);

      const duplicateAggregate = makeAggregate('duplicate', aggregate.batch.idempotencyKey);
      duplicateAggregate.batch = {
        ...duplicateAggregate.batch,
        inputHash: aggregate.batch.inputHash,
        snapshotVersion: aggregate.batch.snapshotVersion,
        ruleVersion: aggregate.batch.ruleVersion,
      };
      duplicateAggregate.results = duplicateAggregate.results.map(result => ({
        ...result,
        snapshotVersion: aggregate.batch.snapshotVersion,
        ruleVersion: aggregate.batch.ruleVersion,
        candidates: result.candidates.map(candidate => ({
          ...candidate,
          snapshotVersion: aggregate.batch.snapshotVersion,
          ruleVersion: aggregate.batch.ruleVersion,
        })),
      }));
      const duplicate = await repository.commitResolutionAnalysis(duplicateAggregate);
      const countsAfterDuplicate = await repository.getStoreCounts();

      let idempotencyConflictRejected = false;
      try {
        const conflictAggregate = makeAggregate('conflict', aggregate.batch.idempotencyKey);
        await repository.commitResolutionAnalysis(conflictAggregate);
      } catch (error) {
        idempotencyConflictRejected = error?.name === 'ClosingDateSidecarIdempotencyConflictError';
      }
      const countsAfterIdempotencyConflict = await repository.getStoreCounts();

      const plan = domain.planAtomicClosingDateApply({
        resolutionBatchId: aggregate.batch.id,
        selections: [{ result: aggregate.results[0], approval: 'GREEN_AUTO' }],
        currentProducts: [{
          erpProductGroupId: aggregate.results[0].erpProductGroupId,
          updatedAt: aggregate.results[0].productUpdatedAtAtAnalysis,
          closingDate: aggregate.results[0].closingDateAtAnalysis,
        }],
      });
      const applyAudit = domain.createApplyAuditBundle({
        applyBatchId: 'apply-batch-base',
        applyItemIds: ['apply-item-base'],
        idempotencyKey: 'apply-idempotency-base',
        plan,
        createdAt: now,
      });
      const applySaved = await repository.saveApplyAudit(applyAudit);
      const applyDuplicate = await repository.saveApplyAudit({
        ...applyAudit,
        batch: {
          ...applyAudit.batch,
          createdAt: '2099-01-01T00:00:00.000Z',
        },
      });
      const roundTripApplyAudit = await repository.getApplyAudit(applyAudit.batch.id);
      const countsAfterApplyAudit = await repository.getStoreCounts();

      const revokedActiveMapping = await repository.revokeVerifiedMapping(
        'mapping-active-base',
        '2026-08-21T01:00:00.000Z',
        'manual test revocation',
      );
      const activeMappingsAfterRevoke = await repository.findActiveMappings([
        aggregate.results[0].erpProductGroupId,
      ]);
      const revokedMappingRoundTrip = await repository.getVerifiedMapping(
        'mapping-active-base',
      );

      const faultPoints = [
        'BEFORE_MAPPING_WRITES',
        'AFTER_MAPPING_WRITE',
        'AFTER_BATCH_WRITE',
        'AFTER_RESULT_WRITE',
        'AFTER_CANDIDATE_WRITE',
        'BEFORE_ANALYSIS_COMMIT',
      ];
      const rollbackResults = [];
      for (const [index, faultPoint] of faultPoints.entries()) {
        const databaseName = await registerDatabase(`fault-${index}`);
        const faultRepository = repositoryModule.createNextClosingDateResolutionRepository({
          databaseName,
          faultInjector: point => {
            if (point === faultPoint) throw new Error(`FORCED_${faultPoint}`);
          },
        });
        repositories.push(faultRepository);
        await faultRepository.initialize();
        let rejected = false;
        try {
          await faultRepository.commitResolutionAnalysis(makeAggregate(`fault-${index}`));
        } catch (error) {
          rejected = error?.message === `FORCED_${faultPoint}`;
        }
        const counts = await faultRepository.getStoreCounts();
        rollbackResults.push({ faultPoint, rejected, zeroPartialWrite: allZero(counts), counts });
        faultRepository.close();
      }

      const applyFaultDatabaseName = await registerDatabase('apply-fault');
      const applyFaultRepository = repositoryModule.createNextClosingDateResolutionRepository({
        databaseName: applyFaultDatabaseName,
        faultInjector: point => {
          if (point === 'AFTER_APPLY_BATCH_WRITE') throw new Error('FORCED_APPLY_AUDIT_FAILURE');
        },
      });
      repositories.push(applyFaultRepository);
      await applyFaultRepository.initialize();
      let applyFaultRejected = false;
      try {
        await applyFaultRepository.saveApplyAudit(applyAudit);
      } catch (error) {
        applyFaultRejected = error?.message === 'FORCED_APPLY_AUDIT_FAILURE';
      }
      const applyFaultCounts = await applyFaultRepository.getStoreCounts();
      applyFaultRepository.close();

      const databaseNamesAfter = new Set(
        (await indexedDB.databases()).map(database => database.name).filter(Boolean),
      );
      const newlyCreatedDatabases = [...databaseNamesAfter]
        .filter(databaseName => !databaseNamesBefore.has(databaseName));

      return {
        featureFlag: {
          undefinedIsOff: repositoryModule.parseClosingDateSidecarFeatureFlag(undefined),
          falseIsOff: repositoryModule.parseClosingDateSidecarFeatureFlag('false'),
          trueIsOn: repositoryModule.parseClosingDateSidecarFeatureFlag('true'),
          testRuntimeFlagEnabled: repositoryModule.isClosingDateSidecarFeatureEnabled(),
          nonNextRejected,
          unsafeDatabaseNameRejected,
        },
        metadata,
        initialCounts,
        committed,
        countsAfterCommit,
        originalBatch: aggregate.batch,
        originalResult: aggregate.results[0],
        roundTripBatch,
        roundTripByKey,
        roundTripResult,
        activeMappings,
        revokedActiveMapping,
        activeMappingsAfterRevoke,
        revokedMappingRoundTrip,
        sourceKeys: aggregate.results[0].candidates.map(candidate => (
          domain.sourceProductKey(candidate.source)
        )),
        duplicate,
        countsAfterDuplicate,
        idempotencyConflictRejected,
        countsAfterIdempotencyConflict,
        applySaved,
        applyDuplicate,
        roundTripApplyAudit,
        countsAfterApplyAudit,
        rollbackResults,
        applyFaultRejected,
        applyFaultCounts,
        newlyCreatedDatabases,
        expectedDatabasePrefix: schema.NEXT_CLOSING_DATE_SIDECAR_DB_NAME,
      };
    } finally {
      repositories.forEach(repository => repository.close());
      await new Promise(resolve => setTimeout(resolve, 0));
      await Promise.all(createdDatabaseNames.map(deleteDatabase));
    }
  });

  assert.deepEqual(testResult.featureFlag, {
    undefinedIsOff: false,
    falseIsOff: false,
    trueIsOn: true,
    testRuntimeFlagEnabled: true,
    nonNextRejected: true,
    unsafeDatabaseNameRejected: true,
  });
  assert.equal(testResult.metadata.version, 1);
  assert.deepEqual([...testResult.metadata.stores].sort(), expectedStores);
  assert.equal(Object.values(testResult.metadata.indexes).every(indexes => indexes.length > 0), true);
  assert.equal(Object.values(testResult.initialCounts).every(count => count === 0), true);

  assert.equal(testResult.committed.created, true);
  assert.deepEqual(testResult.countsAfterCommit, {
    closing_date_verified_mappings: 2,
    closing_date_resolution_batches: 1,
    closing_date_resolution_results: 1,
    closing_date_resolution_candidates: 2,
    closing_date_apply_batches: 0,
    closing_date_apply_items: 0,
  });
  assert.equal(testResult.roundTripBatch.id, 'batch-base');
  assert.equal(testResult.roundTripByKey.id, 'batch-base');
  assert.equal(testResult.roundTripResult.id, 'result-base');
  assert.deepEqual(testResult.roundTripBatch, testResult.originalBatch);
  assert.deepEqual(testResult.roundTripByKey, testResult.originalBatch);
  assert.deepEqual(testResult.roundTripResult, testResult.originalResult);
  assert.equal(testResult.roundTripResult.candidates.length, 2);
  assert.deepEqual(
    testResult.roundTripResult.candidates.map(candidate => candidate.source.sourceSupplier).sort(),
    ['dreamlink', 'wanrong'],
  );
  assert.notEqual(testResult.sourceKeys[0], testResult.sourceKeys[1]);
  assert.equal(testResult.activeMappings.length, 1, 'Revoked mappings must never be returned as active');
  assert.equal(testResult.activeMappings[0].id, 'mapping-active-base');
  assert.equal(testResult.activeMappingsAfterRevoke.length, 0);
  assert.equal(testResult.revokedActiveMapping.revokedAt, '2026-08-21T01:00:00.000Z');
  assert.equal(testResult.revokedMappingRoundTrip.revokedReason, 'manual test revocation');

  assert.equal(testResult.duplicate.created, false);
  assert.equal(testResult.duplicate.batch.id, 'batch-base');
  assert.deepEqual(testResult.countsAfterDuplicate, testResult.countsAfterCommit);
  assert.equal(testResult.idempotencyConflictRejected, true);
  assert.deepEqual(testResult.countsAfterIdempotencyConflict, testResult.countsAfterCommit);

  assert.equal(testResult.applySaved.created, true);
  assert.equal(testResult.applyDuplicate.created, false);
  assert.deepEqual(testResult.applyDuplicate.audit, testResult.applySaved.audit);
  assert.deepEqual(testResult.roundTripApplyAudit, testResult.applySaved.audit);
  assert.equal(testResult.countsAfterApplyAudit.closing_date_apply_batches, 1);
  assert.equal(testResult.countsAfterApplyAudit.closing_date_apply_items, 1);
  assert.equal(testResult.countsAfterApplyAudit.closing_date_resolution_batches, 1);
  assert.equal(testResult.countsAfterApplyAudit.closing_date_resolution_results, 1);

  for (const rollback of testResult.rollbackResults) {
    assert.equal(rollback.rejected, true, `${rollback.faultPoint} must reject`);
    assert.equal(rollback.zeroPartialWrite, true, `${rollback.faultPoint} must roll back every store`);
  }
  assert.equal(testResult.applyFaultRejected, true);
  assert.equal(Object.values(testResult.applyFaultCounts).every(count => count === 0), true);
  assert.equal(
    testResult.newlyCreatedDatabases.every(name => name.startsWith(testResult.expectedDatabasePrefix)),
    true,
    'The migration may create only Next Closing Date sidecar databases',
  );

  assert.deepEqual(productionSupabaseRequests, []);
  assert.deepEqual(pageErrors, []);

  console.log('PASS feature flag defaults off and non-Next/unsafe database access is fail-closed');
  console.log('PASS sidecar DB v1 creates exactly 6 empty Next-only stores');
  console.log('PASS supplier + source product ID identity keeps Wanrong/DreamLink listings separate');
  console.log('PASS Mapping + Batch + Result + Top 3 Candidate complete round-trip');
  console.log('PASS revoked Verified Mapping is excluded from active mappings');
  console.log('PASS duplicate idempotency key creates no second logical Resolution Batch');
  console.log('PASS 6 analysis fault points abort with 0 partial writes across all stores');
  console.log('PASS Apply audit round-trip and failure rollback never modify closing_date');
  console.log('PASS Production Supabase requests = 0; Production/other Sandbox stores untouched');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
