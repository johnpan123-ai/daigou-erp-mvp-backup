const PARITY_TABLES = Object.freeze([
  'inventory_items',
  'product_groups',
  'product_variants',
  'purchase_batches',
  'private_orders',
  'sales_orders',
  'sales_order_items',
]);

const clone = value => structuredClone(value);
const column = (dataType, nullable, defaultValue = null) => ({
  dataType,
  udtName: dataType === 'timestamp with time zone' ? 'timestamptz' : dataType,
  nullable,
  defaultValue,
  generated: 'NEVER',
  identityGeneration: null,
});

const assertLegacyPrestate = fixture => {
  const tables = fixture?.schema?.tables || {};
  for (const table of PARITY_TABLES) {
    if (!tables[table]) throw new Error(`STAGING_PARITY_PREFLIGHT:required_table_missing:${table}`);
  }

  const inventory = tables.inventory_items;
  if (inventory.columns.id
      || inventory.columns.latest_catalog_import_id
      || inventory.columns.catalog_last_seen_at
      || inventory.primaryKey.join(',') !== 'inventory_key'
      || inventory.uniques.length !== 0) {
    throw new Error('STAGING_PARITY_PREFLIGHT:inventory_contract_mismatch');
  }

  const productDate = tables.product_groups.columns.purchase_date;
  const batchDate = tables.purchase_batches.columns.date;
  if (productDate.dataType !== 'text' || !productDate.nullable
      || batchDate.dataType !== 'text' || !batchDate.nullable) {
    throw new Error('STAGING_PARITY_PREFLIGHT:legacy_date_column_contract_mismatch');
  }

  for (const name of ['private_manual_adjustment', 'purchased_manual_adjustment']) {
    const adjustment = tables.product_variants.columns[name];
    if (adjustment.dataType !== 'integer' || adjustment.nullable || adjustment.defaultValue !== '0') {
      throw new Error('STAGING_PARITY_PREFLIGHT:manual_adjustment_contract_mismatch');
    }
  }

  if (!tables.sales_orders.columns.buyer_name.nullable
      || tables.sales_orders.columns.version
      || tables.sales_order_items.columns.version
      || tables.sales_order_items.columns.price.nullable
      || tables.sales_order_items.columns.amount.nullable) {
    throw new Error('STAGING_PARITY_PREFLIGHT:sales_contract_mismatch');
  }

  if (fixture.schema.foreignKeys.purchase_batches_product_group_id_fkey.onDelete !== 'RESTRICT'
      || fixture.schema.foreignKeys.private_orders_product_group_id_fkey.onDelete !== 'RESTRICT') {
    throw new Error('STAGING_PARITY_PREFLIGHT:product_group_fk_contract_mismatch');
  }

  if (tables.sales_orders.indexes.idx_sales_orders_order_number.unique !== true
      || !tables.sales_orders.indexes.idx_sales_orders_deleted_at
      || !tables.sales_order_items.indexes.idx_sales_order_items_deleted_at) {
    throw new Error('STAGING_PARITY_PREFLIGHT:index_contract_mismatch');
  }
};

const normalizeIsoDate = (value, label) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`UNSAFE_DATE_CAST:${label}`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`UNSAFE_DATE_CAST:${label}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year
      || parsed.getUTCMonth() !== month - 1
      || parsed.getUTCDate() !== day) {
    throw new Error(`UNSAFE_DATE_CAST:${label}`);
  }
  return value;
};

const assertRowsSafe = fixture => {
  const inventoryKeys = (fixture.data.inventory_items || []).map(row => row.inventory_key);
  if (inventoryKeys.some(value => typeof value !== 'string' || value.length === 0)
      || new Set(inventoryKeys).size !== inventoryKeys.length) {
    throw new Error('STAGING_PARITY_PREFLIGHT:inventory_key_not_unique');
  }
  if ((fixture.data.sales_orders || []).some(row => row.buyer_name === null || row.buyer_name === undefined)) {
    throw new Error('STAGING_PARITY_PREFLIGHT:sales_orders_buyer_name_has_null');
  }
  for (const row of fixture.data.product_groups || []) {
    normalizeIsoDate(row.purchase_date, 'product_groups.purchase_date');
  }
  for (const row of fixture.data.purchase_batches || []) {
    normalizeIsoDate(row.date, 'purchase_batches.date');
  }
};

const replaceObject = (target, source) => {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, clone(source));
};

export const STAGING_SCHEMA_PARITY_TABLES = PARITY_TABLES;

export function createLegacyStagingParityFixture() {
  return {
    schema: {
      tables: {
        inventory_items: {
          columns: {
            inventory_key: column('text', false),
            myacg_item_code: column('text', false),
            product_title: column('text', false),
          },
          primaryKey: ['inventory_key'],
          uniques: [],
          indexes: {},
        },
        product_groups: {
          columns: { id: column('uuid', false, 'gen_random_uuid()'), purchase_date: column('text', true) },
          primaryKey: ['id'], uniques: [], indexes: {},
        },
        product_variants: {
          columns: {
            id: column('uuid', false, 'gen_random_uuid()'),
            private_manual_adjustment: column('integer', false, '0'),
            purchased_manual_adjustment: column('integer', false, '0'),
          },
          primaryKey: ['id'], uniques: [], indexes: {},
        },
        purchase_batches: {
          columns: { id: column('uuid', false, 'gen_random_uuid()'), date: column('text', true) },
          primaryKey: ['id'], uniques: [], indexes: {},
        },
        private_orders: {
          columns: { id: column('uuid', false, 'gen_random_uuid()') },
          primaryKey: ['id'], uniques: [], indexes: {},
        },
        sales_orders: {
          columns: {
            id: column('uuid', false, 'gen_random_uuid()'),
            buyer_name: column('text', true),
            order_number: column('text', false),
          },
          primaryKey: ['id'],
          uniques: [{ name: 'sales_orders_order_number_key', columns: ['order_number'] }],
          indexes: {
            idx_sales_orders_order_number: { columns: ['order_number'], unique: true },
            idx_sales_orders_deleted_at: { columns: ['deleted_at'], unique: false, predicate: 'deleted_at IS NULL' },
          },
        },
        sales_order_items: {
          columns: {
            id: column('uuid', false, 'gen_random_uuid()'),
            price: column('numeric', false, '0'),
            amount: column('numeric', false, '0'),
          },
          primaryKey: ['id'], uniques: [],
          indexes: {
            idx_sales_order_items_deleted_at: { columns: ['deleted_at'], unique: false, predicate: 'deleted_at IS NULL' },
          },
        },
      },
      foreignKeys: {
        purchase_batches_product_group_id_fkey: {
          childSchema: 'public', childTable: 'purchase_batches', childColumn: 'product_group_id',
          parentTable: 'product_groups', parentColumn: 'id', ordinalPosition: 1,
          onDelete: 'RESTRICT', onUpdate: 'NO ACTION', validated: true,
        },
        private_orders_product_group_id_fkey: {
          childSchema: 'public', childTable: 'private_orders', childColumn: 'product_group_id',
          parentTable: 'product_groups', parentColumn: 'id', ordinalPosition: 1,
          onDelete: 'RESTRICT', onUpdate: 'NO ACTION', validated: true,
        },
      },
    },
    data: {
      inventory_items: [
        { inventory_key: 'SKU-1::A', myacg_item_code: 'SKU-1', product_title: '商品 A' },
        { inventory_key: 'SKU-1::B', myacg_item_code: 'SKU-1', product_title: '商品 B' },
      ],
      product_groups: [
        { id: 'group-1', title: '群組 A', purchase_date: '2026-09-05' },
        { id: 'group-2', title: '群組 B', purchase_date: '' },
      ],
      product_variants: [
        { id: 'variant-1', private_manual_adjustment: 0, purchased_manual_adjustment: 7 },
      ],
      purchase_batches: [
        { id: 'batch-1', product_group_id: 'group-1', date: '2026-09-04' },
        { id: 'batch-2', product_group_id: 'group-2', date: null },
      ],
      private_orders: [{ id: 'private-1', product_group_id: 'group-1' }],
      sales_orders: [{ id: 'sales-1', buyer_name: '買家', order_number: 'ORDER-1' }],
      sales_order_items: [{ id: 'sales-item-1', price: 100, amount: 200 }],
    },
  };
}

export async function applyStagingSchemaParityFixture(target, options = {}) {
  const before = clone(target);
  const uuidFactory = options.uuidFactory || (index => `fixture-generated-uuid-${index + 1}`);
  let step = 0;
  const checkpoint = label => {
    step += 1;
    if (options.failAfterStep === step) throw new Error(`INJECTED_SCHEMA_PARITY_FAILURE:${label}`);
  };

  try {
    assertLegacyPrestate(target);
    assertRowsSafe(target);

    const tables = target.schema.tables;
    tables.inventory_items.columns.id = column('uuid', false, 'gen_random_uuid()');
    tables.inventory_items.columns.latest_catalog_import_id = column('text', true);
    tables.inventory_items.columns.catalog_last_seen_at = column('timestamp with time zone', true);
    tables.inventory_items.primaryKey = ['id'];
    tables.inventory_items.uniques = [{ name: 'inventory_items_inventory_key_key', columns: ['inventory_key'] }];
    tables.inventory_items.indexes.inventory_items_catalog_last_seen_at_idx = {
      columns: ['catalog_last_seen_at'], unique: false,
    };
    target.data.inventory_items.forEach((row, index) => {
      row.id = uuidFactory(index);
      row.latest_catalog_import_id = null;
      row.catalog_last_seen_at = null;
    });
    checkpoint('inventory');

    tables.product_groups.columns.purchase_date = column('date', true);
    tables.purchase_batches.columns.date = column('date', true);
    target.data.product_groups.forEach(row => {
      row.purchase_date = normalizeIsoDate(row.purchase_date, 'product_groups.purchase_date');
    });
    target.data.purchase_batches.forEach(row => {
      row.date = normalizeIsoDate(row.date, 'purchase_batches.date');
    });
    checkpoint('dates');

    tables.product_variants.columns.private_manual_adjustment = column('integer', true);
    tables.product_variants.columns.purchased_manual_adjustment = column('integer', true);
    checkpoint('adjustments');

    tables.sales_orders.columns.buyer_name = column('text', false);
    tables.sales_orders.columns.version = column('integer', false, '1');
    tables.sales_order_items.columns.version = column('integer', false, '1');
    tables.sales_order_items.columns.price = column('numeric', true, '0');
    tables.sales_order_items.columns.amount = column('numeric', true, '0');
    target.data.sales_orders.forEach(row => { row.version = 1; });
    target.data.sales_order_items.forEach(row => { row.version = 1; });
    checkpoint('sales');

    target.schema.foreignKeys.purchase_batches_product_group_id_fkey.onDelete = 'CASCADE';
    target.schema.foreignKeys.private_orders_product_group_id_fkey.onDelete = 'CASCADE';
    checkpoint('foreign-keys');

    tables.sales_orders.indexes.idx_sales_orders_order_number.unique = false;
    delete tables.sales_orders.indexes.idx_sales_orders_deleted_at;
    delete tables.sales_order_items.indexes.idx_sales_order_items_deleted_at;
    checkpoint('indexes');

    const generatedIds = target.data.inventory_items.map(row => row.id);
    if (generatedIds.some(value => !value) || new Set(generatedIds).size !== generatedIds.length) {
      throw new Error('STAGING_PARITY_POSTFLIGHT:inventory_identity_invalid');
    }
    return target;
  } catch (error) {
    replaceObject(target, before);
    throw error;
  }
}

export function toRefreshToolingSchema(fixture) {
  const columns = [];
  const constraints = [];
  for (const [tableName, table] of Object.entries(fixture.schema.tables)) {
    for (const [columnName, definition] of Object.entries(table.columns)) {
      columns.push({ tableName, columnName, ...definition });
    }
    table.primaryKey.forEach((columnName, index) => constraints.push({
      tableName,
      constraintName: `${tableName}_pkey`,
      constraintType: 'PRIMARY KEY',
      columnName,
      ordinalPosition: index + 1,
    }));
    table.uniques.forEach(unique => unique.columns.forEach((columnName, index) => constraints.push({
      tableName,
      constraintName: unique.name,
      constraintType: 'UNIQUE',
      columnName,
      ordinalPosition: index + 1,
    })));
  }
  const foreignKeys = Object.entries(fixture.schema.foreignKeys).map(([constraintName, foreignKey]) => ({
    constraintName,
    ...foreignKey,
    parentSchema: 'public',
  }));
  return { publicTables: Object.keys(fixture.schema.tables), columns, constraints, foreignKeys };
}
