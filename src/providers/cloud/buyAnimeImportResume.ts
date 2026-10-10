import type { InventoryItem, ImportStats } from '../../lib/db';
import type { planCloudInventoryImport } from './inventoryImportPlan';
import type { planCatalogTransaction, CatalogCommitOutcome } from './catalogTransaction';
import { deterministicCloudUuid, toCloudFieldRow } from './cloudEntityPayload';
import { CloudMutationBoundaryError } from './cloudFieldCas';
import { classifyMyAcgImportError, myAcgImportDiagnostic } from '../../utils/myacgImportErrors';
import { markBuyAnimeTrace, recordBuyAnimeCatalogEvidence } from '../../diagnostics/buyAnimeProductionTrace';
import type { MyAcgMasterLink } from '../../waca/masterReference';
import { assertBuyAnimeGenerationUnchanged, assertBuyAnimeRecoveryCurrent, classifyBuyAnimeRecoveryGeneration, type BuyAnimeRestoreGeneration } from './buyAnimeRecoveryEpoch';
import { inventoryImportIntent, validInventoryIntent, type InventoryImportIntent, type InventoryCommitOutcome } from './inventoryImportTransaction';

export const BUYANIME_JOURNAL_PLATFORM = 'buyanime-catalog-resume-v1';
export const BUYANIME_COMPLETION_CONTRACT = 'INVENTORY_CATALOG_AUTHORITATIVE';
export type BuyAnimeStage = 'PLANNED' | 'INVENTORY_COMMITTING' | 'INVENTORY_COMMIT_UNKNOWN' | 'INVENTORY_NOT_COMMITTED'
  | 'INVENTORY_COMMITTED' | 'INVENTORY_READBACK_PENDING' | 'INVENTORY_VERIFIED'
  | 'CATALOG_PENDING' | 'CATALOG_COMMITTING' | 'CATALOG_COMMITTED' | 'CATALOG_VERIFIED'
  | 'WACA_EVIDENCE_PENDING' | 'COMPLETE' | 'FAILED_PRE_COMMIT';
export type CatalogImportPlan = Awaited<ReturnType<typeof planCatalogTransaction>>;
export interface InventoryProof { id: string; key: string; hash: string }
export interface WacaMasterLinkDeltaPlan {
  key: string;
  expectedRevision: number;
  links: MyAcgMasterLink[];
  inserted: number;
  updated: number;
  unchanged: number;
}
export interface BuyAnimeImportRecord {
  format: 'BUYANIME_IMPORT_RESUME_V1';
  batchId: string;
  fileName: string;
  observedAt: string;
  /** Optional operational metadata in existing details JSON; old backups stay valid. */
  restoreEpoch?: number;
  stage: BuyAnimeStage;
  version: number;
  expected: InventoryProof[];
  stats: ImportStats;
  inventory?: InventoryImportIntent;
  catalog?: { key: string; plan: CatalogImportPlan | null };
  waca?: WacaMasterLinkDeltaPlan;
  legacy?: boolean;
  retirement?: BuyAnimeLegacyRetirement;
}
/** Terminal audit for a pre-intent (legacy) journal whose Inventory transaction
 * is PROVEN not committed. It retires the request without any Business write or
 * replay; the original journal row/proofs stay as immutable audit evidence. */
export interface BuyAnimeLegacyRetirement {
  kind: 'LEGACY_NOT_COMMITTED_VERIFIED';
  verifiedAt: string;
  previousStage: 'INVENTORY_COMMITTING' | 'INVENTORY_COMMIT_UNKNOWN';
  restoreEpoch: number;
  expectedRows: number;
  absentPredictedCreates: number;
  presentRows: number;
  targetMatches: number;
  businessMutation: 0;
  inventoryReplay: 0;
}
export interface BuyAnimeLegacyInventoryEvidence {
  /** Rows read by the journal's exact expected UUIDs (missing ids omitted). */
  rows: InventoryItem[];
  /** Rows, INCLUDING tombstones, holding any absent proof's business key. */
  keyRows: Array<{ id: string; inventory_key: string | null; deleted_at: string | null }>;
}
export class BuyAnimeResumeError extends Error {
  readonly code: string;
  readonly record?: BuyAnimeImportRecord;
  readonly recoveryDiagnostic?: BuyAnimeJournalDecision;
  constructor(code: string, record?: BuyAnimeImportRecord, cause?: unknown, recoveryDiagnostic?: BuyAnimeJournalDecision) {
    super(code, { cause }); this.code = code; this.record = record; this.name = 'BuyAnimeResumeError';
    this.recoveryDiagnostic = recoveryDiagnostic;
  }
}
export const importJournalId = (batchId: string) => deterministicCloudUuid('buyanime-import-journal:' + batchId);
export const importCatalogKey = (batchId: string) => deterministicCloudUuid('buyanime-import-catalog:' + batchId);
export const importWacaDeltaKey = (batchId: string) => deterministicCloudUuid('buyanime-import-waca-delta:' + batchId);
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, v]) => v !== undefined).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value);
};
export async function inventoryProof(row: InventoryItem): Promise<InventoryProof> {
  const fields = toCloudFieldRow('inventory_items', row);
  delete fields.version;
  if (typeof fields.catalog_last_seen_at === 'string') fields.catalog_last_seen_at = new Date(fields.catalog_last_seen_at).toISOString();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(fields)));
  return { id: String(fields.id), key: String(fields.inventory_key),
    hash: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') };
}
export async function proveInventoryRows(record: BuyAnimeImportRecord, rows: InventoryItem[]): Promise<void> {
  if (!record.expected.length || rows.length !== record.expected.length) throw new BuyAnimeResumeError('BUYANIME_READBACK_COUNT_MISMATCH', record);
  const byId = new Map(rows.map(row => [row.database_id || row.id, row]));
  if (byId.size !== rows.length) throw new BuyAnimeResumeError('BUYANIME_READBACK_DUPLICATE_ID', record);
  for (let offset = 0; offset < record.expected.length; offset += 150) {
    await Promise.all(record.expected.slice(offset, offset + 150).map(async expected => {
    const row = byId.get(expected.id);
    if (!row || row.id !== expected.id || (row.database_id && row.database_id !== expected.id)
      || stable(await inventoryProof(row)) !== stable(expected))
      throw new BuyAnimeResumeError('BUYANIME_READBACK_IDENTITY_OR_FIELDS_MISMATCH', record);
    }));
    if (offset + 150 < record.expected.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}
const STAGES = new Set<BuyAnimeStage>(['PLANNED','INVENTORY_COMMITTING','INVENTORY_COMMIT_UNKNOWN','INVENTORY_NOT_COMMITTED',
  'INVENTORY_COMMITTED','INVENTORY_READBACK_PENDING','INVENTORY_VERIFIED','CATALOG_PENDING',
  'CATALOG_COMMITTING','CATALOG_COMMITTED','CATALOG_VERIFIED','WACA_EVIDENCE_PENDING','COMPLETE','FAILED_PRE_COMMIT']);
export function assertImportRecord(value: unknown): asserts value is BuyAnimeImportRecord {
  const r = value as BuyAnimeImportRecord | null;
  if (!r || r.format !== 'BUYANIME_IMPORT_RESUME_V1' || !/^catalog_import_[0-9a-f-]{36}$/iu.test(r.batchId)
    || !STAGES.has(r.stage) || !Number.isSafeInteger(r.version) || r.version < 0
    || typeof r.fileName !== 'string' || !Number.isFinite(Date.parse(r.observedAt))
    || (r.restoreEpoch !== undefined && (!Number.isSafeInteger(r.restoreEpoch) || r.restoreEpoch < 0))
    || !Array.isArray(r.expected) || r.expected.length === 0 || !r.stats
    || new Set(r.expected.map(p => p.id)).size !== r.expected.length
    || new Set(r.expected.map(p => p.key)).size !== r.expected.length
    || r.expected.some(p => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(p.id)
      || !p.key || !/^[0-9a-f]{64}$/u.test(p.hash))
    || (r.inventory && !validInventoryIntent(r.inventory, r.batchId, r.restoreEpoch))) {
    throw new BuyAnimeResumeError('BUYANIME_JOURNAL_INVALID');
  }
  const expectedIds = new Set(r.expected.map(proof => proof.id));
  if ((r.inventory && r.inventory.request.operations.some(op => !expectedIds.has(op.id)))
    || (['CATALOG_COMMITTING','CATALOG_COMMITTED'].includes(r.stage) && !r.catalog)
    || (r.catalog && (r.catalog.key !== importCatalogKey(r.batchId)
      || (r.catalog.plan && (r.catalog.plan.request.family !== 'catalog' || r.catalog.plan.request.mode !== 'sync'))))
    || (r.stage === 'WACA_EVIDENCE_PENDING' && !r.waca)
    || (r.waca && (r.waca.key !== importWacaDeltaKey(r.batchId)
      || !Number.isSafeInteger(r.waca.expectedRevision) || r.waca.expectedRevision < 0
      || !Array.isArray(r.waca.links) || r.waca.links.some(link => !link.childCode || !link.mainCode)))
    || (r.retirement && (r.stage !== 'FAILED_PRE_COMMIT' || r.inventory || r.catalog
      || r.retirement.kind !== 'LEGACY_NOT_COMMITTED_VERIFIED' || r.retirement.restoreEpoch !== r.restoreEpoch
      || r.retirement.businessMutation !== 0 || r.retirement.inventoryReplay !== 0
      || r.retirement.expectedRows !== r.expected.length
      || ![r.retirement.absentPredictedCreates, r.retirement.presentRows, r.retirement.targetMatches]
        .every(value => Number.isSafeInteger(value) && value >= 0)))) {
    throw new BuyAnimeResumeError('BUYANIME_JOURNAL_INVALID');
  }
}

export interface BuyAnimeJournalDecision {
  classification: 'STALE_AFTER_RESTORE' | 'COMPLETED_OLD_IMPORT' | 'INCOMPLETE_CURRENT_IMPORT' | 'CORRUPT_IDENTITY';
  recoveryAction: 'RETIRE_AS_STALE' | 'RETIRE_AS_COMPLETE' | 'RESUME' | 'RECONCILE' | 'FAIL_CLOSED_CORRUPT';
  blockNewImport: boolean;
  journalRequestId: string;
  journalRestoreEpoch?: number;
  currentRestoreEpoch: number;
  mismatchField: string[];
  journalVersion: number;
  rowVersion: number;
}

/** Restore intentionally resets row CAS versions. A retained old-epoch journal
 * is audit, NOT a resumable write intent. Never relax current-request checks. */
export function classifyBuyAnimeJournalIdentity(
  row: Record<string, unknown>, record: BuyAnimeImportRecord, generation: BuyAnimeRestoreGeneration,
): BuyAnimeJournalDecision {
  assertImportRecord(record);
  const details = row.details as { buyAnimeImport?: Partial<BuyAnimeImportRecord>; buyAnimeImportGzip?: string } | null;
  const header = details?.buyAnimeImport;
  const mismatchField: string[] = [];
  if (details?.buyAnimeImportGzip) {
    for (const key of ['format', 'batchId', 'stage', 'version', 'restoreEpoch'] as const)
      if (header?.[key] !== record[key]) mismatchField.push('header.' + key);
  }
  if (row.id !== importJournalId(record.batchId)) mismatchField.push('id');
  if (row.platform !== BUYANIME_JOURNAL_PLATFORM) mismatchField.push('platform');
  if (row.deleted_at) mismatchField.push('deleted_at');
  if (row.file_name !== record.fileName) mismatchField.push('file_name');
  if (Number(row.total_rows) !== record.expected.length) mismatchField.push('total_rows');
  const stale = classifyBuyAnimeRecoveryGeneration(record, generation) === 'STALE_AFTER_RESTORE';
  if (Number(row.version) !== record.version) mismatchField.push('row.version');
  const corrupt = mismatchField.some(field => field !== 'row.version') || (!stale && mismatchField.length > 0);
  const complete = ['COMPLETE', 'FAILED_PRE_COMMIT'].includes(record.stage);
  return {
    classification: corrupt ? 'CORRUPT_IDENTITY' : stale ? 'STALE_AFTER_RESTORE'
      : complete ? 'COMPLETED_OLD_IMPORT' : 'INCOMPLETE_CURRENT_IMPORT',
    recoveryAction: corrupt ? 'FAIL_CLOSED_CORRUPT' : stale ? 'RETIRE_AS_STALE'
      : complete ? 'RETIRE_AS_COMPLETE' : ['INVENTORY_COMMITTING', 'INVENTORY_COMMIT_UNKNOWN', 'CATALOG_COMMITTING', 'CATALOG_COMMITTED'].includes(record.stage)
        ? 'RECONCILE' : 'RESUME',
    blockNewImport: corrupt || (!stale && !complete),
    journalRequestId: record.batchId, journalRestoreEpoch: record.restoreEpoch,
    currentRestoreEpoch: generation.epoch, mismatchField, journalVersion: record.version, rowVersion: Number(row.version),
  };
}
export interface BuyAnimeImportPort {
  readRestoreGeneration?: () => Promise<BuyAnimeRestoreGeneration>;
  load(batchId: string): Promise<BuyAnimeImportRecord | null>;
  save(record: BuyAnimeImportRecord, expectedVersion: number): Promise<BuyAnimeImportRecord>;
  readInventory(record: BuyAnimeImportRecord): Promise<InventoryItem[]>;
  prepareInventory(items: InventoryItem[]): Promise<ReturnType<typeof planCloudInventoryImport>>;
  commitInventory(plan: ReturnType<typeof planCloudInventoryImport>, record?: BuyAnimeImportRecord): Promise<void>;
  reconcileInventory?: (record: BuyAnimeImportRecord) => Promise<InventoryCommitOutcome>;
  resumeInventory?: (record: BuyAnimeImportRecord) => Promise<void>;
  planCatalog(imported: InventoryItem[], inventory?: InventoryItem[], fresh?: boolean): Promise<CatalogImportPlan | null>;
  commitCatalog(catalog: NonNullable<BuyAnimeImportRecord['catalog']>): Promise<void>;
  reconcileCatalog?: (catalog:NonNullable<BuyAnimeImportRecord['catalog']>) => Promise<CatalogCommitOutcome>;
  verifyCatalog(catalog: NonNullable<BuyAnimeImportRecord['catalog']>): Promise<void>;
  readLegacyInventoryEvidence?: (record: BuyAnimeImportRecord) => Promise<BuyAnimeLegacyInventoryEvidence>;
}
/** A journal written before exact Inventory intent existed, still awaiting an
 * outcome. It can never be replayed; it can only be proven and retired. */
export function isUnresolvedLegacyInventoryJournal(record: BuyAnimeImportRecord): boolean {
  return !record.inventory && !record.legacy && !record.catalog && !record.retirement && record.version > 0
    && (record.stage === 'INVENTORY_COMMITTING' || record.stage === 'INVENTORY_COMMIT_UNKNOWN');
}

/** Durable progress lives in the existing import_batches.details JSON. No memory/session authority. */
export class BuyAnimeImportPipeline {
  private readonly port: BuyAnimeImportPort;
  private readonly verified = new WeakMap<BuyAnimeImportRecord, { rows: InventoryItem[]; inventory: InventoryItem[] }>();
  onStage?: (stage: BuyAnimeStage) => void;
  constructor(port: BuyAnimeImportPort) { this.port = port; }
  private async assertCurrent(record: BuyAnimeImportRecord): Promise<void> {
    if (this.port.readRestoreGeneration) assertBuyAnimeRecoveryCurrent(record, await this.port.readRestoreGeneration());
  }
  private async store(record: BuyAnimeImportRecord, patch: Partial<BuyAnimeImportRecord>) {
    await this.assertCurrent(record);
    const next = { ...record, ...patch };
    assertImportRecord(next);
    const saved = await this.port.save(next, record.version);
    this.onStage?.(saved.stage);
    return saved;
  }
  /** Fail-closed legacy reconciliation. The old writer was one atomic
   * transaction and Inventory rows are only soft-deleted within a Restore
   * epoch, so a predicted create UUID and its business key both absent at the
   * SAME epoch prove the transaction did not commit. Any other shape (no
   * creates, present key/tombstone, soft-deleted row, surplus target matches,
   * epoch change) stays blocked. Only the journal row changes, through CAS. */
  async retireLegacyNotCommitted(input: BuyAnimeImportRecord): Promise<BuyAnimeImportRecord | null> {
    assertImportRecord(input);
    if (!isUnresolvedLegacyInventoryJournal(input)) throw new BuyAnimeResumeError('BUYANIME_LEGACY_RETIREMENT_NOT_APPLICABLE', input);
    if (!this.port.readLegacyInventoryEvidence) throw new BuyAnimeResumeError('BUYANIME_INVENTORY_RECONCILIATION_UNAVAILABLE', input);
    const generation = await this.port.readRestoreGeneration?.();
    if (!generation || input.restoreEpoch !== generation.epoch) throw new BuyAnimeResumeError('BUYANIME_LEGACY_COMMIT_OUTCOME_UNPROVEN', input);
    await this.assertCurrent(input);
    const evidence = await this.port.readLegacyInventoryEvidence(input);
    const after = await this.port.readRestoreGeneration!();
    assertBuyAnimeGenerationUnchanged(generation, after);
    const expectedIds = new Set(input.expected.map(proof => proof.id));
    const byId = new Map(evidence.rows.map(row => [String(row.id), row]));
    if (byId.size !== evidence.rows.length || evidence.rows.some(row => !expectedIds.has(String(row.id))))
      throw new BuyAnimeResumeError('BUYANIME_INVENTORY_READBACK_IDENTITY_ERROR', input);
    if (evidence.rows.some(row => (row as { deleted_at?: string | null }).deleted_at)) throw new BuyAnimeResumeError('BUYANIME_INVENTORY_SOFT_DELETED_ROW', input);
    const absent = input.expected.filter(proof => !byId.has(proof.id));
    let targetMatches = 0;
    for (let offset = 0; offset < input.expected.length; offset += 150) {
      for (const proof of input.expected.slice(offset, offset + 150)) {
        const row = byId.get(proof.id);
        if (row && stable(await inventoryProof(row)) === stable(proof)) targetMatches++;
      }
      if (offset + 150 < input.expected.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const creates = input.stats.newCount;
    // Fully committed shape (every expected row present at target): the
    // existing proof-based readback path owns it. Return without writing.
    if (absent.length === 0 && targetMatches === input.expected.length) return null;
    if (!Number.isSafeInteger(creates) || creates <= 0 || absent.length !== creates || evidence.keyRows.length !== 0
      || targetMatches > input.stats.unchangedCount)
      throw new BuyAnimeResumeError('BUYANIME_LEGACY_COMMIT_OUTCOME_UNPROVEN', input);
    const retirement: BuyAnimeLegacyRetirement = {
      kind: 'LEGACY_NOT_COMMITTED_VERIFIED', verifiedAt: new Date().toISOString(),
      previousStage: input.stage as BuyAnimeLegacyRetirement['previousStage'], restoreEpoch: generation.epoch,
      expectedRows: input.expected.length, absentPredictedCreates: absent.length,
      presentRows: evidence.rows.length, targetMatches, businessMutation: 0, inventoryReplay: 0,
    };
    console.info('[BuyAnime Recovery] legacy request retired as NOT_COMMITTED', { batchId: input.batchId, ...retirement });
    return this.store(input, { stage: 'FAILED_PRE_COMMIT', retirement });
  }
  async start(items: InventoryItem[], fileName: string): Promise<BuyAnimeImportRecord> {
    const generation = await this.port.readRestoreGeneration?.();
    const batchIds = new Set(items.map(row => row.latest_catalog_import_id));
    const timestamps = new Set(items.map(row => row.catalog_last_seen_at));
    if (batchIds.size !== 1 || timestamps.size !== 1 || !items.length) throw new BuyAnimeResumeError('BUYANIME_BATCH_IDENTITY_INVALID');
    markBuyAnimeTrace('T10_INVENTORY_PLAN_START', { incomingRows: items.length });
    const plan = await this.port.prepareInventory(items);
    if (generation) assertBuyAnimeGenerationUnchanged(generation, (await this.port.readRestoreGeneration!()));
    markBuyAnimeTrace('T11_INVENTORY_PLAN_DONE', {
      incomingRows: items.length, mutationRows: plan.operations.length,
      newRows: plan.stats.newCount, updatedRows: plan.stats.updatedCount, unchangedRows: plan.stats.unchangedCount,
    });
    // Excel parser rows may not yet have inventory_key. Reuse the existing
    // canonical projection/duplicate merge; never invent another key scheme.
    const imported = plan.imported;
    let record: BuyAnimeImportRecord = {
      format: 'BUYANIME_IMPORT_RESUME_V1', batchId: items[0].latest_catalog_import_id!, fileName,
      observedAt: items[0].catalog_last_seen_at!, stage: 'INVENTORY_COMMITTING', version: 0,
      ...(generation ? { restoreEpoch: generation.epoch } : {}),
      expected: await Promise.all(imported.map(inventoryProof)), stats: plan.stats,
      ...(generation && this.port.reconcileInventory ? {
        inventory: inventoryImportIntent(items[0].latest_catalog_import_id!, generation.epoch, plan.operations),
      } : {}),
    };
    assertImportRecord(record);
    // Persist intent only when an Inventory transaction can change rows. A
    // proven no-op has no committed state to recover and reaches one durable
    // COMPLETE write after all downstream evidence is proven.
    if (plan.operations.length > 0) record = await this.port.save(record, 0);
    await this.assertCurrent(record);
    try {
      markBuyAnimeTrace('T12_INVENTORY_COMMIT_START', { mutationRows: plan.operations.length });
      // Always hand the plan to the provider, even when it is a proven no-op.
      // The cloud provider records the exact empty touched-set without sending
      // an RPC, which lets the final targeted refresh prove that no Inventory
      // rows need to be fetched. Skipping the port call loses that evidence and
      // incorrectly turns a successful no-op import into read-back pending.
      await this.port.commitInventory(plan, record);
      markBuyAnimeTrace('T13_INVENTORY_COMMIT_RESPONSE', { mutationRows: plan.operations.length });
    } catch (cause) {
      // An HTTP/error response is not rollback evidence. Receipt-aware imports
      // stay unknown until the read-only server classifier proves the outcome.
      const unknown = Boolean(record.inventory) || classifyMyAcgImportError(cause, 'commit').code === 'COMMIT_RESULT_UNKNOWN';
      const committed = cause instanceof CloudMutationBoundaryError && cause.state === 'committed-readback-pending';
      if (record.version > 0) try {
        record = await this.store(record, { stage: unknown ? 'INVENTORY_COMMIT_UNKNOWN'
          : committed ? 'INVENTORY_READBACK_PENDING' : record.inventory ? 'INVENTORY_NOT_COMMITTED' : 'FAILED_PRE_COMMIT' });
      } catch { /* Durable COMMITTING intent remains. Never bypass offline/CAS protection to save progress. */ }
      throw new BuyAnimeResumeError(unknown ? 'BUYANIME_COMMIT_OUTCOME_UNKNOWN'
        : committed ? 'BUYANIME_COMMITTED_READBACK_PENDING' : 'BUYANIME_COMMIT_FAILED', record, cause);
    }
    // Durable COMMITTING intent already carries exact row proofs. F5 reconciles
    // those proofs before any downstream write, never redispatches Inventory.
    // Intermediate acknowledgement labels need not rewrite the large journal.
    record = { ...record, stage: 'INVENTORY_READBACK_PENDING' };
    try {
      await this.assertCurrent(record);
      const mutatedIds = new Set(plan.operations.map(operation => operation.id));
      const unchangedRows = plan.imported.filter(row => !mutatedIds.has(row.id));
      const changedExpected = record.expected.filter(proof => mutatedIds.has(proof.id));
      markBuyAnimeTrace('T14_INVENTORY_ACK_READ_START', { ids: changedExpected.length, chunks: Math.ceil(changedExpected.length / 150) });
      const changedRows = changedExpected.length
        ? await this.port.readInventory({ ...record, expected: changedExpected })
        : [];
      markBuyAnimeTrace('T15_INVENTORY_ACK_READ_DONE', { ids: changedExpected.length, chunks: Math.ceil(changedExpected.length / 150) });
      const rows = [...unchangedRows, ...changedRows];
      await proveInventoryRows(record, rows);
      const saved = { ...record, stage: 'INVENTORY_VERIFIED' as const };
      // Reuse only the same attempt's proven rows, never an F5 cache. Versions
      // remain dependencies of the subsequent atomic Catalog transaction.
      const importedIds = new Set(rows.map(row => row.id));
      this.verified.set(saved, { rows, inventory: [...plan.inventory.filter(row => !importedIds.has(row.id)), ...rows] });
      return saved;
    } catch (cause) {
      throw new BuyAnimeResumeError('BUYANIME_COMMITTED_READBACK_PENDING', record, cause);
    }
  }
  /** Pure reads. In-memory verification is not durable completion or a write permission. */
  async verify(record: BuyAnimeImportRecord): Promise<InventoryItem[]> {
    await this.assertCurrent(record);
    assertImportRecord(record);
    const rows = await this.port.readInventory(record);
    await proveInventoryRows(record, rows);
    await this.assertCurrent(record);
    return rows;
  }
  async resume(input: BuyAnimeImportRecord): Promise<BuyAnimeImportRecord> {
    await this.assertCurrent(input);
    assertImportRecord(input);
    const proven = this.verified.get(input);
    let record = proven ? input : await this.port.load(input.batchId) ?? input;
    assertImportRecord(record);
    await this.assertCurrent(record);
    if (record.stage === 'COMPLETE') return record;
    const legacyWacaPending = record.stage === 'WACA_EVIDENCE_PENDING';
    // Pre-intent journals NEVER replay. Prove-and-retire, or stay blocked.
    if (!proven && this.port.readLegacyInventoryEvidence && isUnresolvedLegacyInventoryJournal(record)) {
      const retired = await this.retireLegacyNotCommitted(record);
      if (retired) return retired;
    }
    // Legacy journals contain only target hashes: they NEVER authorize a replay.
    // New journals retain exact CAS intent, and require server reconciliation
    // before a NOT_COMMITTED retry. Completed receipts skip dispatch entirely.
    if (['PLANNED', 'FAILED_PRE_COMMIT'].includes(record.stage)) throw new BuyAnimeResumeError('BUYANIME_NOT_COMMITTED', record);
    if (!proven && record.inventory && record.stage.startsWith('INVENTORY_')) {
      if (!this.port.reconcileInventory || !this.port.resumeInventory)
        throw new BuyAnimeResumeError('BUYANIME_INVENTORY_RECONCILIATION_UNAVAILABLE', record);
      let outcome = await this.port.reconcileInventory(record);
      if (outcome === 'UNKNOWN') throw new BuyAnimeResumeError('BUYANIME_COMMIT_OUTCOME_UNKNOWN', record);
      if (outcome === 'NOT_COMMITTED') {
        record = await this.store(record, { stage: 'INVENTORY_COMMITTING' });
        await this.assertCurrent(record);
        try { await this.port.resumeInventory(record); }
        catch (cause) {
          outcome = await this.port.reconcileInventory(record);
          if (outcome !== 'COMMITTED') throw new BuyAnimeResumeError(
            outcome === 'NOT_COMMITTED' ? 'BUYANIME_NOT_COMMITTED' : 'BUYANIME_COMMIT_OUTCOME_UNKNOWN', record, cause);
        }
      }
      await this.assertCurrent(record);
      record = { ...record, stage: 'INVENTORY_READBACK_PENDING' };
    }
    this.verified.delete(input);
    const reusable = proven && record.version === input.version
      && (record.stage === input.stage || (record.stage === 'INVENTORY_COMMITTING' && input.stage === 'INVENTORY_VERIFIED'))
      && stable(record.expected) === stable(input.expected);
    const rows = reusable ? proven.rows : await this.verify(record);
    if (legacyWacaPending) {
      // This historical stage means Catalog previously reached verified, not
      // that WACA committed. Recheck CURRENT Catalog without replaying it.
      // Preserve the old WACA intent as audit evidence; never dispatch it.
      const plan = await this.port.planCatalog(rows, undefined, true);
      if (plan && Object.values(plan.request.operations).some(operations => operations.length > 0))
        throw new BuyAnimeResumeError('BUYANIME_CATALOG_RECOVERY_FIELDS_MISMATCH', record);
      markBuyAnimeTrace('T21_BUYANIME_JOURNAL_FINALIZE_START');
      record = await this.store(record, { stage: 'COMPLETE', catalog: undefined });
      markBuyAnimeTrace('T22_BUYANIME_JOURNAL_FINALIZE_DONE');
      return record;
    }
    if (record.version === 0 && record.legacy) record = await this.port.save(record, 0); // Adopt proven legacy operational evidence without Inventory replay.
    if (['INVENTORY_COMMITTING','INVENTORY_COMMIT_UNKNOWN','INVENTORY_COMMITTED','INVENTORY_READBACK_PENDING','INVENTORY_VERIFIED'].includes(record.stage)) {
      record = { ...record, stage: 'CATALOG_PENDING' };
    }
    let freshCatalogIntent=false;
    if (record.stage === 'CATALOG_PENDING') {
      markBuyAnimeTrace('T16_CATALOG_PLAN_START', { inventoryRows: rows.length });
      const plan = await this.port.planCatalog(rows, reusable ? proven.inventory : undefined);
      markBuyAnimeTrace('T17_CATALOG_PLAN_DONE', {
        catalogOperations: plan ? Object.values(plan.request.operations).reduce((sum, operations) => sum + operations.length, 0) : 0,
      });
      const catalogOperations = plan
        ? Object.values(plan.request.operations).reduce((sum, operations) => sum + operations.length, 0) : 0;
      if (catalogOperations === 0) {
        // A pure plan is the authoritative no-change proof. There is no RPC,
        // read-back or durable crash boundary when no Catalog row can change.
        markBuyAnimeTrace('T18_CATALOG_COMMIT_START', { catalogOperations: 0 });
        markBuyAnimeTrace('T19_CATALOG_COMMIT_RESPONSE', { catalogOperations: 0 });
        markBuyAnimeTrace('T20_CATALOG_READBACK_DONE', { catalogOperations: 0 });
        record = { ...record, stage: 'CATALOG_VERIFIED', catalog: undefined };
      } else {
        // Persist the EXACT request and stable key before RPC; close/relogin cannot regenerate it.
        record = await this.store(record, { stage: 'CATALOG_COMMITTING', catalog: { key: importCatalogKey(record.batchId), plan } });
        freshCatalogIntent=true;
      }
    }
    if (record.stage === 'CATALOG_COMMITTING') {
      await this.assertCurrent(record);
      // F5/recovery first classifies the EXACT saved request. A completed
      // receipt advances to readback without redispatching Catalog operations.
      const reconcile=async():Promise<CatalogCommitOutcome> => {
        if(!this.port.reconcileCatalog) return 'UNKNOWN';
        const started=performance.now();
        let outcome:CatalogCommitOutcome='UNKNOWN';
        try { outcome=await this.port.reconcileCatalog(record.catalog!); }
        catch { /* A failed classification is UNKNOWN, never permission to replay. */ }
        recordBuyAnimeCatalogEvidence('reconcile',{outcome,elapsedMs:performance.now()-started});
        return outcome;
      };
      let outcome:CatalogCommitOutcome=freshCatalogIntent || !this.port.reconcileCatalog ? 'NOT_COMMITTED' : await reconcile();
      if(outcome==='UNKNOWN') throw new BuyAnimeResumeError('BUYANIME_CATALOG_COMMIT_UNKNOWN',record);
      try {
        const catalogOperations = record.catalog?.plan
          ? Object.values(record.catalog.plan.request.operations).reduce((sum, operations) => sum + operations.length, 0) : 0;
        markBuyAnimeTrace('T18_CATALOG_COMMIT_START', { catalogOperations });
        if(outcome!=='COMMITTED') await this.port.commitCatalog(record.catalog!);
        await this.assertCurrent(record);
        markBuyAnimeTrace('T19_CATALOG_COMMIT_RESPONSE', { catalogOperations });
      }
      catch (cause) {
        outcome=await reconcile();
        if(outcome==='COMMITTED') {
          recordBuyAnimeCatalogEvidence('commit-outcome',{outcome:'CATALOG_COMMITTED_RESPONSE_LOST',replay:0});
          markBuyAnimeTrace('T19_CATALOG_COMMIT_RESPONSE',{reconciled:true});
        } else {
        // A proven rollback may replan; an uncertain result MUST retain the exact request.
        if (outcome==='NOT_COMMITTED' || (!this.port.reconcileCatalog && cause instanceof BuyAnimeResumeError && cause.code === 'BUYANIME_CATALOG_ROLLED_BACK'))
          record = await this.store(record, { stage: 'CATALOG_PENDING', catalog: undefined });
        throw new BuyAnimeResumeError('BUYANIME_CATALOG_PENDING', record, cause);
        }
      }
      record = { ...record, stage: 'CATALOG_COMMITTED' };
    }
    if (record.stage === 'CATALOG_COMMITTED') {
      await this.port.verifyCatalog(record.catalog!);
      markBuyAnimeTrace('T20_CATALOG_READBACK_DONE');
      record = { ...record, stage: 'CATALOG_VERIFIED' };
    }
    if (record.stage === 'CATALOG_VERIFIED') {
      // BuyAnime owns Inventory and Catalog. WACA derives catalog evidence on
      // its own route/import; no WACA read, mutation or background task belongs
      // in this success path. Existing journal CAS remains fail-closed.
      markBuyAnimeTrace('T21_BUYANIME_JOURNAL_FINALIZE_START');
      record = await this.store(record, { stage: 'COMPLETE', catalog: undefined });
      markBuyAnimeTrace('T22_BUYANIME_JOURNAL_FINALIZE_DONE');
    }
    return record;
  }
}

export function buyAnimeRecoveryMessage(record: BuyAnimeImportRecord, verified = false): string {
  if (record.stage === 'COMPLETE') return '買動漫主檔及商品／規格同步已完成。WACA 訂單／數量由 WACA 匯入獨立處理。';
  if (record.stage === 'FAILED_PRE_COMMIT' && record.retirement)
    return '舊的匯入已確認沒有寫入任何主檔資料，已保留紀錄並結案；可以正常匯入新檔案。';
  if (record.stage === 'FAILED_PRE_COMMIT') return '主檔沒有提交，本次匯入已停止。請查看錯誤資訊。';
  if (record.stage === 'PLANNED') return '匯入計畫已保存，但尚無主檔提交證據；不會自動重送。';
  if (verified) return '主檔已確認，後續同步尚未完成。可繼續商品／規格同步，請勿重複匯入。';
  if (record.stage === 'INVENTORY_COMMIT_UNKNOWN' || record.stage === 'INVENTORY_COMMITTING')
    return '主檔儲存結果尚待雲端核對，請勿重複匯入。';
  return '主檔已儲存，但雲端核對或後續同步尚未完成；請勿重複匯入。';
}

export function buyAnimeRecoveryUserMessage(error:unknown):string {
  let current=error;
  for(let depth=0;depth<6;depth++) {
    const value=current as {category?:string;code?:string;cause?:unknown}|null;
    if(value?.category==='CATALOG_COMMIT_TIMEOUT_NOT_COMMITTED'
      || value?.code==='BUYANIME_CATALOG_COMMIT_UNKNOWN') return classifyMyAcgImportError(current,'commit').message;
    if(value?.code==='BUYANIME_LEGACY_COMMIT_OUTCOME_UNPROVEN')
      return '舊的匯入紀錄無法自動確認是否已寫入，系統已暫停，不會自動重送。請聯絡管理員核對。';
    if(!value?.cause) break;
    current=value.cause;
  }
  return '匯入尚未完成；系統會在重新整理後核對既有進度，請勿重複選擇同一檔案。';
}

/** Safe codes/stacks only; never raw rows, SQL DETAIL, journal payloads or secrets. */
export function buyAnimeRecoveryDiagnostic(error: unknown, record?: BuyAnimeImportRecord) {
  const stage = record?.stage;
  let cause: unknown = error;
  for (let depth = 0; depth < 6; depth++) {
    const inner = (cause as { cause?: unknown } | null)?.cause;
    if (!inner) break;
    cause = inner;
  }
  const phase = stage === 'PLANNED' ? 'staging'
    : ['INVENTORY_READBACK_PENDING','INVENTORY_VERIFIED','CATALOG_COMMITTED'].includes(stage || '') ? 'readback' : 'commit';
  const diagnostic = myAcgImportDiagnostic(classifyMyAcgImportError(cause, phase), record?.batchId || 'unconfirmed');
  const code = String((error as { code?: unknown } | null)?.code || '');
  return { ...diagnostic, stage,
    reason: /^(?:BUYANIME_|CLOUD_)[A-Z_]+$/u.test(code) ? code : diagnostic.reason,
    rpc: stage?.startsWith('CATALOG') ? 'erp_apply_catalog_transaction'
      : stage === 'WACA_EVIDENCE_PENDING' ? undefined : diagnostic.rpc };
}
