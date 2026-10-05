import type { ProductVariant } from '../lib/db';
import type { NextWacaSnapshot } from './nextStorage';
import { reconcileWacaReadback } from './reconciliation';
import type { WacaStage } from './importErrors';

// Compare wire values, not object insertion order (Postgres JSONB reorders keys).
const canonical = (value: unknown): string => JSON.stringify(value, (key, item: unknown) =>
  // erp_read_waca_snapshot projects a SQL NULL variant FK as an empty string.
  // Both mean explicitly unmatched; never normalize a non-empty identity.
  key === 'productVariantId' && (item === null || item === '') ? null
    : item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function changed<T>(before: readonly T[], after: readonly T[], key: (row: T) => string): T[] {
  const previous = new Map(before.map(row => [key(row), canonical(row)]));
  const next = new Map(after.map(row => [key(row), row]));
  if (next.size !== after.length || previous.size !== before.length) throw new Error('WACA_DUPLICATE_IDENTITY');
  // The existing Cloud RPC is UPSERT-only. Never silently discard a removal.
  if ([...previous.keys()].some(id => !next.has(id))) throw new Error('WACA_DELTA_REMOVAL_UNSUPPORTED');
  return after.filter(row => previous.get(key(row)) !== canonical(row));
}

/** Same existing RPC / fields / CAS. Omitted rows remain durable; SQL still
 * recomputes quantities from ALL stored orders inside the one transaction.
 * NEXT is a whole-snapshot IndexedDB writer and must NOT receive this delta. */
export function wacaAtomicDelta(before: NextWacaSnapshot, after: NextWacaSnapshot): NextWacaSnapshot {
  return { ...after,
    orders: changed(before.orders, after.orders, row => row.key),
    items: changed(before.items, after.items, row => row.key),
    mappings: changed(before.mappings, after.mappings, row => row.feature),
    masterLinks: changed(before.masterLinks, after.masterLinks, row => row.childCode),
    batches: changed(before.batches, after.batches, row => row.id),
    cutoverAudit: changed(before.cutoverAudit ?? [], after.cutoverAudit ?? [], row => row.productVariantId),
  };
}

export interface WacaConfirmProvider {
  getNextWacaSnapshot(): Promise<NextWacaSnapshot>;
  getAuthoritativeWacaVariants(): Promise<ProductVariant[]>;
  commitNextWacaSnapshot(snapshot: NextWacaSnapshot, revision: number, updateQuantity: boolean): Promise<unknown>;
}

function assertState(saved: NextWacaSnapshot, expected: NextWacaSnapshot, revision: number) {
  if (saved.revision !== revision + 1) throw new Error('WACA_READBACK_REVISION_CHANGED');
  const compare = <T,>(wanted: T[], actual: T[], key: (row: T) => string) => {
    const found = new Map(actual.map(row => [key(row), canonical(row)]));
    if (found.size !== actual.length || wanted.some(row => found.get(key(row)) !== canonical(row))) {
      throw new Error('WACA_READBACK_CONTENT_MISMATCH');
    }
  };
  compare(expected.orders, saved.orders, row => row.key);
  compare(expected.items, saved.items, row => row.key);
  compare(expected.mappings, saved.mappings, row => row.feature);
  compare(expected.masterLinks, saved.masterLinks, row => row.childCode);
}

function assertReceipt(saved: NextWacaSnapshot, expected: NextWacaSnapshot, requestId: string, revision: number) {
  assertState(saved, expected, revision);
  const actualBatch = saved.batches.find(row => row.id === requestId);
  const wantedBatch = expected.batches.find(row => row.id === requestId);
  if (!actualBatch || !wantedBatch) throw new Error('WACA_COMMIT_RECEIPT_MISSING');
  // Reconciliation is server-generated; everything else is the exact request receipt.
  if (canonical({ ...actualBatch, reconciliation: undefined }) !== canonical({ ...wantedBatch, reconciliation: undefined })) {
    throw new Error('WACA_COMMIT_RECEIPT_MISMATCH');
  }
}

/** No Backup capability is accepted here. An ambiguous response is reconciled
 * by the same durable request identity; this operation never replays a write. */
export async function commitAndVerifyWaca(options: {
  provider: WacaConfirmProvider; current: NextWacaSnapshot; candidate: NextWacaSnapshot;
  requestId: string; cloud: boolean; onStage: (stage: WacaStage) => void;
}) {
  const { provider, current, candidate, requestId, cloud, onStage } = options;
  const payload = cloud ? wacaAtomicDelta(current, candidate) : candidate;
  onStage('commit');
  let saved: NextWacaSnapshot | undefined;
  try {
    await provider.commitNextWacaSnapshot(payload, current.revision, true);
  } catch (error) {
    // Includes response loss and HTTP ambiguity. Absence of a receipt is NOT
    // proof that a still-running request rolled back. Preserve UNKNOWN, no retry.
    try {
      saved = await provider.getNextWacaSnapshot();
      assertReceipt(saved, candidate, requestId, current.revision);
    } catch { throw error; }
  }
  onStage('readback');
  const [snapshot, variants] = await Promise.all([
    saved ? Promise.resolve(saved) : provider.getNextWacaSnapshot(),
    provider.getAuthoritativeWacaVariants(),
  ]);
  assertReceipt(snapshot, candidate, requestId, current.revision);
  const checked = reconcileWacaReadback(snapshot, variants);
  if (checked.issues.some(issue => issue.reason !== 'UNMATCHED_SOURCE')) throw new Error('WACA_READBACK_QUANTITY_MISMATCH');
  const batch = snapshot.batches.find(row => row.id === requestId)!;
  if (cloud && batch.reconciliation?.status !== checked.status) throw new Error('WACA_READBACK_AUDIT_MISMATCH');
  return { snapshot, variants, checked };
}

/** Atomic master-link refresh + historical rematch. There is no import batch:
 * CAS revision and exact read-back are the receipt, including response loss. */
export async function commitAndVerifyWacaRematch(options: {
  provider: WacaConfirmProvider;
  current: NextWacaSnapshot;
  candidate: NextWacaSnapshot;
  cloud: boolean;
}) {
  const { provider, current, candidate, cloud } = options;
  const payload = cloud ? wacaAtomicDelta(current, candidate) : candidate;
  let saved: NextWacaSnapshot | undefined;
  try {
    await provider.commitNextWacaSnapshot(payload, current.revision, true);
  } catch (error) {
    try {
      saved = await provider.getNextWacaSnapshot();
      assertState(saved, candidate, current.revision);
    } catch { throw error; }
  }
  const [snapshot, variants] = await Promise.all([
    saved ? Promise.resolve(saved) : provider.getNextWacaSnapshot(),
    provider.getAuthoritativeWacaVariants(),
  ]);
  assertState(snapshot, candidate, current.revision);
  const checked = reconcileWacaReadback(snapshot, variants);
  if (checked.issues.some(issue => issue.reason !== 'UNMATCHED_SOURCE')) {
    throw new Error('WACA_READBACK_QUANTITY_MISMATCH');
  }
  return { snapshot, variants, checked };
}
