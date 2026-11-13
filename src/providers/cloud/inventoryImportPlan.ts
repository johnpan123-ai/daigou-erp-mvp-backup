import { normalizeProductTitle, prepareInventoryUpsert, type InventoryItem } from '../../lib/db';
import { canonicalCloudId, toCloudFieldRow } from './cloudEntityPayload';
import { buildCloudCollectionMutationPlan } from './cloudFieldCas';
import { markBuyAnimeTrace } from '../../diagnostics/buyAnimeProductionTrace';

type AuthoritativeInventory = InventoryItem & { deleted_at?: string | null };

/** Pre-write validation failure: nothing was saved or dispatched. */
const preflightError = (code: string, details: string[]) =>
  Object.assign(new Error(code), { name: 'BuyAnimeImportPreflightError', preflight: true as const, details });

/**
 * Bind the existing import projection to server identities before planning CAS.
 * A parsed external code/UUID never replaces an existing inventory_key's UUID.
 * Tombstones retain their unique key under the adopted SQL contract; there is
 * no implicit revive or same-key UUID replacement operation in this import.
 */
export function planCloudInventoryImport(
  authoritative: AuthoritativeInventory[], incoming: InventoryItem[],
) {
  markBuyAnimeTrace('T08_INDEX_BUILD_START', { authoritativeRows: authoritative.length, incomingRows: incoming.length });
  const byKey = new Map<string, AuthoritativeInventory>();
  for (const row of authoritative) {
    if (!row.inventory_key || byKey.has(row.inventory_key)) {
      throw new Error('CLOUD_INVENTORY_AUTHORITATIVE_KEY_INVALID');
    }
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(row.database_id || row.id || '')) {
      throw new Error('CLOUD_INVENTORY_AUTHORITATIVE_UUID_INVALID');
    }
    byKey.set(row.inventory_key, row);
  }
  const active = authoritative.filter(row => !row.deleted_at);
  const projection = prepareInventoryUpsert(active, incoming);
  const renames = detectVariantRenames(authoritative, active, projection.inventory, byKey);
  // BuyAnime import is create/patch only. The shared projection replaces a whole
  // family (same parent code/title); active rows it dropped whose key is absent
  // from this file are retained exactly as stored: no delete, no field change.
  const projectedKeys = new Set(projection.inventory.map(row => row.inventory_key));
  // A renamed row's previous key is not retained: the same row (same UUID) carries the new key.
  const renamedFrom = new Set([...renames.values()].map(row => row.inventory_key));
  const retained = active.filter(row => !projectedKeys.has(row.inventory_key) && !renamedFrom.has(row.inventory_key));
  const projected = projection.inventory.map(row => {
    const renamed = renames.get(row.inventory_key!);
    if (renamed) {
      // Same SKU, variant label corrected on BuyAnime: patch the existing row in place (same UUID, CAS on
      // its current version). The server refuses the key if any row, tombstones included, holds it.
      const id = canonicalCloudId('inventory_items', renamed as unknown as Record<string, unknown>);
      return { ...row, id, database_id: id, version: renamed.version, updated_at: renamed.updated_at };
    }
    const existing = byKey.get(row.inventory_key!);
    if (existing?.deleted_at) throw new Error('CLOUD_INVENTORY_KEY_SOFT_DELETED');
    if (existing) {
      const id = canonicalCloudId('inventory_items', existing as unknown as Record<string, unknown>);
      const before = toCloudFieldRow('inventory_items', existing);
      const after = toCloudFieldRow('inventory_items', row);
      // A new attempt/timestamp alone is not a business change. Preserve the
      // prior receipt on true no-ops instead of rewriting every uploaded row.
      const ignored = new Set(['id', 'version', 'latest_catalog_import_id', 'catalog_last_seen_at']);
      if (Object.keys(after).every(key => ignored.has(key) || JSON.stringify(after[key]) === JSON.stringify(before[key]))) {
        return { ...existing, id, database_id: id };
      }
      return { ...row, id, database_id: id, version: existing.version, updated_at: existing.updated_at };
    }
    // Only a genuinely new business key is allowed a deterministic UUID.
    const proposed = { ...row, id: undefined, database_id: undefined };
    const id = canonicalCloudId('inventory_items', proposed as unknown as Record<string, unknown>);
    return { ...proposed, id, database_id: id };
  });
  const inventory = [...projected, ...retained.map(row => {
    const id = canonicalCloudId('inventory_items', row as unknown as Record<string, unknown>);
    return { ...row, id, database_id: id };
  })];
  // A new key must not reuse a non-empty myacg_item_code already held by an
  // active row or by another new key of this file (re-keyed SKU). Fail before
  // any write; existing duplicate codes are neither repaired nor blocked here.
  const skuCode = (row: InventoryItem) => String(row.myacg_item_code ?? '').trim().toUpperCase();
  const activeCodes = new Set(active.map(skuCode).filter(Boolean));
  const newCodes = new Set<string>();
  const rekeyed = new Set<string>();
  for (const row of projected) {
    if (byKey.has(row.inventory_key!) || renames.has(row.inventory_key!)) continue;
    const code = skuCode(row);
    if (!code) continue;
    if (activeCodes.has(code) || newCodes.has(code)) rekeyed.add(code);
    newCodes.add(code);
  }
  if (rekeyed.size) throw preflightError('BUYANIME_INVENTORY_SKU_REKEY_CONFLICT', [...rekeyed].sort());
  const operations = buildCloudCollectionMutationPlan('inventory_items',
    active.map(row => toCloudFieldRow('inventory_items', row)),
    inventory.map(row => toCloudFieldRow('inventory_items', row)));

  // Unique-key dependency defense: a soft DELETE does not release inventory_key.
  // Thus delete/create with the same key is never a legal replacement. Fail
  // before dispatch instead of trusting client array order (SQL sorts by UUID).
  const nextById = new Map(inventory.map(row => [row.id, row]));
  for (const operation of operations) {
    if (operation.kind === 'create' && byKey.has(String(operation.values.inventory_key))) {
      throw new Error('CLOUD_INVENTORY_IDENTITY_REPLACEMENT_FORBIDDEN');
    }
    if (operation.kind === 'patch' && Object.hasOwn(operation.changes, 'inventory_key')) {
      const holder = byKey.get(String(operation.changes.inventory_key));
      if (holder && canonicalCloudId('inventory_items', holder as unknown as Record<string, unknown>) !== operation.id) {
        throw new Error('CLOUD_INVENTORY_UNIQUE_KEY_TRANSFER_FORBIDDEN');
      }
    }
    if (operation.kind === 'delete' && nextById.has(operation.id)) {
      throw new Error('CLOUD_INVENTORY_IDENTITY_REPLACEMENT_FORBIDDEN');
    }
  }
  if (operations.some(op => op.kind !== 'create' && op.kind !== 'patch')) {
    throw preflightError('BUYANIME_INVENTORY_UNSUPPORTED_OPERATION', [...new Set(operations.map(op => op.kind))].sort());
  }
  // Use exactly the existing import's key normalization/duplicate merge.
  const importedKeys = new Set(prepareInventoryUpsert([], incoming).inventory.map(row => row.inventory_key));
  const importedOperations = operations.filter(op => op.kind === 'create' ||
    (op.kind === 'patch' && importedKeys.has(nextById.get(op.id)?.inventory_key)));
  const newCount = importedOperations.filter(op => op.kind === 'create').length;
  const updatedCount = importedOperations.filter(op => op.kind === 'patch').length;
  const imported = inventory.filter(row => importedKeys.has(row.inventory_key));
  markBuyAnimeTrace('T09_INDEX_BUILD_DONE', { authoritativeRows: authoritative.length, incomingRows: incoming.length });
  return { inventory, imported, operations, batchId: incoming[0]?.latest_catalog_import_id, stats: { ...projection.stats, newCount, updatedCount,
    unchangedCount: importedKeys.size - newCount - updatedCount } };
}

const skuText = (value: unknown) => String(value ?? '').trim().toUpperCase();

/**
 * BuyAnime corrected a variant label of an existing SKU (same item code, same parent code, same product):
 * the file's row gets a new inventory_key (title::code::variant) while its code is held by exactly one
 * active row. Returns new key -> that row, only when every condition proves it is the same SKU:
 * - the new key is held by no row at all (active or tombstone), and the file has no other row with this code;
 * - exactly one row in the whole table (active or tombstone) has this code, and it is active;
 * - parent code is non-empty and equal, normalized product title is equal, only the variant label differs;
 * - the file does not also carry the holder's current key (old and new label in one file).
 * Anything else is left to BUYANIME_INVENTORY_SKU_REKEY_CONFLICT (fail closed).
 */
function detectVariantRenames(
  authoritative: AuthoritativeInventory[], active: AuthoritativeInventory[], projected: InventoryItem[],
  byKey: Map<string, AuthoritativeInventory>,
): Map<string, AuthoritativeInventory> {
  const renames = new Map<string, AuthoritativeInventory>();
  const allByCode = new Map<string, AuthoritativeInventory[]>();
  for (const row of authoritative) {
    const code = skuText(row.myacg_item_code);
    if (code) allByCode.set(code, [...(allByCode.get(code) ?? []), row]);
  }
  const fileByCode = new Map<string, InventoryItem[]>();
  for (const row of projected) {
    const code = skuText(row.myacg_item_code);
    if (code) fileByCode.set(code, [...(fileByCode.get(code) ?? []), row]);
  }
  const fileKeys = new Set(projected.map(row => row.inventory_key));
  const activeIds = new Set(active.map(row => row.id));
  for (const row of projected) {
    const key = row.inventory_key!;
    const code = skuText(row.myacg_item_code);
    if (!code || byKey.has(key)) continue;
    const holders = allByCode.get(code) ?? [];
    if (holders.length !== 1 || (fileByCode.get(code) ?? []).length !== 1) continue;
    const holder = holders[0];
    if (holder.deleted_at || !activeIds.has(holder.id) || !holder.inventory_key || fileKeys.has(holder.inventory_key)) continue;
    const parent = skuText(row.myacg_parent_code);
    if (!parent || parent !== skuText(holder.myacg_parent_code)) continue;
    const title = normalizeProductTitle(row.product_title);
    if (!title || title !== normalizeProductTitle(holder.product_title)) continue;
    if (String(row.raw_variant_name ?? '').trim() === String(holder.raw_variant_name ?? '').trim()) continue;
    if (typeof holder.version !== 'number') continue;
    renames.set(key, holder);
  }
  return renames;
}
