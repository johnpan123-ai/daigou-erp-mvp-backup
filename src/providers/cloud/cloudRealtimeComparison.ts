import { cloudFieldValuesEqual } from './cloudFieldCas';

type RecordValue = Record<string, unknown>;
const metadata = new Set(['database_id', 'local_id', 'updated_at', 'updated_by', 'version', 'sync_status']);

/** Compare mapped cache rows, never actor identity. Deletion remains business-visible. */
export function cloudBusinessRowsEqual(before: RecordValue | undefined, after: RecordValue | undefined): boolean {
  if (!before || !after) return before === after;
  const project = (row: RecordValue) => Object.fromEntries(
    Object.entries(row).filter(([key, value]) => !metadata.has(key) && value !== undefined),
  );
  return cloudFieldValuesEqual(project(before), project(after));
}
