import { supabase } from './supabaseClient';
import {
  assertImportRecord, BUYANIME_JOURNAL_PLATFORM, BuyAnimeResumeError, importJournalId,
  type BuyAnimeImportRecord,
} from './buyAnimeImportResume';

/** Optional operational subtype in the EXISTING import_batches/details contract.
 * Legacy business import rows and Backup/Restore serialization remain untouched.
 */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};
const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), character => character.charCodeAt(0));

async function compressRecord(record: BuyAnimeImportRecord): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const source = new Blob([JSON.stringify(record)]).stream();
  const buffer = await new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}

async function decompressRecord(value: string): Promise<unknown> {
  if (typeof DecompressionStream === 'undefined') throw new BuyAnimeResumeError('BUYANIME_JOURNAL_DECOMPRESSION_UNAVAILABLE');
  const bytes = base64ToBytes(value);
  const source = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]).stream();
  const text = await new Response(source.pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

const fromRow = async (row: Record<string, unknown>): Promise<BuyAnimeImportRecord> => {
  const details = row.details as { buyAnimeImport?: unknown; buyAnimeImportGzip?: unknown } | null;
  const recordValue = typeof details?.buyAnimeImportGzip === 'string'
    ? await decompressRecord(details.buyAnimeImportGzip)
    : details?.buyAnimeImport;
  assertImportRecord(recordValue);
  const record = recordValue;
  const header = details?.buyAnimeImport as Partial<BuyAnimeImportRecord> | undefined;
  if (typeof details?.buyAnimeImportGzip === 'string'
    && (header?.format !== record.format || header.batchId !== record.batchId
      || header.stage !== record.stage || header.version !== record.version || header.restoreEpoch !== record.restoreEpoch)) {
    throw new BuyAnimeResumeError('BUYANIME_JOURNAL_HEADER_MISMATCH');
  }
  if (row.id !== importJournalId(record.batchId) || row.platform !== BUYANIME_JOURNAL_PLATFORM
    || Number(row.version) !== record.version || row.deleted_at
    || row.file_name !== record.fileName || Number(row.total_rows) !== record.expected.length)
    throw new BuyAnimeResumeError('BUYANIME_JOURNAL_IDENTITY_MISMATCH');
  return record;
};
export async function readBuyAnimeJournal(batchId: string): Promise<BuyAnimeImportRecord | null> {
  const result = await supabase.from('import_batches').select('*').eq('id', importJournalId(batchId)).maybeSingle();
  if (result.error) throw result.error;
  return result.data ? fromRow(result.data) : null;
}
export async function readPendingBuyAnimeJournal(): Promise<BuyAnimeImportRecord | null> {
  const result = await supabase.from('import_batches').select('*').eq('platform', BUYANIME_JOURNAL_PLATFORM)
    .is('deleted_at', null).not('details->buyAnimeImport->>stage', 'in', '(COMPLETE,FAILED_PRE_COMMIT,PLANNED)')
    .order('imported_at', { ascending: false }).limit(1);
  if (result.error) throw result.error;
  return result.data?.length ? fromRow(result.data[0]) : null;
}
export async function readLatestBuyAnimeJournal(): Promise<BuyAnimeImportRecord | null> {
  const result = await supabase.from('import_batches').select('*').eq('platform', BUYANIME_JOURNAL_PLATFORM)
    .is('deleted_at', null).order('imported_at', { ascending: false }).limit(1);
  if (result.error) throw result.error;
  return result.data?.length ? fromRow(result.data[0]) : null;
}
export async function saveBuyAnimeJournal(record: BuyAnimeImportRecord, expectedVersion: number): Promise<BuyAnimeImportRecord> {
  assertImportRecord(record);
  if (record.version !== expectedVersion) throw new BuyAnimeResumeError('BUYANIME_JOURNAL_VERSION_MISMATCH');
  const next = { ...record, version: expectedVersion + 1 };
  // Keep the established ImportBatch detail arrays valid for existing consumers.
  // Large exact Catalog requests are compressed inside the same JSONB field;
  // the small header preserves the existing pending-stage query and diagnostics.
  const compressed = await compressRecord(next);
  const details = { newOrderItems: [], skippedDuplicateItems: [], createdGroups: [],
    completedGroupSkus: [], catalogMissingSkus: [],
    buyAnimeImport: compressed
      ? { format: next.format, batchId: next.batchId, stage: next.stage, version: next.version,
        ...(next.restoreEpoch !== undefined ? { restoreEpoch: next.restoreEpoch } : {}) }
      : next,
    ...(compressed ? { buyAnimeImportGzip: compressed } : {}),
  };
  const values = { version: next.version, details, updated_at: new Date().toISOString() };
  const result = expectedVersion === 0
    ? await supabase.from('import_batches').insert({
      ...values, id: importJournalId(record.batchId), local_id: importJournalId(record.batchId),
      platform: BUYANIME_JOURNAL_PLATFORM, file_name: record.fileName, imported_at: record.observedAt,
      total_rows: record.expected.length, valid_rows: record.expected.length,
    }).select('*')
    : await supabase.from('import_batches').update(values).eq('id', importJournalId(record.batchId))
      .eq('platform', BUYANIME_JOURNAL_PLATFORM).eq('version', expectedVersion).is('deleted_at', null).select('*');
  if (result.error) throw result.error;
  if (result.data?.length !== 1) throw new BuyAnimeResumeError('BUYANIME_JOURNAL_CAS_CONFLICT');
  return fromRow(result.data[0]);
}
