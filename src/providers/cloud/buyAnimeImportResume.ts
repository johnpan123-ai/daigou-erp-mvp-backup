import type { InventoryItem, ImportStats } from '../../lib/db';
import type { planCloudInventoryImport } from './inventoryImportPlan';
import type { planCatalogTransaction } from './catalogTransaction';
import { deterministicCloudUuid, toCloudFieldRow } from './cloudEntityPayload';
import { CloudMutationBoundaryError } from './cloudFieldCas';
import { classifyMyAcgImportError, myAcgImportDiagnostic } from '../../utils/myacgImportErrors';
import { markBuyAnimeTrace } from '../../diagnostics/buyAnimeProductionTrace';
import type { MyAcgMasterLink } from '../../waca/masterReference';

export const BUYANIME_JOURNAL_PLATFORM = 'buyanime-catalog-resume-v1';
export type BuyAnimeStage = 'PLANNED' | 'INVENTORY_COMMITTING' | 'INVENTORY_COMMIT_UNKNOWN'
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
  stage: BuyAnimeStage;
  version: number;
  expected: InventoryProof[];
  stats: ImportStats;
  catalog?: { key: string; plan: CatalogImportPlan | null };
  waca?: WacaMasterLinkDeltaPlan;
  legacy?: boolean;
}
export class BuyAnimeResumeError extends Error {
  readonly code: string;
  readonly record?: BuyAnimeImportRecord;
  constructor(code: string, record?: BuyAnimeImportRecord, cause?: unknown) {
    super(code, { cause }); this.code = code; this.record = record; this.name = 'BuyAnimeResumeError';
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
const STAGES = new Set<BuyAnimeStage>(['PLANNED','INVENTORY_COMMITTING','INVENTORY_COMMIT_UNKNOWN',
  'INVENTORY_COMMITTED','INVENTORY_READBACK_PENDING','INVENTORY_VERIFIED','CATALOG_PENDING',
  'CATALOG_COMMITTING','CATALOG_COMMITTED','CATALOG_VERIFIED','WACA_EVIDENCE_PENDING','COMPLETE','FAILED_PRE_COMMIT']);
export function assertImportRecord(value: unknown): asserts value is BuyAnimeImportRecord {
  const r = value as BuyAnimeImportRecord | null;
  if (!r || r.format !== 'BUYANIME_IMPORT_RESUME_V1' || !/^catalog_import_[0-9a-f-]{36}$/iu.test(r.batchId)
    || !STAGES.has(r.stage) || !Number.isSafeInteger(r.version) || r.version < 0
    || typeof r.fileName !== 'string' || !Number.isFinite(Date.parse(r.observedAt))
    || !Array.isArray(r.expected) || r.expected.length === 0 || !r.stats
    || new Set(r.expected.map(p => p.id)).size !== r.expected.length
    || new Set(r.expected.map(p => p.key)).size !== r.expected.length
    || r.expected.some(p => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(p.id)
      || !p.key || !/^[0-9a-f]{64}$/u.test(p.hash))
    || (['CATALOG_COMMITTING','CATALOG_COMMITTED'].includes(r.stage) && !r.catalog)
    || (r.catalog && (r.catalog.key !== importCatalogKey(r.batchId)
      || (r.catalog.plan && (r.catalog.plan.request.family !== 'catalog' || r.catalog.plan.request.mode !== 'sync'))))
    || (r.stage === 'WACA_EVIDENCE_PENDING' && !r.waca)
    || (r.waca && (r.waca.key !== importWacaDeltaKey(r.batchId)
      || !Number.isSafeInteger(r.waca.expectedRevision) || r.waca.expectedRevision < 0
      || !Array.isArray(r.waca.links) || r.waca.links.some(link => !link.childCode || !link.mainCode)))) {
    throw new BuyAnimeResumeError('BUYANIME_JOURNAL_INVALID');
  }
}
export interface BuyAnimeImportPort {
  load(batchId: string): Promise<BuyAnimeImportRecord | null>;
  save(record: BuyAnimeImportRecord, expectedVersion: number): Promise<BuyAnimeImportRecord>;
  readInventory(record: BuyAnimeImportRecord): Promise<InventoryItem[]>;
  prepareInventory(items: InventoryItem[]): Promise<ReturnType<typeof planCloudInventoryImport>>;
  commitInventory(plan: ReturnType<typeof planCloudInventoryImport>): Promise<void>;
  planCatalog(imported: InventoryItem[], inventory?: InventoryItem[]): Promise<CatalogImportPlan | null>;
  commitCatalog(catalog: NonNullable<BuyAnimeImportRecord['catalog']>): Promise<void>;
  verifyCatalog(catalog: NonNullable<BuyAnimeImportRecord['catalog']>): Promise<void>;
  planWacaEvidence(record: BuyAnimeImportRecord, imported: InventoryItem[]): Promise<WacaMasterLinkDeltaPlan>;
  commitWacaEvidence(plan: WacaMasterLinkDeltaPlan): Promise<void>;
}

/** Durable progress lives in the existing import_batches.details JSON. No memory/session authority. */
export class BuyAnimeImportPipeline {
  private readonly port: BuyAnimeImportPort;
  private readonly verified = new WeakMap<BuyAnimeImportRecord, { rows: InventoryItem[]; inventory: InventoryItem[] }>();
  onStage?: (stage: BuyAnimeStage) => void;
  constructor(port: BuyAnimeImportPort) { this.port = port; }
  private async store(record: BuyAnimeImportRecord, patch: Partial<BuyAnimeImportRecord>) {
    const next = { ...record, ...patch };
    assertImportRecord(next);
    const saved = await this.port.save(next, record.version);
    this.onStage?.(saved.stage);
    return saved;
  }
  async start(items: InventoryItem[], fileName: string): Promise<BuyAnimeImportRecord> {
    const batchIds = new Set(items.map(row => row.latest_catalog_import_id));
    const timestamps = new Set(items.map(row => row.catalog_last_seen_at));
    if (batchIds.size !== 1 || timestamps.size !== 1 || !items.length) throw new BuyAnimeResumeError('BUYANIME_BATCH_IDENTITY_INVALID');
    markBuyAnimeTrace('T10_INVENTORY_PLAN_START', { incomingRows: items.length });
    const plan = await this.port.prepareInventory(items);
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
      expected: await Promise.all(imported.map(inventoryProof)), stats: plan.stats,
    };
    assertImportRecord(record);
    // Persist intent only when an Inventory transaction can change rows. A
    // proven no-op has no committed state to recover and reaches one durable
    // COMPLETE write after all downstream evidence is proven.
    if (plan.operations.length > 0) record = await this.port.save(record, 0);
    try {
      markBuyAnimeTrace('T12_INVENTORY_COMMIT_START', { mutationRows: plan.operations.length });
      // Always hand the plan to the provider, even when it is a proven no-op.
      // The cloud provider records the exact empty touched-set without sending
      // an RPC, which lets the final targeted refresh prove that no Inventory
      // rows need to be fetched. Skipping the port call loses that evidence and
      // incorrectly turns a successful no-op import into read-back pending.
      await this.port.commitInventory(plan);
      markBuyAnimeTrace('T13_INVENTORY_COMMIT_RESPONSE', { mutationRows: plan.operations.length });
    } catch (cause) {
      const unknown = classifyMyAcgImportError(cause, 'commit').code === 'COMMIT_RESULT_UNKNOWN';
      const committed = cause instanceof CloudMutationBoundaryError && cause.state === 'committed-readback-pending';
      if (record.version > 0) try {
        record = await this.store(record, { stage: unknown ? 'INVENTORY_COMMIT_UNKNOWN'
          : committed ? 'INVENTORY_READBACK_PENDING' : 'FAILED_PRE_COMMIT' });
      } catch { /* Durable COMMITTING intent remains. Never bypass offline/CAS protection to save progress. */ }
      throw new BuyAnimeResumeError(unknown ? 'BUYANIME_COMMIT_OUTCOME_UNKNOWN'
        : committed ? 'BUYANIME_COMMITTED_READBACK_PENDING' : 'BUYANIME_COMMIT_FAILED', record, cause);
    }
    // Durable COMMITTING intent already carries exact row proofs. F5 reconciles
    // those proofs before any downstream write, never redispatches Inventory.
    // Intermediate acknowledgement labels need not rewrite the large journal.
    record = { ...record, stage: 'INVENTORY_READBACK_PENDING' };
    try {
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
    assertImportRecord(record);
    const rows = await this.port.readInventory(record);
    await proveInventoryRows(record, rows);
    return rows;
  }
  async resume(input: BuyAnimeImportRecord): Promise<BuyAnimeImportRecord> {
    assertImportRecord(input);
    const proven = this.verified.get(input);
    let record = proven ? input : await this.port.load(input.batchId) ?? input;
    assertImportRecord(record);
    if (record.stage === 'COMPLETE') return record;
    const resumedWacaIntent = record.stage === 'WACA_EVIDENCE_PENDING';
    // No code path in resume calls prepareInventory or commitInventory.
    if (['PLANNED', 'FAILED_PRE_COMMIT'].includes(record.stage)) throw new BuyAnimeResumeError('BUYANIME_NOT_COMMITTED', record);
    this.verified.delete(input);
    const reusable = proven && record.version === input.version
      && (record.stage === input.stage || (record.stage === 'INVENTORY_COMMITTING' && input.stage === 'INVENTORY_VERIFIED'))
      && stable(record.expected) === stable(input.expected);
    const rows = reusable ? proven.rows : await this.verify(record);
    if (record.version === 0 && record.legacy) record = await this.port.save(record, 0); // Adopt proven legacy operational evidence without Inventory replay.
    if (['INVENTORY_COMMITTING','INVENTORY_COMMIT_UNKNOWN','INVENTORY_COMMITTED','INVENTORY_READBACK_PENDING','INVENTORY_VERIFIED'].includes(record.stage)) {
      record = { ...record, stage: 'CATALOG_PENDING' };
    }
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
      }
    }
    if (record.stage === 'CATALOG_COMMITTING') {
      try {
        const catalogOperations = record.catalog?.plan
          ? Object.values(record.catalog.plan.request.operations).reduce((sum, operations) => sum + operations.length, 0) : 0;
        markBuyAnimeTrace('T18_CATALOG_COMMIT_START', { catalogOperations });
        await this.port.commitCatalog(record.catalog!);
        markBuyAnimeTrace('T19_CATALOG_COMMIT_RESPONSE', { catalogOperations });
      }
      catch (cause) {
        // A proven rollback may replan; an uncertain result MUST retain the exact request.
        if (cause instanceof BuyAnimeResumeError && cause.code === 'BUYANIME_CATALOG_ROLLED_BACK')
          record = await this.store(record, { stage: 'CATALOG_PENDING', catalog: undefined });
        throw new BuyAnimeResumeError('BUYANIME_CATALOG_PENDING', record, cause);
      }
      record = { ...record, stage: 'CATALOG_COMMITTED' };
    }
    if (record.stage === 'CATALOG_COMMITTED') {
      await this.port.verifyCatalog(record.catalog!);
      markBuyAnimeTrace('T20_CATALOG_READBACK_DONE');
      record = { ...record, stage: 'CATALOG_VERIFIED' };
    }
    if (record.stage === 'CATALOG_VERIFIED') {
      markBuyAnimeTrace('T21_WACA_EVIDENCE_START', { inventoryRows: rows.length });
      const waca = await this.port.planWacaEvidence(record, rows);
      if (waca.links.length === 0) {
        markBuyAnimeTrace('T22_WACA_EVIDENCE_DONE', { inventoryRows: rows.length, deltaRows: 0 });
        // No Inventory/Catalog/WACA mutation needs intermediate cloud states.
        // One COMPLETE insert/update is the entire no-op journal roundtrip.
        record = await this.store(record, { stage: 'COMPLETE', catalog: undefined, waca: undefined });
      } else {
        // Exact delta + idempotency key are durable before the mutation. F5
        // replays this same request and never regenerates a broader snapshot.
        record = await this.store(record, { stage: 'WACA_EVIDENCE_PENDING', catalog: undefined, waca });
      }
    }
    if (record.stage === 'WACA_EVIDENCE_PENDING') {
      // WACA evidence is part of the user-visible success contract. Keep the
      // durable intent, but never display success before this finishes.
      if (!record.waca) throw new BuyAnimeResumeError('BUYANIME_WACA_INTENT_MISSING', record);
      let waca = record.waca;
      if (resumedWacaIntent) {
        // Reconcile a durable pending intent against current authoritative
        // evidence before replay. This closes response-loss safely and also
        // lets older journals discard provenance-only bulk updates without
        // resending Inventory or Catalog.
        const reconciled = await this.port.planWacaEvidence(record, rows);
        if (reconciled.key !== waca.key)
          throw new BuyAnimeResumeError('BUYANIME_WACA_INTENT_CONFLICT', record);
        if (reconciled.links.length === 0) {
          markBuyAnimeTrace('T22_WACA_EVIDENCE_DONE', { inventoryRows: rows.length, deltaRows: 0 });
          return this.store(record, { stage: 'COMPLETE', waca: undefined });
        }
        if (stable(reconciled) !== stable(waca)) {
          record = await this.store(record, { stage: 'WACA_EVIDENCE_PENDING', waca: reconciled });
          waca = reconciled;
        }
      }
      await this.port.commitWacaEvidence(waca);
      markBuyAnimeTrace('T22_WACA_EVIDENCE_DONE', { inventoryRows: rows.length, deltaRows: waca.links.length });
      record = await this.store(record, { stage: 'COMPLETE', waca: undefined });
    }
    return record;
  }
}

export function buyAnimeRecoveryMessage(record: BuyAnimeImportRecord, verified = false): string {
  if (record.stage === 'COMPLETE') return '買動漫主檔、商品／規格及 WACA 來源同步已完成。';
  if (record.stage === 'FAILED_PRE_COMMIT') return '主檔沒有提交，本次匯入已停止。請查看錯誤資訊。';
  if (record.stage === 'PLANNED') return '匯入計畫已保存，但尚無主檔提交證據；不會自動重送。';
  if (verified) return '主檔已確認，後續同步尚未完成。可繼續商品／規格同步，請勿重複匯入。';
  if (record.stage === 'INVENTORY_COMMIT_UNKNOWN' || record.stage === 'INVENTORY_COMMITTING')
    return '主檔儲存結果尚待雲端核對，請勿重複匯入。';
  return '主檔已儲存，但雲端核對或後續同步尚未完成；請勿重複匯入。';
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
      : stage === 'WACA_EVIDENCE_PENDING' ? 'erp_merge_waca_master_links' : diagnostic.rpc };
}
