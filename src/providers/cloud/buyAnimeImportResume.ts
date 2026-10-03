import type { InventoryItem, ImportStats } from '../../lib/db';
import type { planCloudInventoryImport } from './inventoryImportPlan';
import type { planCatalogTransaction } from './catalogTransaction';
import { deterministicCloudUuid, toCloudFieldRow } from './cloudEntityPayload';
import { CloudMutationBoundaryError } from './cloudFieldCas';
import { classifyMyAcgImportError, myAcgImportDiagnostic } from '../../utils/myacgImportErrors';

export const BUYANIME_JOURNAL_PLATFORM = 'buyanime-catalog-resume-v1';
export type BuyAnimeStage = 'PLANNED' | 'INVENTORY_COMMITTING' | 'INVENTORY_COMMIT_UNKNOWN'
  | 'INVENTORY_COMMITTED' | 'INVENTORY_READBACK_PENDING' | 'INVENTORY_VERIFIED'
  | 'CATALOG_PENDING' | 'CATALOG_COMMITTING' | 'CATALOG_COMMITTED' | 'CATALOG_VERIFIED'
  | 'WACA_EVIDENCE_PENDING' | 'COMPLETE' | 'FAILED_PRE_COMMIT';
export type CatalogImportPlan = Awaited<ReturnType<typeof planCatalogTransaction>>;
export interface InventoryProof { id: string; key: string; hash: string }
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
      || row.latest_catalog_import_id !== record.batchId
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
      || (r.catalog.plan && (r.catalog.plan.request.family !== 'catalog' || r.catalog.plan.request.mode !== 'sync'))))) {
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
  ensureWacaEvidence(record: BuyAnimeImportRecord, imported: InventoryItem[]): Promise<void>;
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
    const plan = await this.port.prepareInventory(items);
    // Excel parser rows may not yet have inventory_key. Reuse the existing
    // canonical projection/duplicate merge; never invent another key scheme.
    const imported = plan.imported;
    let record: BuyAnimeImportRecord = {
      format: 'BUYANIME_IMPORT_RESUME_V1', batchId: items[0].latest_catalog_import_id!, fileName,
      observedAt: items[0].catalog_last_seen_at!, stage: 'PLANNED', version: 0,
      expected: await Promise.all(imported.map(inventoryProof)), stats: plan.stats,
    };
    assertImportRecord(record);
    // Must persist intent BEFORE sending the single Inventory transaction.
    record = await this.port.save(record, 0);
    record = await this.store(record, { stage: 'INVENTORY_COMMITTING' });
    try {
      await this.port.commitInventory(plan);
    } catch (cause) {
      const unknown = classifyMyAcgImportError(cause, 'commit').code === 'COMMIT_RESULT_UNKNOWN';
      const committed = cause instanceof CloudMutationBoundaryError && cause.state === 'committed-readback-pending';
      try {
        record = await this.store(record, { stage: unknown ? 'INVENTORY_COMMIT_UNKNOWN'
          : committed ? 'INVENTORY_READBACK_PENDING' : 'FAILED_PRE_COMMIT' });
      } catch { /* Durable COMMITTING intent remains. Never bypass offline/CAS protection to save progress. */ }
      throw new BuyAnimeResumeError(unknown ? 'BUYANIME_COMMIT_OUTCOME_UNKNOWN'
        : committed ? 'BUYANIME_COMMITTED_READBACK_PENDING' : 'BUYANIME_COMMIT_FAILED', record, cause);
    }
    try {
      // Persist recoverable progress before reading, while the commit is known
      // successful. A later transport outage must not require a journal write.
      record = await this.store(record, { stage: 'INVENTORY_READBACK_PENDING' });
    } catch (cause) { throw new BuyAnimeResumeError('BUYANIME_COMMITTED_READBACK_PENDING', record, cause); }
    try {
      const rows = await this.verify(record);
      const saved = await this.store(record, { stage: 'INVENTORY_VERIFIED' });
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
    let record = await this.port.load(input.batchId) ?? input;
    assertImportRecord(record);
    if (record.stage === 'COMPLETE') return record;
    // No code path in resume calls prepareInventory or commitInventory.
    if (['PLANNED', 'FAILED_PRE_COMMIT'].includes(record.stage)) throw new BuyAnimeResumeError('BUYANIME_NOT_COMMITTED', record);
    const proven = this.verified.get(input);
    this.verified.delete(input);
    const reusable = proven && record.version === input.version && record.stage === input.stage
      && stable(record.expected) === stable(input.expected);
    const rows = reusable ? proven.rows : await this.verify(record);
    if (record.version === 0) record = await this.port.save(record, 0); // Adopt proven legacy operational evidence without Inventory replay.
    if (['INVENTORY_COMMITTING','INVENTORY_COMMIT_UNKNOWN','INVENTORY_COMMITTED','INVENTORY_READBACK_PENDING','INVENTORY_VERIFIED'].includes(record.stage)) {
      record = await this.store(record, { stage: 'CATALOG_PENDING' });
    }
    if (record.stage === 'CATALOG_PENDING') {
      const plan = await this.port.planCatalog(rows, reusable ? proven.inventory : undefined);
      // Persist the EXACT request and stable key before RPC; close/relogin cannot regenerate it.
      record = await this.store(record, { stage: 'CATALOG_COMMITTING', catalog: { key: importCatalogKey(record.batchId), plan } });
    }
    if (record.stage === 'CATALOG_COMMITTING') {
      try { await this.port.commitCatalog(record.catalog!); }
      catch (cause) {
        // A proven rollback may replan; an uncertain result MUST retain the exact request.
        if (cause instanceof BuyAnimeResumeError && cause.code === 'BUYANIME_CATALOG_ROLLED_BACK')
          record = await this.store(record, { stage: 'CATALOG_PENDING', catalog: undefined });
        throw new BuyAnimeResumeError('BUYANIME_CATALOG_PENDING', record, cause);
      }
      record = await this.store(record, { stage: 'CATALOG_COMMITTED' });
    }
    if (record.stage === 'CATALOG_COMMITTED') {
      await this.port.verifyCatalog(record.catalog!);
      record = await this.store(record, { stage: 'CATALOG_VERIFIED' });
    }
    if (record.stage === 'CATALOG_VERIFIED') record = await this.store(record, { stage: 'WACA_EVIDENCE_PENDING' });
    if (record.stage === 'WACA_EVIDENCE_PENDING') {
      await this.port.ensureWacaEvidence(record, rows);
      record = await this.store(record, { stage: 'COMPLETE' });
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
      : stage === 'WACA_EVIDENCE_PENDING' ? 'erp_commit_waca_snapshot' : diagnostic.rpc };
}
