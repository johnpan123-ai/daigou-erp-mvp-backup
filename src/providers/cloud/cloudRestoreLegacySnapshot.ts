export const LEGACY_CLOUD_RESTORE_IDENTITY_CONTRACT = 'legacy-inventory-key-v1' as const;
export const LEGACY_CLOUD_RESTORE_VALID = 'LEGACY_SNAPSHOT_VALID' as const;

const LEGACY_SCHEMA_VERSION = 'cloud-erp-snapshot-v1' as const;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

const LEGACY_TABLES = [
  ['inventory', 'inventory_items'],
  ['productGroups', 'product_groups'],
  ['productCategories', 'product_categories'],
  ['productVariants', 'product_variants'],
  ['bundleComponents', 'bundle_components'],
  ['purchaseBatches', 'purchase_batches'],
  ['purchaseBatchItems', 'purchase_batch_items'],
  ['privateOrders', 'private_orders'],
  ['privateOrderItems', 'private_order_items'],
  ['salesOrders', 'sales_orders'],
  ['salesOrderItems', 'sales_order_items'],
  ['japanPackages', 'japan_packages'],
  ['japanPackageItems', 'japan_package_items'],
  ['outboundShipments', 'outbound_shipments'],
  ['outboundShipmentItems', 'outbound_shipment_items'],
] as const;

type LegacyTable = typeof LEGACY_TABLES[number][1];
type LegacySnapshotData = Record<LegacyTable, Record<string, unknown>[]>;

// Frozen at the pre-df779029 relation contract. Do not replace this with the
// current relation registry: this verifier must keep reproducing old manifests
// even if the current Restore contract changes later.
const LEGACY_RELATIONS = [
  ['product_categories', 'product_group_id', 'product_groups', 'blocking', false],
  ['product_variants', 'product_group_id', 'product_groups', 'blocking', false],
  ['product_variants', 'product_category_id', 'product_categories', 'metadata', true],
  ['bundle_components', 'bundle_variant_id', 'product_variants', 'blocking', false],
  ['bundle_components', 'component_variant_id', 'product_variants', 'blocking', false],
  ['purchase_batches', 'product_group_id', 'product_groups', 'blocking', false],
  ['purchase_batch_items', 'purchase_batch_id', 'purchase_batches', 'blocking', false],
  ['purchase_batch_items', 'product_variant_id', 'product_variants', 'blocking', false],
  ['private_orders', 'product_group_id', 'product_groups', 'blocking', false],
  ['private_order_items', 'private_order_id', 'private_orders', 'blocking', false],
  ['private_order_items', 'product_variant_id', 'product_variants', 'blocking', false],
  ['sales_order_items', 'order_id', 'sales_orders', 'blocking', false],
  ['sales_order_items', 'product_variant_id', 'product_variants', 'metadata', true],
  ['japan_package_items', 'japan_package_id', 'japan_packages', 'blocking', false],
  ['japan_package_items', 'product_group_id', 'product_groups', 'metadata', true],
  ['japan_package_items', 'product_variant_id', 'product_variants', 'metadata', true],
  ['japan_package_items', 'purchase_batch_id', 'purchase_batches', 'metadata', true],
  ['japan_package_items', 'purchase_batch_item_id', 'purchase_batch_items', 'metadata', true],
  ['outbound_shipment_items', 'outbound_shipment_id', 'outbound_shipments', 'blocking', false],
  ['outbound_shipment_items', 'japan_package_item_id', 'japan_package_items', 'metadata', true],
  ['outbound_shipment_items', 'product_group_id', 'product_groups', 'metadata', true],
  ['outbound_shipment_items', 'product_variant_id', 'product_variants', 'metadata', true],
] as const satisfies readonly (readonly [LegacyTable, string, LegacyTable, 'blocking' | 'metadata', boolean])[];

const LEGACY_MANIFEST_KEYS = [
  'schemaVersion',
  'resourceCount',
  'counts',
  'totalRows',
  'snapshotFingerprint',
  'unknownProductCount',
  'orphanCount',
  'duplicateVariantIdCount',
  'duplicateVariantLocalIdCount',
  'duplicateCanonicalIdCount',
  'optionalMetadataMissingReferenceCount',
  'canonicalIdentityAnomalyCount',
  'relationshipHash',
] as const;

export interface LegacyCloudRestoreManifest {
  schemaVersion: typeof LEGACY_SCHEMA_VERSION;
  resourceCount: number;
  counts: Record<LegacyTable, number>;
  totalRows: number;
  snapshotFingerprint: string;
  unknownProductCount: number;
  orphanCount: number;
  duplicateVariantIdCount: number;
  duplicateVariantLocalIdCount: number;
  duplicateCanonicalIdCount: number;
  optionalMetadataMissingReferenceCount: number;
  canonicalIdentityAnomalyCount: number;
  relationshipHash: string;
}

export interface LegacyCloudRestoreVerification {
  status: typeof LEGACY_CLOUD_RESTORE_VALID;
  identityContractVersion: typeof LEGACY_CLOUD_RESTORE_IDENTITY_CONTRACT;
  manifest: LegacyCloudRestoreManifest;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
};

const stableJson = (value: unknown): string => JSON.stringify(stableValue(value));

const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const duplicateCount = (values: string[]): number => values.length - new Set(values).size;

const legacyCanonicalId = (row: Record<string, unknown>, table: LegacyTable): string => {
  if (table === 'inventory_items') return String(row.inventory_key ?? '').trim();
  const databaseId = String(row.database_id ?? '').trim();
  const id = UUID_PATTERN.test(databaseId) ? databaseId : String(row.id ?? '').trim();
  return UUID_PATTERN.test(id) ? id.toLowerCase() : '';
};

const normalizeLegacyData = (source: Record<string, unknown>): LegacySnapshotData | null => {
  const expectedCollections = new Set(LEGACY_TABLES.map(([collection]) => collection));
  if (Object.keys(source).some(key => !expectedCollections.has(key as typeof LEGACY_TABLES[number][0]))) return null;
  const entries: [LegacyTable, Record<string, unknown>[]][] = [];
  for (const [collection, table] of LEGACY_TABLES) {
    const rows = source[collection];
    if (!Array.isArray(rows) || rows.some(row => !isRecord(row))) return null;
    const cloned = rows.map(row => ({ ...(row as Record<string, unknown>) }));
    if (cloned.some(row => !legacyCanonicalId(row, table))) return null;
    cloned.sort((left, right) => legacyCanonicalId(left, table).localeCompare(legacyCanonicalId(right, table)));
    entries.push([table, cloned]);
  }
  return Object.fromEntries(entries) as LegacySnapshotData;
};

const auditLegacyRelations = (data: LegacySnapshotData): {
  blockingOrphanCount: number;
  optionalMetadataMissingReferenceCount: number;
} => {
  const parentIds = new Map<LegacyTable, Set<string>>(
    LEGACY_TABLES.map(([, table]) => [table, new Set(data[table].map(row => legacyCanonicalId(row, table)))]),
  );
  let blockingOrphanCount = 0;
  let optionalMetadataMissingReferenceCount = 0;
  for (const [childTable, field, parentTable, kind, optional] of LEGACY_RELATIONS) {
    const parents = parentIds.get(parentTable) ?? new Set<string>();
    let invalidCount = 0;
    for (const row of data[childTable]) {
      const value = String(row[field] ?? '').trim().toLowerCase();
      if (!value) {
        if (!optional) invalidCount += 1;
      } else if (!parents.has(value)) {
        invalidCount += 1;
      }
    }
    if (kind === 'blocking') blockingOrphanCount += invalidCount;
    else optionalMetadataMissingReferenceCount += invalidCount;
  }
  return { blockingOrphanCount, optionalMetadataMissingReferenceCount };
};

export async function buildLegacyCloudRestoreManifest(
  source: Record<string, unknown>,
): Promise<{ data: LegacySnapshotData; manifest: LegacyCloudRestoreManifest } | null> {
  const data = normalizeLegacyData(source);
  if (!data) return null;
  const counts = Object.fromEntries(LEGACY_TABLES.map(([, table]) => [table, data[table].length])) as Record<LegacyTable, number>;
  const relationshipProjection = LEGACY_TABLES.flatMap(([, table]) => data[table].map(row => ({
    table,
    id: legacyCanonicalId(row, table),
    relations: Object.fromEntries(Object.entries(row).filter(([key]) => key.endsWith('_id') && key !== 'local_id')),
  }))).sort((left, right) => `${left.table}:${left.id}`.localeCompare(`${right.table}:${right.id}`));
  const relationAudit = auditLegacyRelations(data);
  const duplicateCanonicalIdCount = LEGACY_TABLES.reduce(
    (sum, [, table]) => sum + duplicateCount(data[table].map(row => legacyCanonicalId(row, table))),
    0,
  );
  const duplicateVariantIdCount = duplicateCount(data.product_variants.map(row => legacyCanonicalId(row, 'product_variants')));
  const duplicateVariantLocalIdCount = duplicateCount(data.product_variants
    .map(row => String(row.local_id ?? '').trim())
    .filter(Boolean));
  const canonicalIdentityAnomalyCount = LEGACY_TABLES.reduce((sum, [, table]) => sum + (
    table === 'inventory_items'
      ? 0
      : data[table].reduce((anomalies, row) => anomalies + (UUID_PATTERN.test(String(row.id ?? '').trim()) ? 0 : 1), 0)
  ), 0);
  const unknownProductCount = data.product_groups.filter(row => {
    const title = String(row.normalized_title ?? row.title ?? '').trim().toLowerCase();
    return title === '未知商品' || title === 'unknown product';
  }).length;
  return {
    data,
    manifest: {
      schemaVersion: LEGACY_SCHEMA_VERSION,
      resourceCount: LEGACY_TABLES.length,
      counts,
      totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
      snapshotFingerprint: await sha256Hex(stableJson(data)),
      unknownProductCount,
      orphanCount: relationAudit.blockingOrphanCount,
      duplicateVariantIdCount,
      duplicateVariantLocalIdCount,
      duplicateCanonicalIdCount,
      optionalMetadataMissingReferenceCount: relationAudit.optionalMetadataMissingReferenceCount,
      canonicalIdentityAnomalyCount,
      relationshipHash: await sha256Hex(stableJson(relationshipProjection)),
    },
  };
}

const legacyManifestMatches = (provided: Record<string, unknown>, expected: LegacyCloudRestoreManifest): boolean => {
  const providedKeys = Object.keys(provided).sort();
  const expectedKeys = [...LEGACY_MANIFEST_KEYS].sort();
  if (providedKeys.length !== expectedKeys.length || providedKeys.some((key, index) => key !== expectedKeys[index])) return false;
  if (!isRecord(provided.counts)) return false;
  const providedCounts = provided.counts;
  const countKeys = Object.keys(providedCounts).sort();
  const expectedCountKeys = LEGACY_TABLES.map(([, table]) => table).sort();
  if (countKeys.length !== expectedCountKeys.length || countKeys.some((key, index) => key !== expectedCountKeys[index])) return false;
  return provided.schemaVersion === expected.schemaVersion
    && provided.resourceCount === expected.resourceCount
    && provided.totalRows === expected.totalRows
    && provided.snapshotFingerprint === expected.snapshotFingerprint
    && provided.relationshipHash === expected.relationshipHash
    && provided.unknownProductCount === expected.unknownProductCount
    && provided.orphanCount === expected.orphanCount
    && provided.duplicateVariantIdCount === expected.duplicateVariantIdCount
    && provided.duplicateVariantLocalIdCount === expected.duplicateVariantLocalIdCount
    && provided.duplicateCanonicalIdCount === expected.duplicateCanonicalIdCount
    && provided.optionalMetadataMissingReferenceCount === expected.optionalMetadataMissingReferenceCount
    && provided.canonicalIdentityAnomalyCount === expected.canonicalIdentityAnomalyCount
    && LEGACY_TABLES.every(([, table]) => providedCounts[table] === expected.counts[table]);
};

export async function verifyLegacyCloudRestoreSnapshot(
  source: Record<string, unknown>,
  providedManifest: unknown,
): Promise<LegacyCloudRestoreVerification | null> {
  if (!isRecord(providedManifest) || 'identityContractVersion' in providedManifest) return null;
  const built = await buildLegacyCloudRestoreManifest(source);
  if (!built || !legacyManifestMatches(providedManifest, built.manifest)) return null;
  return {
    status: LEGACY_CLOUD_RESTORE_VALID,
    identityContractVersion: LEGACY_CLOUD_RESTORE_IDENTITY_CONTRACT,
    manifest: built.manifest,
  };
}
