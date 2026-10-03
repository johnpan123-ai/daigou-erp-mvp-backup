import { supabase } from './supabaseClient';
import {
  assertImportRecord, BUYANIME_JOURNAL_PLATFORM, BuyAnimeResumeError, importJournalId,
  type BuyAnimeImportRecord,
} from './buyAnimeImportResume';

/** Optional operational subtype in the EXISTING import_batches/details contract.
 * Legacy business import rows and Backup/Restore serialization remain untouched.
 */
const fromRow = (row: Record<string, unknown>): BuyAnimeImportRecord => {
  const details = row.details as { buyAnimeImport?: unknown } | null;
  assertImportRecord(details?.buyAnimeImport);
  const record = details.buyAnimeImport;
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
export async function saveBuyAnimeJournal(record: BuyAnimeImportRecord, expectedVersion: number): Promise<BuyAnimeImportRecord> {
  assertImportRecord(record);
  if (record.version !== expectedVersion) throw new BuyAnimeResumeError('BUYANIME_JOURNAL_VERSION_MISMATCH');
  const next = { ...record, version: expectedVersion + 1 };
  // Keep the established ImportBatch detail arrays valid for existing consumers.
  const details = { newOrderItems: [], skippedDuplicateItems: [], createdGroups: [],
    completedGroupSkus: [], catalogMissingSkus: [], buyAnimeImport: next };
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
