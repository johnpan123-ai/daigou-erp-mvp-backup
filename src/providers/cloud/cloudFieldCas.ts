export const CLOUD_FIELD_CONFLICT_MESSAGE = '資料已由其他裝置更新，請重新確認後再儲存。';
export const CLOUD_RECORD_DELETED_MESSAGE = '此資料已由其他裝置刪除或停用，請重新確認。';

export type CloudMutableEntity =
  | 'product_groups'
  | 'product_categories'
  | 'product_variants'
  | 'inventory_items'
  | 'purchase_batches'
  | 'purchase_batch_items'
  | 'private_orders'
  | 'private_order_items'
  | 'japan_packages'
  | 'japan_package_items'
  | 'outbound_shipments'
  | 'outbound_shipment_items'
  | 'sales_orders'
  | 'sales_order_items'
  | 'bundle_components';

export type CloudFieldMutationCode =
  | 'FIELD_CONFLICT'
  | 'RECORD_DELETED_OR_MISSING'
  | 'STALE_DELETE'
  | 'DUPLICATE_CREATE'
  | 'REORDER_CONFLICT'
  | 'INVALID_MUTATION';

export interface CloudFieldConflict {
  field: string;
  expected: unknown;
  current: unknown;
}

export interface CloudFieldMutationFailure {
  ok: false;
  code: CloudFieldMutationCode;
  entity: CloudMutableEntity;
  recordId: string;
  conflicts?: CloudFieldConflict[];
}

export interface CloudFieldMutationSuccess {
  ok: true;
  entity: CloudMutableEntity;
  rows: Array<Record<string, unknown>>;
}

export type CloudFieldMutationResult = CloudFieldMutationFailure | CloudFieldMutationSuccess;

export interface CloudCreateOperation {
  kind: 'create';
  id: string;
  values: Record<string, unknown>;
}

export interface CloudPatchOperation {
  kind: 'patch';
  id: string;
  expected: Record<string, unknown>;
  changes: Record<string, unknown>;
  observedVersion: number;
}

export interface CloudDeleteOperation {
  kind: 'delete';
  id: string;
  expectedVersion: number;
}

export interface CloudReorderOperation {
  kind: 'reorder';
  id: string;
  expected: Record<string, unknown>;
  changes: Record<string, unknown>;
  expectedVersion: number;
}

export type CloudFieldMutationOperation =
  | CloudCreateOperation
  | CloudPatchOperation
  | CloudDeleteOperation
  | CloudReorderOperation;

interface EntityContract {
  create: readonly string[];
  patch: readonly string[];
  reorder: readonly string[];
  delete: boolean;
}

const contract = (
  create: readonly string[],
  patch: readonly string[] = create.filter(field => field !== 'local_id'),
  options: { reorder?: readonly string[]; delete?: boolean } = {},
): EntityContract => ({
  create,
  patch,
  reorder: options.reorder ?? [],
  delete: options.delete ?? true,
});

/**
 * Client-side mirror of the SQL whitelist. The SQL function is authoritative;
 * this copy fails early and is regression-tested against the migration artifact.
 */
export const CLOUD_FIELD_ENTITY_CONTRACTS: Readonly<Record<CloudMutableEntity, EntityContract>> = {
  product_groups: contract([
    'local_id', 'title', 'normalized_title', 'listing_type', 'priority', 'purchase_date',
    'closing_date', 'release_month', 'has_official_site', 'product_url', 'proxy_agent',
    'show_in_purchase_list',
  ]),
  product_categories: contract(
    ['local_id', 'product_group_id', 'title', 'sort_order'],
    undefined,
    { reorder: ['sort_order'] },
  ),
  product_variants: contract(
    [
      'local_id', 'product_group_id', 'product_category_id', 'myacg_item_code',
      'product_title', 'variant_name', 'raw_variant_name', 'myacg_auto_quantity',
      'effective_myacg_quantity', 'myacg_manual_adjustment', 'waca_auto_quantity',
      'waca_manual_adjustment', 'private_manual_adjustment',
      'purchased_manual_adjustment', 'note', 'sort_order', 'catalog_missing', 'source',
      'default_jpy_cost', 'default_twd_cost',
    ],
    undefined,
    { reorder: ['sort_order'] },
  ),
  inventory_items: contract([
    'inventory_key', 'myacg_item_code', 'myacg_parent_code', 'product_id', 'product_title',
    'normalized_product_title', 'raw_variant_name', 'listing_type', 'final_price',
    'myacg_available_quantity', 'myacg_sold_quantity', 'myacg_demand_quantity',
    'myacg_listed_at', 'import_sort_index', 'latest_catalog_import_id',
    'catalog_last_seen_at',
  ]),
  purchase_batches: contract([
    'local_id', 'product_group_id', 'name', 'date', 'note', 'currency',
  ]),
  purchase_batch_items: contract([
    'local_id', 'purchase_batch_id', 'product_variant_id', 'quantity', 'cost', 'note',
  ]),
  private_orders: contract([
    'local_id', 'product_group_id', 'customer_name', 'contact', 'note', 'status',
  ]),
  private_order_items: contract([
    'local_id', 'private_order_id', 'product_variant_id', 'quantity', 'amount', 'note',
  ]),
  japan_packages: contract([
    'title', 'vendor_name', 'carrier', 'tracking_number', 'shipped_at',
    'expected_arrival_at', 'arrived_at', 'status', 'note',
  ]),
  japan_package_items: contract([
    'japan_package_id', 'product_group_id', 'product_variant_id', 'purchase_batch_id',
    'purchase_batch_item_id', 'product_title', 'category_name', 'variant_name', 'sku',
    'quantity', 'note', 'checked', 'checked_at',
  ]),
  outbound_shipments: contract([
    'title', 'status', 'carrier', 'tracking_number', 'weight_kg', 'shipping_cost',
    'shipped_at', 'received_at', 'note',
  ]),
  outbound_shipment_items: contract([
    'outbound_shipment_id', 'japan_package_item_id', 'product_group_id',
    'product_variant_id', 'product_title', 'variant_name', 'sku', 'quantity',
    'checked', 'checked_at', 'note',
  ]),
  sales_orders: contract(['local_id', 'platform', 'order_number', 'buyer_name']),
  sales_order_items: contract([
    'local_id', 'order_id', 'product_variant_id', 'myacg_item_code', 'product_name',
    'variant_name', 'quantity', 'price', 'amount', 'order_status',
  ]),
  bundle_components: contract(
    ['bundle_variant_id', 'component_variant_id'],
    [],
    { reorder: [], delete: true },
  ),
};

const SYSTEM_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'updated_by', 'version', 'deleted_at', 'sync_status',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
};

export const cloudFieldValuesEqual = (left: unknown, right: unknown): boolean => (
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
);

function assertCanonicalUuid(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('CLOUD_MUTATION_CANONICAL_UUID_REQUIRED');
  }
}

const assertVersion = (row: Record<string, unknown>): number => {
  if (!Number.isInteger(row.version) || Number(row.version) < 1) {
    throw new Error('CLOUD_MUTATION_VERSION_REQUIRED');
  }
  return Number(row.version);
};

const selectAllowed = (
  source: Record<string, unknown>,
  allowed: readonly string[],
  options: { ignoreSystemContext?: boolean } = {},
): Record<string, unknown> => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(source)) {
    if (SYSTEM_FIELDS.has(key) && options.ignoreSystemContext) continue;
    if (!allowedSet.has(key)) throw new Error(`CLOUD_MUTATION_FIELD_NOT_ALLOWED:${key}`);
  }
  return Object.fromEntries(allowed.filter(field => Object.hasOwn(source, field)).map(field => [field, source[field]]));
};

const selectMutableFromNormalizedRow = (
  source: Record<string, unknown>,
  entityContract: EntityContract,
): Record<string, unknown> => {
  const knownFields = new Set(entityContract.create);
  for (const key of Object.keys(source)) {
    if (SYSTEM_FIELDS.has(key)) continue;
    if (!knownFields.has(key)) throw new Error(`CLOUD_MUTATION_FIELD_NOT_ALLOWED:${key}`);
  }
  return Object.fromEntries(
    entityContract.patch
      .filter(field => Object.hasOwn(source, field))
      .map(field => [field, source[field]]),
  );
};

export const buildCloudCollectionMutationPlan = (
  entity: CloudMutableEntity,
  baseRows: Array<Record<string, unknown>>,
  nextRows: Array<Record<string, unknown>>,
  options: { deleteMissing?: boolean } = {},
): CloudFieldMutationOperation[] => {
  const entityContract = CLOUD_FIELD_ENTITY_CONTRACTS[entity];
  const baseById = new Map<string, Record<string, unknown>>();
  for (const row of baseRows) {
    assertCanonicalUuid(row.id);
    baseById.set(row.id, row);
  }
  const nextById = new Map<string, Record<string, unknown>>();
  const operations: CloudFieldMutationOperation[] = [];

  for (const row of nextRows) {
    assertCanonicalUuid(row.id);
    if (nextById.has(row.id)) throw new Error(`CLOUD_MUTATION_DUPLICATE_CLIENT_ID:${row.id}`);
    nextById.set(row.id, row);
    const base = baseById.get(row.id);
    if (!base) {
      operations.push({
        kind: 'create',
        id: row.id,
        values: selectAllowed(row, entityContract.create, { ignoreSystemContext: true }),
      });
      continue;
    }

    // A normalized persisted row can contain create-only identity metadata such
    // as local_id. It is accepted as input context but never enters a patch.
    const allowedNext = selectMutableFromNormalizedRow(row, entityContract);
    const changes: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(allowedNext)) {
      if (!cloudFieldValuesEqual(base[field], value)) {
        changes[field] = value;
        expected[field] = base[field];
      }
    }
    if (Object.keys(changes).length > 0) {
      const isReorder = entityContract.reorder.length > 0
        && Object.keys(changes).every(field => entityContract.reorder.includes(field));
      operations.push(isReorder
        ? { kind: 'reorder', id: row.id, expected, changes, expectedVersion: assertVersion(base) }
        : { kind: 'patch', id: row.id, expected, changes, observedVersion: assertVersion(base) });
    }
  }

  if (options.deleteMissing !== false && entityContract.delete) {
    for (const base of baseRows) {
      const id = String(base.id);
      if (!nextById.has(id)) {
        operations.push({ kind: 'delete', id, expectedVersion: assertVersion(base) });
      }
    }
  }

  return operations.sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind));
};

export const buildCloudPatchOperation = (
  entity: CloudMutableEntity,
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): CloudPatchOperation | null => {
  assertCanonicalUuid(base.id);
  const allowed = selectAllowed(patch, CLOUD_FIELD_ENTITY_CONTRACTS[entity].patch);
  const changes: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(allowed)) {
    if (!cloudFieldValuesEqual(base[field], value)) {
      changes[field] = value;
      expected[field] = base[field];
    }
  }
  if (Object.keys(changes).length === 0) return null;
  return { kind: 'patch', id: String(base.id), expected, changes, observedVersion: assertVersion(base) };
};

export const buildCloudReorderOperations = (
  entity: CloudMutableEntity,
  baseRows: Array<Record<string, unknown>>,
  changesById: Readonly<Record<string, Record<string, unknown>>>,
): CloudReorderOperation[] => {
  const allowed = CLOUD_FIELD_ENTITY_CONTRACTS[entity].reorder;
  if (allowed.length === 0) throw new Error(`CLOUD_REORDER_NOT_SUPPORTED:${entity}`);
  const baseById = new Map(baseRows.map(row => [String(row.id), row]));
  return Object.entries(changesById).sort(([a], [b]) => a.localeCompare(b)).map(([id, changes]) => {
    assertCanonicalUuid(id);
    const base = baseById.get(id);
    if (!base) throw new Error(`CLOUD_REORDER_BASE_MISSING:${id}`);
    const selected = selectAllowed(changes, allowed);
    const expected = Object.fromEntries(Object.keys(selected).map(field => [field, base[field]]));
    return { kind: 'reorder', id, changes: selected, expected, expectedVersion: assertVersion(base) };
  });
};

export class CloudFieldMutationError extends Error {
  readonly code: CloudFieldMutationCode;
  readonly entity: CloudMutableEntity;
  readonly recordId: string;
  readonly conflicts: CloudFieldConflict[];

  constructor(failure: CloudFieldMutationFailure) {
    const message = failure.code === 'RECORD_DELETED_OR_MISSING'
      ? CLOUD_RECORD_DELETED_MESSAGE
      : CLOUD_FIELD_CONFLICT_MESSAGE;
    super(message);
    this.name = 'CloudFieldMutationError';
    this.code = failure.code;
    this.entity = failure.entity;
    this.recordId = failure.recordId;
    this.conflicts = failure.conflicts ?? [];
  }
}

export const isCloudFieldMutationError = (value: unknown): value is CloudFieldMutationError => (
  value instanceof CloudFieldMutationError
);

let lastConflictNotice = '';
let lastConflictNoticeAt = 0;

export const notifyCloudFieldMutationConflict = (error: CloudFieldMutationError): void => {
  if (typeof window === 'undefined') return;
  const signature = `${error.code}:${error.entity}:${error.recordId}:${JSON.stringify(error.conflicts)}`;
  const now = Date.now();
  if (signature === lastConflictNotice && now - lastConflictNoticeAt < 1500) return;
  lastConflictNotice = signature;
  lastConflictNoticeAt = now;
  window.dispatchEvent(new CustomEvent('cloud-field-mutation-conflict', {
    detail: {
      message: error.message,
      code: error.code,
      entity: error.entity,
      recordId: error.recordId,
      conflicts: error.conflicts,
    },
  }));
};

export const assertCloudFieldMutationSucceeded = (
  value: unknown,
  entity: CloudMutableEntity,
): CloudFieldMutationSuccess => {
  if (!isPlainObject(value) || value.ok !== true) {
    const failure = isPlainObject(value) ? value : {};
    throw new CloudFieldMutationError({
      ok: false,
      code: typeof failure.code === 'string' ? failure.code as CloudFieldMutationCode : 'INVALID_MUTATION',
      entity: typeof failure.entity === 'string' ? failure.entity as CloudMutableEntity : entity,
      recordId: typeof failure.recordId === 'string' ? failure.recordId : '',
      conflicts: Array.isArray(failure.conflicts) ? failure.conflicts as CloudFieldConflict[] : [],
    });
  }
  return value as unknown as CloudFieldMutationSuccess;
};
