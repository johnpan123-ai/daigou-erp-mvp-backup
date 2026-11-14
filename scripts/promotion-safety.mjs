import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  applyPlanProjection,
  buildDeltaIdentity,
  buildPlannerIdentity,
  buildSchemaEvidenceIdentity,
} from '../tools/schema-reconciliation/evidenceContract.mjs';
import { inspectPreAdoptionMaintenance, inspectPost080Maintenance, inspectSafeDescendant, verifySafeDescendant } from './post-adoption-descendant.mjs';
import { verifyImpactEvidence } from './reviewed-change-impact.mjs';
import { SCHEMA_FINGERPRINT_CONTRACT_VERSION, SCHEMA_CANONICAL_CONTRACT,
  SQL_CANONICAL_ALGORITHM } from '../tools/schema-reconciliation/schemaContract.mjs';

export const CANONICAL_ERP2_TARGET = Object.freeze({
  role: 'ERP_2_CLOUD_CANDIDATE',
  accountId: 'e0a58431cd5bcf0e01ec3438d531461a',
  project: 'hippo-erp-realtime-preview',
  domain: 'hippo-erp-realtime-preview.pages.dev',
  pagesBranch: 'isolated-preview',
  deploymentEnvironment: 'staging',
  runtimeMarker: 'STAGING',
  supabaseProject: 'rhfdjsklfrgpoqsaqpkn',
  publicFingerprint: 'D9EA6B7BB6524517',
});

export class DeploymentGuardError extends Error {
  constructor(message) {
    super(`DEPLOYMENT_GUARD_FAILED_CLOSED: ${message}`);
    this.name = 'DeploymentGuardError';
  }
}

const failClosed = message => { throw new DeploymentGuardError(message); };
export const sha256 = value => createHash('sha256').update(value).digest('hex').toUpperCase();

export function assertCanonicalContract(contract) {
  const account = contract?.accounts?.erp;
  const target = contract?.environments?.erp2;
  const expected = CANONICAL_ERP2_TARGET;
  if (contract?.schemaVersion !== 2 || !target?.deploymentAllowed) failClosed('invalid promotion contract');
  if (account?.accountId !== expected.accountId || target.cloudflareAccountId !== expected.accountId
    || target.role !== expected.role || target.cloudflareProject !== expected.project
    || target.pagesDomain !== expected.domain || target.pagesBranch !== expected.pagesBranch
    || target.deploymentEnvironment !== expected.deploymentEnvironment
    || target.runtimeMarker !== expected.runtimeMarker || target.supabaseProject !== expected.supabaseProject
    || target.publicFingerprint !== expected.publicFingerprint) failClosed('canonical ERP 2 target mismatch');
  const gate = contract.githubPreDeployGate;
  if (!gate?.repository || !gate?.remote || !gate?.acceptedTag || !/^[a-f0-9]{40}$/u.test(gate.acceptedHead ?? '')
    || gate.lineage?.mode !== 'DIRECT_OR_RECONCILED_CHECKPOINT_DESCENDANT'
    || !gate.lineage.reconciliationTag || !/^[a-f0-9]{40}$/u.test(gate.lineage.reconciliationHead ?? '')) {
    failClosed('invalid accepted-lineage contract');
  }
  if (!contract.schemaBaseline?.requiredBaselineId
    || contract.schemaBaseline.evidenceContractVersion !== 2
    || contract.schemaBaseline.fingerprintContractVersion !== SCHEMA_FINGERPRINT_CONTRACT_VERSION
    || contract.schemaBaseline.canonicalContract !== SCHEMA_CANONICAL_CONTRACT
    || contract.schemaBaseline.canonicalAlgorithm !== SQL_CANONICAL_ALGORITHM
    || contract.schemaBaseline.preAdoptionMode !== 'READ_ONLY_RECONCILIATION'
    || contract.schemaBaseline.postAdoptionLedger !== 'public.erp_schema_migration_ledger'
    || !/^[0-9a-f]{64}$/u.test(contract.schemaBaseline.canonicalFingerprint ?? '')
    || !/^[0-9a-f]{64}$/u.test(contract.schemaBaseline.snapshotToolChecksum ?? '')
    || !Number.isSafeInteger(contract.schemaBaseline.snapshotMaxAgeMs)
    || !Number.isSafeInteger(contract.schemaBaseline.liveObservationMaxAgeMs)) {
    failClosed('invalid schema-baseline contract');
  }
  const maintenance = contract.schemaBaseline.preAdoptionMaintenance;
  if (!maintenance || maintenance.mode !== 'PRE_ADOPTION_MAINTENANCE'
    || maintenance.migrationId !== '079'
    || maintenance.requiredFingerprint !== '9bb81937fa2c58b58ddb87c7a36cdfa8e1048b971974ec21804e508602d617d8'
    || maintenance.requiredMigrationSourceHead !== '73083c3d028e23506e0bd7bec9ad8b949a226cfc'
    || maintenance.requiredMigrationCheckpoint !== 'checkpoint-20261104-erp2-v33-079-purchase-list-decouple-v1'
    || maintenance.requiredMigrationSourceChecksum !== '391e42478375a471f251ee647424c82f7cf47fd3cdc3ebd1523fdaa86d45363c'
    || !/^[0-9a-f]{40}$/u.test(maintenance.approvedBaseHead ?? '')
    || !maintenance.approvedBaseCheckpoint?.startsWith('checkpoint-')
    || maintenance.exactReviewId !== 'erp2-pre-adoption-maintenance-079-v1'
    || maintenance.forbidBaselineAdoption !== true || maintenance.requireZeroMigrationDelta !== true) {
    failClosed('invalid PRE_ADOPTION_MAINTENANCE contract');
  }
  const post080 = contract.schemaBaseline.post080Maintenance;
  if (!post080 || post080.mode !== 'PRE_ADOPTION_MAINTENANCE_080'
    || post080.bootstrapMode !== 'PRE_ADOPTION_AUDIT_BOOTSTRAP_080'
    || post080.migrationId !== '080'
    || post080.requiredFingerprint !== contract.schemaBaseline.canonicalFingerprint
    || post080.previousFingerprint !== maintenance.requiredFingerprint
    || post080.requiredMigrationSourceHead !== '9e5ce2e0a0dc856b50057e48766313b0af1019f1'
    || post080.requiredMigrationCheckpoint !== 'checkpoint-20261110-erp2-v33-080-apply-audit-v1'
    || post080.requiredMigrationSourceChecksum !== '590ef5550ea2945e537cf6ec5014c7324837649b0fc87cdb79cf76bf34601db7'
    || !/^[a-f0-9]{40}$/u.test(post080.approvedBaseHead ?? '')
    || !post080.approvedBaseCheckpoint?.startsWith('checkpoint-')
    || post080.exactReviewId !== 'erp2-pre-adoption-maintenance-080-realtime-v1'
    || post080.auditRunnerPath !== 'src/components/SchemaMigrationAuditRunner.tsx'
    || post080.auditRunnerCommit !== 'fffcec6899d5a8d26899146194638e4a2768e009'
    || post080.forbidBaselineAdoption !== true || post080.requireZeroMigrationDelta !== true) {
    failClosed('invalid PRE_ADOPTION_MAINTENANCE_080 contract');
  }
  const post080Product = contract.schemaBaseline.post080ProductRelease;
  if (!post080Product || post080Product.mode !== 'PRE_ADOPTION_POST080'
    || post080Product.migrationId !== post080.migrationId
    || post080Product.requiredFingerprint !== post080.requiredFingerprint
    || post080Product.requiredMigrationSourceHead !== post080.requiredMigrationSourceHead
    || post080Product.requiredMigrationCheckpoint !== post080.requiredMigrationCheckpoint
    || post080Product.requiredMigrationSourceChecksum !== post080.requiredMigrationSourceChecksum
    || post080Product.approvedBaseHead !== '54e9531e2abbf473bfb934b91c70e54ea567ccab'
    || post080Product.approvedBaseCheckpoint !== 'checkpoint-20261110-erp2-v33-080-ledger-realtime-release-v8'
    || post080Product.exactReviewId !== post080.exactReviewId
    || post080Product.forbidBaselineAdoption !== true
    || post080Product.requireZeroMigrationDelta !== true
    || !Array.isArray(post080Product.requiredRegressions)
    || post080Product.requiredRegressions.some(id => typeof id !== 'string' || id.length === 0)) {
    failClosed('invalid PRE_ADOPTION_POST080 contract');
  }
  return { account, target, gate };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const migrationApplyProjection = item => ({
  migrationId: item.migrationId,
  sourceFile: item.sourceFile,
  sourceChecksum: item.sourceChecksum,
  canonicalOrder: item.canonicalOrder,
  applyMethod: item.applyMethod,
});
const exactJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const ageOf = (value, now, label) => {
  const timestamp = Date.parse(value ?? '');
  if (!Number.isFinite(timestamp) || timestamp > now + 60_000) failClosed(`${label} timestamp is invalid`);
  return now - timestamp;
};

const verifyPlannerContract = (evidence, migrationRegistry) => {
  if (!Array.isArray(evidence.migrations) || !Array.isArray(evidence.applyPlan)
    || evidence.plannerIdentity !== buildPlannerIdentity(evidence)
    || evidence.deltaIdentity !== buildDeltaIdentity(evidence)
    || evidence.schemaEvidenceIdentity !== buildSchemaEvidenceIdentity(evidence)) {
    failClosed('schema planner evidence identity mismatch');
  }
  // Registry property insertion order is not a migration execution contract.
  // Match the exact scope in source canonical order; the loop below still
  // verifies each checksum, dependency, and strictly increasing plan order.
  const registryIds = migrationRegistry && Object.keys(migrationRegistry)
    .sort((left, right) => migrationRegistry[left].canonicalOrder - migrationRegistry[right].canonicalOrder);
  if (!registryIds || !exactJson(registryIds, evidence.migrations.map(item => item.migrationId))) {
    failClosed('schema planner registry scope mismatch');
  }
  const ids = new Set();
  let lastOrder = -1;
  for (const item of evidence.migrations) {
    if (!item?.migrationId || ids.has(item.migrationId) || !SHA256_PATTERN.test(item.sourceChecksum ?? '')
      || !Number.isSafeInteger(item.canonicalOrder) || item.canonicalOrder <= lastOrder
      || !Array.isArray(item.dependencies) || !Array.isArray(item.dependencySources)
      || !Array.isArray(item.dependencyEvidence) || !Array.isArray(item.repairs)) {
      failClosed('schema planner migration identity is invalid');
    }
    const effect = migrationRegistry[item.migrationId];
    if (effect.sourceFile !== item.sourceFile || effect.sourceChecksum !== item.sourceChecksum
      || effect.canonicalOrder !== item.canonicalOrder
      || !exactJson(effect.dependencies, item.dependencies)
      || !exactJson(effect.dependencySources, item.dependencySources)
      || (effect.repairClosure ?? null) !== (item.repairClosure ?? null)
      || !exactJson(effect.repairs ?? [], item.repairs)) {
      failClosed(`migration ${item.migrationId} does not match the candidate source registry`);
    }
    ids.add(item.migrationId); lastOrder = item.canonicalOrder;
  }
  const exactDelta = evidence.migrations
    .filter(item => item.state === 'NEEDS_APPLY' && item.safeToApply === true && !item.coveredByRepair)
    .map(migrationApplyProjection);
  if (!exactJson(applyPlanProjection(evidence.applyPlan), exactDelta)) {
    failClosed('schema apply delta does not match planner evidence');
  }
  return new Map(evidence.migrations.map(item => [item.migrationId, item]));
};

const verifyLiveObservation = ({ liveObservation, evidence, contract, now }) => {
  if (liveObservation?.projectRef !== CANONICAL_ERP2_TARGET.supabaseProject
    || liveObservation.fingerprint !== evidence.currentFingerprint
    || !SHA256_PATTERN.test(liveObservation.fingerprint ?? '')
    || ageOf(liveObservation.observedAt, now, 'live schema observation') > contract.schemaBaseline.liveObservationMaxAgeMs) {
    failClosed('fresh live schema observation is missing or mismatched');
  }
};

const verifyPreAdoption = ({ evidence, migrationsById }) => {
  if (!['UNAVAILABLE','AVAILABLE'].includes(evidence.migrationHistoryProvenance)) {
    failClosed('pre-adoption evidence has inconsistent migration-history provenance');
  }
  if (evidence.baselineRecord) failClosed('pre-adoption evidence already contains a baseline adoption record');
  const planIndex = new Map(evidence.applyPlan.map((item, index) => [item.migrationId, index]));
  for (const item of evidence.migrations) {
    if (item.state === 'UNKNOWN') {
      failClosed(`pre-adoption migration ${item.migrationId} is not safely classified`);
    }
    if (item.state === 'SATISFIED') {
      if (planIndex.has(item.migrationId) || item.applyMethod !== 'NO_APPLY') {
        failClosed(`satisfied migration ${item.migrationId} is present in apply delta`);
      }
      continue;
    }
    if (item.state === 'NEEDS_APPLY') {
      if (item.safeToApply !== true || item.dependencyBlocker || !planIndex.has(item.migrationId)
        || item.applyMethod !== 'APPLY_SOURCE_MIGRATION_TRANSACTION') {
        failClosed(`migration ${item.migrationId} is not a safe apply candidate`);
      }
      for (const dependencyId of item.dependencies) {
        const dependency = migrationsById.get(dependencyId);
        if (dependency && dependency.state !== 'SATISFIED'
          && !(dependency.state === 'NEEDS_APPLY' && dependency.safeToApply === true
            && planIndex.get(dependencyId) < planIndex.get(item.migrationId))) {
          failClosed(`migration ${item.migrationId} has an unsafe dependency`);
        }
        if (!dependency) {
          const source = item.dependencySources.find(value => value.migrationId === dependencyId);
          const resolution = item.dependencyEvidence.find(value => value.migrationId === dependencyId);
          if (!source || !resolution || resolution.scope !== 'SOURCE_REGISTRY'
            || resolution.resolution !== 'SATISFIED_BY_SAFE_PRECONDITIONS'
            || resolution.sourceFile !== source.sourceFile || resolution.sourceChecksum !== source.sourceChecksum
            || !SHA256_PATTERN.test(source.sourceChecksum ?? '')) {
            failClosed(`migration ${item.migrationId} has an unproven external dependency`);
          }
        }
      }
      continue;
    }
    if (!['PARTIAL','CONFLICT'].includes(item.state) || !item.coveredByRepair || item.repairClosure !== item.coveredByRepair
      || item.applyMethod !== 'SUPERSEDED_BY_COMPATIBILITY_REPAIR') {
      failClosed(`migration ${item.migrationId} has an uncovered conflict`);
    }
    const repair = migrationsById.get(item.coveredByRepair);
    if (!repair || !repair.repairs.includes(item.migrationId)
      || (repair.state !== 'SATISFIED'
        && !(repair.state === 'NEEDS_APPLY' && repair.safeToApply === true && planIndex.has(repair.migrationId)))) {
      failClosed(`migration ${item.migrationId} supersession proof is invalid`);
    }
  }
};

export const verifyPreAdoptionMaintenanceEvidence = ({ evidence, contract, migrationsById }) => {
  const maintenance = contract.schemaBaseline.preAdoptionMaintenance;
  if (evidence.mode !== maintenance.mode || evidence.currentFingerprint !== maintenance.requiredFingerprint
    || evidence.expectedFingerprint !== maintenance.requiredFingerprint
    || evidence.targetAfterDeltaFingerprint !== maintenance.requiredFingerprint
    || evidence.migrationHistoryProvenance !== 'AVAILABLE'
    || !Array.isArray(evidence.migrations) || !Array.isArray(evidence.applyPlan)
    || evidence.applyPlan.length !== 0 || !Array.isArray(evidence.migrationHistory?.records)) {
    failClosed('PRE_ADOPTION_MAINTENANCE evidence is not canonical');
  }
  for (const item of evidence.migrations) {
    if (item.state !== 'SATISFIED' || item.applyMethod !== 'NO_APPLY') {
      failClosed(`maintenance migration delta is not empty: ${item.migrationId}`);
    }
  }
  const migration = migrationsById.get(maintenance.migrationId);
  if (!migration || migration.state !== 'SATISFIED' || migration.applyMethod !== 'NO_APPLY'
    || migration.sourceChecksum !== maintenance.requiredMigrationSourceChecksum) {
    failClosed('079 is not proven satisfied by the candidate planner');
  }
  const records = evidence.migrationHistory?.records ?? [];
  const applied = records.filter(record => record.eventType === 'MIGRATION_APPLIED'
    && record.eventKey === maintenance.migrationId && record.result === 'PASS');
  if (applied.length !== 1) failClosed('PRE_ADOPTION_MAINTENANCE requires exactly one PASS 079 ledger event');
  const appliedRecord = applied[0];
  if (appliedRecord.sourceHead !== maintenance.requiredMigrationSourceHead
    || appliedRecord.checkpoint !== maintenance.requiredMigrationCheckpoint
    || appliedRecord.sourceChecksum !== maintenance.requiredMigrationSourceChecksum
    || appliedRecord.schemaFingerprintAfter !== maintenance.requiredFingerprint
    || appliedRecord.supabaseProjectRef !== CANONICAL_ERP2_TARGET.supabaseProject
    || appliedRecord.environmentRole !== 'PRODUCTION'
    || appliedRecord.metadata?.historicalMigrationExecutionClaimed === true) {
    failClosed('079 ledger event identity mismatch');
  }
  const adoptionRecords = records.filter(record => record.eventType === 'BASELINE_ADOPTED'
    && record.result === 'PASS');
  if (maintenance.forbidBaselineAdoption && adoptionRecords.some(record =>
    record.schemaFingerprintAfter === maintenance.requiredFingerprint
      || Date.parse(record.recordedAt ?? '') >= Date.parse(appliedRecord.recordedAt ?? ''))) {
    failClosed('PRE_ADOPTION_MAINTENANCE cannot contain a post-079 baseline adoption');
  }
  return { migration: appliedRecord, baselineAdoption: 'NOT_ADOPTED', migrationDelta: [] };
};

export const verifyPost080MaintenanceEvidence = ({ evidence, contract, candidate, migrationsById }) => {
  const maintenance = contract.schemaBaseline.post080Maintenance;
  const bootstrap = evidence.mode === maintenance.bootstrapMode;
  if (!bootstrap && evidence.mode !== maintenance.mode) failClosed('080 maintenance evidence mode is invalid');
  if (evidence.currentFingerprint !== maintenance.requiredFingerprint
    || evidence.expectedFingerprint !== maintenance.requiredFingerprint
    || evidence.targetAfterDeltaFingerprint !== maintenance.requiredFingerprint
    || evidence.migrationHistoryProvenance !== 'AVAILABLE'
    || !Array.isArray(evidence.migrations) || !Array.isArray(evidence.applyPlan)
    || evidence.applyPlan.length !== 0 || !Array.isArray(evidence.migrationHistory?.records)
    || (bootstrap && evidence.baselineRecord)) {
    failClosed('080 maintenance evidence is not canonical');
  }
  for (const item of evidence.migrations) {
    if (item.state !== 'SATISFIED' || item.applyMethod !== 'NO_APPLY') {
      failClosed(`080 maintenance migration delta is not empty: ${item.migrationId}`);
    }
  }
  const migration079 = migrationsById.get('079');
  if (!migration079 || migration079.state !== 'SATISFIED' || migration079.applyMethod !== 'NO_APPLY') {
    failClosed('079 is not proven satisfied by the post-080 schema');
  }
  const records = evidence.migrationHistory.records;
  const applied080 = records.filter(record => record.eventType === 'MIGRATION_APPLIED'
    && record.eventKey === maintenance.migrationId && record.result === 'PASS');
  if (bootstrap) {
    if (applied080.length !== 0) failClosed('080 bootstrap cannot run after an existing 080 ledger event');
    const bootstrapProof = evidence.auditBootstrap;
    if (!bootstrapProof || bootstrapProof.migrationId !== '080'
      || bootstrapProof.sourceChecksum !== maintenance.requiredMigrationSourceChecksum
      || bootstrapProof.sourceHead !== maintenance.requiredMigrationSourceHead
      || bootstrapProof.checkpoint !== maintenance.requiredMigrationCheckpoint
      || bootstrapProof.schemaFingerprintBefore !== maintenance.previousFingerprint
      || bootstrapProof.schemaFingerprintAfter !== maintenance.requiredFingerprint
      || bootstrapProof.candidateHead !== candidate.head
      || bootstrapProof.candidateCheckpoint !== candidate.checkpointTag
      || bootstrapProof.runnerPath !== maintenance.auditRunnerPath
      || bootstrapProof.runnerCommit !== maintenance.auditRunnerCommit) {
      failClosed('080 audit bootstrap proof is missing or mismatched');
    }
  } else {
    if (applied080.length !== 1) failClosed('post-080 maintenance requires exactly one PASS 080 ledger event');
    const record = applied080[0];
    if (record.sourceHead !== maintenance.requiredMigrationSourceHead
      || record.checkpoint !== maintenance.requiredMigrationCheckpoint
      || record.sourceChecksum !== maintenance.requiredMigrationSourceChecksum
      || record.schemaFingerprintBefore !== maintenance.previousFingerprint
      || record.schemaFingerprintAfter !== maintenance.requiredFingerprint
      || record.supabaseProjectRef !== CANONICAL_ERP2_TARGET.supabaseProject
      || record.environmentRole !== 'PRODUCTION'
      || record.metadata?.historicalMigrationExecutionClaimed === true) {
      failClosed('080 ledger event identity mismatch');
    }
  }
  const adoptionRecords = records.filter(record => record.eventType === 'BASELINE_ADOPTED'
    && record.result === 'PASS');
  const applied080At = bootstrap ? null : Date.parse(applied080[0]?.recordedAt ?? '');
  if (!bootstrap && evidence.baselineRecord) {
    const baselineAt = Date.parse(evidence.baselineRecord.recordedAt ?? '');
    if (!Number.isFinite(applied080At) || !Number.isFinite(baselineAt) || baselineAt >= applied080At) {
      failClosed('080 maintenance contains a post-080 baseline adoption');
    }
  }
  const disallowedAdoptions = adoptionRecords.filter(record => {
    if (bootstrap) return true;
    const recordedAt = Date.parse(record.recordedAt ?? '');
    return !Number.isFinite(applied080At) || !Number.isFinite(recordedAt) || recordedAt >= applied080At;
  });
  if (maintenance.forbidBaselineAdoption && disallowedAdoptions.length > 0) {
    failClosed('080 maintenance cannot contain baseline adoption');
  }
  return { migration: applied080[0] ?? null, baselineAdoption: 'NOT_ADOPTED', migrationDelta: [] };
};

// Normal post-080 product releases stay in PRE-ADOPTION. They reuse the
// exact 080 ledger/fingerprint proof, but are inspected by the immutable
// reviewed-descendant path instead of the one-shot 080 maintenance panel.
export const verifyPost080ProductEvidence = ({ evidence, contract, candidate, migrationsById }) => {
  const release = contract.schemaBaseline.post080ProductRelease;
  if (evidence.mode !== release.mode) failClosed('post-080 product evidence mode is invalid');
  const maintenanceContract = {
    ...contract,
    schemaBaseline: {
      ...contract.schemaBaseline,
      post080Maintenance: { ...contract.schemaBaseline.post080Maintenance, mode: release.mode },
    },
  };
  return verifyPost080MaintenanceEvidence({ evidence, contract: maintenanceContract, candidate, migrationsById });
};

const verifyPostAdoption = ({ evidence, required, candidate, candidateGit, changeImpactEvidence, now,
  baselineExceptionConfig, evidenceRoot }) => {
  if (evidence.currentFingerprint !== evidence.expectedFingerprint
    || evidence.migrationHistoryProvenance !== 'AVAILABLE'
    || evidence.applyPlan.length !== 0
    || evidence.migrations.some(item => item.state !== 'SATISFIED' || item.applyMethod !== 'NO_APPLY')) {
    failClosed('post-adoption schema is not fully canonical');
  }
  const record = evidence.baselineRecord;
  if (record?.eventType !== 'BASELINE_ADOPTED' || record.eventKey !== required
    || record.result !== 'PASS' || record.supabaseProjectRef !== CANONICAL_ERP2_TARGET.supabaseProject
    || record.environmentRole !== 'PRODUCTION'
    || record.schemaFingerprintAfter !== evidence.currentFingerprint
    || record.metadata?.historicalMigrationExecutionClaimed !== false) {
    failClosed('post-adoption baseline ledger evidence mismatch');
  }
  if (record.sourceHead === candidate.head && record.checkpoint === candidate.checkpointTag) {
    return { result: 'PASS', mode: 'EXACT_BASELINE', baselineHead: record.sourceHead,
      baselineCheckpoint: record.checkpoint, schemaBaselineMutated: false };
  }
  if (typeof candidateGit !== 'function') failClosed('descendant deployment requires actual Git evidence');
  return verifySafeDescendant({ git: candidateGit, candidate, baselineRecord: record, changeImpactEvidence, now,
    baselineExceptionConfig, evidenceRoot });
};

export function verifySchemaBaselineEvidence({ evidence, contract, candidate, liveObservation, migrationRegistry, candidateGit, changeImpactEvidence,
  baselineExceptionConfig = null, evidenceRoot = null, now = Date.now() }) {
  assertCanonicalContract(contract);
  const required = contract.schemaBaseline.requiredBaselineId;
  const maintenance079 = contract.schemaBaseline.preAdoptionMaintenance;
  const maintenance080 = contract.schemaBaseline.post080Maintenance;
  const post080Product = contract.schemaBaseline.post080ProductRelease;
  const expectedFingerprint = evidence?.mode === maintenance079?.mode
    ? maintenance079.requiredFingerprint : contract.schemaBaseline.canonicalFingerprint;
  if (!evidence || evidence.contractVersion !== contract.schemaBaseline.evidenceContractVersion
    || evidence.fingerprintContractVersion !== SCHEMA_FINGERPRINT_CONTRACT_VERSION
    || evidence.canonicalContract !== SCHEMA_CANONICAL_CONTRACT
    || evidence.canonicalAlgorithm !== SQL_CANONICAL_ALGORITHM
    || !['PRE_ADOPTION', 'POST_ADOPTION', 'PRE_ADOPTION_MAINTENANCE', maintenance080?.mode, maintenance080?.bootstrapMode,
      post080Product?.mode].includes(evidence.mode)
    || evidence.requiredBaselineId !== required
    || evidence.projectRef !== CANONICAL_ERP2_TARGET.supabaseProject
    || evidence.sourceHead !== candidate.head || evidence.checkpoint !== candidate.checkpointTag
    || !SHA256_PATTERN.test(evidence.currentFingerprint ?? '')
    || evidence.expectedFingerprint !== expectedFingerprint
    || evidence.targetAfterDeltaFingerprint !== evidence.expectedFingerprint
    || evidence.readyForApply !== true || !Array.isArray(evidence.blockers) || evidence.blockers.length !== 0
    || !SHA256_PATTERN.test(evidence.evidenceFingerprint ?? '')) {
    failClosed('schema reconciliation evidence is missing, stale, or not canonical');
  }
  const snapshot = evidence.snapshotIdentity;
  if (snapshot?.projectRef !== evidence.projectRef || snapshot.environmentRole !== 'PRODUCTION'
    || snapshot.currentFingerprint !== evidence.currentFingerprint
    || snapshot.snapshotToolChecksum !== contract.schemaBaseline.snapshotToolChecksum
    || !SHA256_PATTERN.test(snapshot.schemaSnapshotChecksum ?? '')
    || ageOf(snapshot.capturedAt, now, 'schema snapshot') > contract.schemaBaseline.snapshotMaxAgeMs) {
    failClosed('schema snapshot identity is missing, stale, or mismatched');
  }
  verifyLiveObservation({ liveObservation, evidence, contract, now });
  const migrationsById = verifyPlannerContract(evidence, migrationRegistry);
  let deploymentLineage = null;
  if (evidence.mode === 'POST_ADOPTION') {
    deploymentLineage = verifyPostAdoption({ evidence, required, candidate, candidateGit, changeImpactEvidence, now,
      baselineExceptionConfig, evidenceRoot });
  } else if (evidence.mode === 'PRE_ADOPTION_MAINTENANCE') {
    verifyPreAdoptionMaintenanceEvidence({ evidence, contract, migrationsById });
    if (typeof candidateGit !== 'function') failClosed('maintenance deployment requires actual Git evidence');
    const inspection = inspectPreAdoptionMaintenance({ git: candidateGit, candidate, contract });
    const regressionEvidence = changeImpactEvidence
      ? verifyImpactEvidence({ evidence: changeImpactEvidence, inspection, git: candidateGit, now,
        baselineExceptionConfig, evidenceRoot }) : null;
    if (!regressionEvidence) failClosed('maintenance change-impact evidence is required');
    deploymentLineage = { ...inspection, regressionEvidence };
  } else if (evidence.mode === maintenance080?.mode || evidence.mode === maintenance080?.bootstrapMode) {
    verifyPost080MaintenanceEvidence({ evidence, contract, candidate, migrationsById });
    if (typeof candidateGit !== 'function') failClosed('080 maintenance deployment requires actual Git evidence');
    const inspection = inspectPost080Maintenance({ git: candidateGit, candidate, contract });
    const regressionEvidence = changeImpactEvidence
      ? verifyImpactEvidence({ evidence: changeImpactEvidence, inspection, git: candidateGit, now,
        baselineExceptionConfig, evidenceRoot }) : null;
    if (!regressionEvidence) failClosed('080 maintenance change-impact evidence is required');
    deploymentLineage = { ...inspection, regressionEvidence };
  } else if (evidence.mode === post080Product?.mode) {
    verifyPost080ProductEvidence({ evidence, contract, candidate, migrationsById });
    if (typeof candidateGit !== 'function') failClosed('post-080 product deployment requires actual Git evidence');
    const baselineRecord = {
      eventType: 'POST_080_RELEASE_BASELINE', result: 'PASS',
      sourceHead: post080Product.approvedBaseHead,
      checkpoint: post080Product.approvedBaseCheckpoint,
      schemaFingerprintAfter: post080Product.requiredFingerprint,
      supabaseProjectRef: CANONICAL_ERP2_TARGET.supabaseProject,
      environmentRole: 'PRODUCTION',
      metadata: { historicalMigrationExecutionClaimed: false },
    };
    const inspection = inspectSafeDescendant({ git: candidateGit, candidate, baselineRecord });
    const requiredRegressions = [...new Set([
      ...inspection.requiredRegressions,
      ...post080Product.requiredRegressions,
    ])];
    const productInspection = { ...inspection, mode: post080Product.mode, requiredRegressions };
    const regressionEvidence = changeImpactEvidence
      ? verifyImpactEvidence({ evidence: changeImpactEvidence, inspection: productInspection, git: candidateGit, now,
        baselineExceptionConfig, evidenceRoot }) : null;
    if (!regressionEvidence) failClosed('post-080 product change-impact evidence is required');
    deploymentLineage = { ...productInspection, regressionEvidence };
  } else {
    verifyPreAdoption({ evidence, migrationsById });
  }
  return {
    result: 'PASS', mode: evidence.mode, baselineId: required,
    currentFingerprint: evidence.currentFingerprint,
    targetAfterDeltaFingerprint: evidence.targetAfterDeltaFingerprint,
    applyDelta: evidence.applyPlan.map(item => item.migrationId),
    deploymentLineage,
  };
}

export function validatePublicTarget(environment, target = CANONICAL_ERP2_TARGET) {
  if (environment.VITE_DEPLOYMENT_ENV?.trim() !== target.deploymentEnvironment) {
    failClosed('deployment environment role is not ERP 2 staging');
  }
  let url;
  try { url = new URL(environment.VITE_SUPABASE_URL ?? ''); }
  catch { failClosed('Supabase URL is invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== `${target.supabaseProject}.supabase.co` || url.pathname !== '/') {
    failClosed('Supabase project ref does not match ERP 2');
  }
  const publicKey = environment.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
  const publicFingerprint = publicKey ? sha256(publicKey).slice(0, 16) : '';
  if (!publicKey || publicFingerprint !== target.publicFingerprint) failClosed('public fingerprint does not match ERP 2');
  return { supabaseProject: target.supabaseProject, publicFingerprint, supabaseOrigin: url.origin };
}

const allowedRemoteUrls = (gate) => [
  `https://github.com/${gate.repository}`,
  `https://github.com/${gate.repository}.git`,
  `git@github.com:${gate.repository}.git`,
  `ssh://git@github.com/${gate.repository}.git`,
];

const parseRemoteRefs = output => new Map(String(output).trim().split(/\r?\n/u).filter(Boolean).map(line => {
  const [head, ref] = line.split(/\s+/u);
  return [ref, head];
}));

const remoteTagCommit = (refs, tagName) => refs.get(`refs/tags/${tagName}^{}`)
  ?? refs.get(`refs/tags/${tagName}`);

const assertRefName = (git, kind, name) => {
  try { git(['check-ref-format', `refs/${kind}/${name}`]); }
  catch { failClosed(`invalid ${kind === 'heads' ? 'branch' : 'tag'} name`); }
};

const isAncestor = (git, ancestor, descendant) => {
  try { git(['--no-replace-objects', 'merge-base', '--is-ancestor', ancestor, descendant]); return true; }
  catch { return false; }
};

export function verifyLocalCandidate({ contract, git, checkpointTag, label = 'candidate' }) {
  const { gate, target } = assertCanonicalContract(contract);
  if (!checkpointTag?.startsWith('checkpoint-')) failClosed(`${label} requires an explicit checkpoint tag`);
  const head = git(['rev-parse', 'HEAD']).trim();
  const branch = git(['branch', '--show-current']).trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) failClosed(`${label} HEAD is not a full SHA`);
  if (!new RegExp(gate.allowedBranchPattern, 'u').test(branch)) failClosed(`${label} branch is outside the approved pattern`);
  if (git(['status', '--porcelain', '--untracked-files=all']).trim()) failClosed(`${label} worktree is not clean`);
  assertRefName(git, 'heads', branch);
  assertRefName(git, 'tags', checkpointTag);
  if (git(['rev-parse', `${checkpointTag}^{}`]).trim() !== head) failClosed(`${label} local checkpoint does not peel to HEAD`);
  if (git(['rev-parse', `${gate.acceptedTag}^{}`]).trim() !== gate.acceptedHead) failClosed('local accepted baseline tag mismatch');
  if (git(['rev-parse', `${gate.lineage.reconciliationTag}^{}`]).trim() !== gate.lineage.reconciliationHead) {
    failClosed('local reconciliation checkpoint mismatch');
  }
  const lineageMode = isAncestor(git, gate.acceptedHead, head)
    ? 'DIRECT_ACCEPTED_BASELINE_DESCENDANT'
    : isAncestor(git, gate.lineage.reconciliationHead, head)
      ? 'RECONCILED_CHECKPOINT_DESCENDANT'
      : failClosed(`${label} is outside the approved promotion lineage`);
  return {
    head, branch, checkpointTag, lineageMode,
    acceptedBaselineTag: gate.acceptedTag,
    acceptedBaselineHead: gate.acceptedHead,
    reconciliationTag: gate.lineage.reconciliationTag,
    reconciliationHead: gate.lineage.reconciliationHead,
    target,
  };
}

export function verifyRemoteCandidate({ contract, git, checkpointTag, label = 'candidate' }) {
  const local = verifyLocalCandidate({ contract, git, checkpointTag, label });
  const { gate } = assertCanonicalContract(contract);
  const remoteUrl = git(['remote', 'get-url', gate.remote]).trim();
  if (!allowedRemoteUrls(gate).includes(remoteUrl)) failClosed(`${label} remote is not the approved repository`);
  const output = git(['ls-remote', gate.remote,
    `refs/heads/${local.branch}`,
    `refs/tags/${checkpointTag}`, `refs/tags/${checkpointTag}^{}`,
    `refs/tags/${gate.acceptedTag}`, `refs/tags/${gate.acceptedTag}^{}`,
    `refs/tags/${gate.lineage.reconciliationTag}`, `refs/tags/${gate.lineage.reconciliationTag}^{}`,
  ]);
  const refs = parseRemoteRefs(output);
  if (refs.get(`refs/heads/${local.branch}`) !== local.head) failClosed(`${label} remote branch HEAD mismatch`);
  if (remoteTagCommit(refs, checkpointTag) !== local.head) failClosed(`${label} remote checkpoint mismatch or missing`);
  if (remoteTagCommit(refs, gate.acceptedTag) !== gate.acceptedHead) failClosed('remote accepted baseline mismatch or missing');
  if (remoteTagCommit(refs, gate.lineage.reconciliationTag) !== gate.lineage.reconciliationHead) {
    failClosed('remote reconciliation checkpoint mismatch or missing');
  }
  return { ...local, remoteBranchHead: local.head, remoteCheckpointPeeledHead: local.head };
}

const projectName = row => row?.name ?? row?.['Project Name'] ?? row?.project_name;
const projectDomains = row => {
  const value = row?.domains ?? row?.Domains ?? row?.['Project Domains'];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map(domain => domain.trim()).filter(Boolean);
  return [];
};

export function verifyCloudflareIdentity({ contract, wrangler }) {
  const { account, target } = assertCanonicalContract(contract);
  const whoami = wrangler(['whoami', '--json'], account.accountId);
  const accounts = Array.isArray(whoami?.accounts) ? whoami.accounts.map(row => row.id) : [];
  if (!whoami?.loggedIn || !accounts.includes(account.accountId)) failClosed('active Wrangler account does not include ERP 2 account');
  const projects = wrangler(['pages', 'project', 'list', '--profile', account.profile, '--json'], account.accountId);
  const project = Array.isArray(projects) ? projects.find(row => projectName(row) === target.cloudflareProject) : null;
  if (!project) failClosed('ERP 2 Pages project is not visible in the selected account/profile');
  const domains = projectDomains(project);
  if (!domains.includes(target.pagesDomain)) {
    failClosed('ERP 2 Pages domain does not match project metadata');
  }
  return { accountId: account.accountId, profile: account.profile, project: target.cloudflareProject, domain: target.pagesDomain };
}

export function verifyPromotionIdentity({ contract, checkpointTag, candidateGit, guardGit, guardCheckpointTag,
  wrangler, environment, targetValidator = validatePublicTarget }) {
  const publicTarget = targetValidator(environment);
  const candidate = verifyRemoteCandidate({ contract, git: candidateGit, checkpointTag, label: 'candidate' });
  const sameSource = guardGit === candidateGit;
  const guardSource = verifyRemoteCandidate({
    contract,
    git: guardGit,
    checkpointTag: guardCheckpointTag || (sameSource ? checkpointTag : ''),
    label: 'guard source',
  });
  const cloudflare = verifyCloudflareIdentity({ contract, wrangler });
  const candidateAfter = candidateGit(['rev-parse', 'HEAD']).trim();
  const guardAfter = guardGit(['rev-parse', 'HEAD']).trim();
  if (candidateAfter !== candidate.head || guardAfter !== guardSource.head
    || candidateGit(['status', '--porcelain', '--untracked-files=all']).trim()
    || guardGit(['status', '--porcelain', '--untracked-files=all']).trim()) failClosed('source changed during verification');
  return { result: 'PASS', candidate, guardSource, cloudflare, publicTarget };
}

export const runGitAt = cwd => args => {
  try {
    // Windows repositories may contain legacy backup paths whose tree lookups
    // exceed the default Win32 path handling. Keep the guard read-only while
    // enabling Git's long-path resolver; no policy or repository writes change.
    return execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
  } catch { failClosed(`read-only Git check failed: ${args[0]}`); }
};

export async function listArtifactFiles(root) {
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name !== 'erp-build-identity.json') files.push(path);
    }
  };
  await visit(root);
  return Promise.all(files.sort().map(async path => ({
    file: relative(root, path).replaceAll('\\', '/'),
    bytes: (await stat(path)).size,
    sha256: sha256(await readFile(path)),
  })));
}

export function buildManifestIdentity(manifestWithoutIdentity) {
  return sha256(JSON.stringify(manifestWithoutIdentity));
}

export async function verifyArtifactIdentity({ artifactRoot, proof, contract }) {
  const { target } = assertCanonicalContract(contract);
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(artifactRoot, 'erp-build-identity.json'), 'utf8')); }
  catch { failClosed('build identity manifest missing or invalid'); }
  const { identity, ...evidence } = manifest;
  if (manifest.schemaVersion !== 2 || identity !== buildManifestIdentity(evidence)) failClosed('artifact manifest identity mismatch');
  if (manifest.schemaContract?.name !== contract.schemaBaseline.canonicalContract
    || manifest.schemaContract?.algorithm !== contract.schemaBaseline.canonicalAlgorithm
    || manifest.schemaContract?.version !== contract.schemaBaseline.fingerprintContractVersion
    || manifest.schemaContract?.fingerprint !== contract.schemaBaseline.canonicalFingerprint) {
    failClosed('artifact canonical contract mismatch');
  }
  const source = manifest.source ?? {};
  if (source.head !== proof.candidate.head || source.branch !== proof.candidate.branch
    || source.checkpointTag !== proof.candidate.checkpointTag
    || source.acceptedBaselineTag !== proof.candidate.acceptedBaselineTag
    || source.acceptedBaselineHead !== proof.candidate.acceptedBaselineHead
    || source.lineageMode !== proof.candidate.lineageMode) failClosed('artifact source identity does not match verified candidate');
  if (manifest.target?.role !== target.role || manifest.target?.accountId !== target.cloudflareAccountId
    || manifest.target?.project !== target.cloudflareProject || manifest.target?.supabaseProject !== target.supabaseProject
    || manifest.target?.publicFingerprint !== target.publicFingerprint
    || manifest.target?.runtimeMarker !== target.runtimeMarker) failClosed('artifact target identity mismatch');
  if (!manifest.build?.timestamp || Number.isNaN(Date.parse(manifest.build.timestamp))) failClosed('artifact build timestamp missing');
  const files = await listArtifactFiles(artifactRoot);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) failClosed('artifact file hash inventory mismatch');
  return { result: 'PASS', identity, files: files.length, source, target: manifest.target, build: manifest.build };
}
