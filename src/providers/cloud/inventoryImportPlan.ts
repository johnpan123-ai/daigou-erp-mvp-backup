import { prepareInventoryUpsert, type InventoryItem } from '../../lib/db';
import { canonicalCloudId, toCloudFieldRow } from './cloudEntityPayload';
import { buildCloudCollectionMutationPlan } from './cloudFieldCas';

type AuthoritativeInventory = InventoryItem & { deleted_at?: string | null };

/**
 * Bind the existing import projection to server identities before planning CAS.
 * A parsed external code/UUID never replaces an existing inventory_key's UUID.
 * Tombstones retain their unique key under the adopted SQL contract; there is
 * no implicit revive or same-key UUID replacement operation in this import.
 */
export function planCloudInventoryImport(
  authoritative: AuthoritativeInventory[], incoming: InventoryItem[],
) {
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
  const inventory = projection.inventory.map(row => {
    const existing = byKey.get(row.inventory_key!);
    if (existing?.deleted_at) throw new Error('CLOUD_INVENTORY_KEY_SOFT_DELETED');
    if (existing) {
      const id = canonicalCloudId('inventory_items', existing as unknown as Record<string, unknown>);
      return { ...row, id, database_id: id, version: existing.version, updated_at: existing.updated_at };
    }
    // Only a genuinely new business key is allowed a deterministic UUID.
    const proposed = { ...row, id: undefined, database_id: undefined };
    const id = canonicalCloudId('inventory_items', proposed as unknown as Record<string, unknown>);
    return { ...proposed, id, database_id: id };
  });
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
  // Use exactly the existing import's key normalization/duplicate merge.
  const importedKeys = new Set(prepareInventoryUpsert([], incoming).inventory.map(row => row.inventory_key));
  const importedOperations = operations.filter(op => op.kind === 'create' ||
    (op.kind === 'patch' && importedKeys.has(nextById.get(op.id)?.inventory_key)));
  const newCount = importedOperations.filter(op => op.kind === 'create').length;
  const updatedCount = importedOperations.filter(op => op.kind === 'patch').length;
  return { inventory, operations, stats: { ...projection.stats, newCount, updatedCount,
    unchangedCount: importedKeys.size - newCount - updatedCount } };
}
