import pg from 'pg';
import {
  STAGING_PROJECT_REF,
  assertConnectionTargetsProject,
} from './staging-refresh/policy.mjs';

const DEFAULT_SKUS = Object.freeze([
  'FT-20260913-F1E-8M3K',
  'FT-20260913-LUNA-7Q4-SKU',
]);

const requestedSkus = process.argv.slice(2);
const skus = requestedSkus.length > 0 ? requestedSkus : DEFAULT_SKUS;
if (skus.some(sku => !/^[A-Z0-9-]{1,100}$/u.test(sku))) {
  throw new Error('STAGING_INVENTORY_READBACK_SKU_INVALID');
}

const connectionUrl = String(process.env.STAGING_REFRESH_TARGET_DATABASE_URL || '').trim();
assertConnectionTargetsProject(
  connectionUrl,
  STAGING_PROJECT_REF,
  'Inventory SELECT-only readback',
);
const clientUrl = new URL(connectionUrl);
// Keep TLS required when the managed inspection proxy provides its own chain.
clientUrl.searchParams.set('uselibpqcompat', 'true');

const client = new pg.Client({
  connectionString: clientUrl.toString(),
  application_name: 'hippo_inventory_select_only_readback',
  connectionTimeoutMillis: 15_000,
});

await client.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const transactionMode = await client.query('SHOW transaction_read_only');
  if (transactionMode.rows[0]?.transaction_read_only !== 'on') {
    throw new Error('STAGING_INVENTORY_READBACK_TRANSACTION_NOT_READ_ONLY');
  }

  const kpi = await client.query(`
    WITH active_inventory AS (
      SELECT *
      FROM public.inventory_items
      WHERE deleted_at IS NULL
    ), inventory_groups AS (
      SELECT DISTINCT COALESCE(NULLIF(normalized_product_title, ''), product_title) AS title_key
      FROM active_inventory
    ), active_groups AS (
      SELECT *
      FROM public.product_groups
      WHERE deleted_at IS NULL
    )
    SELECT
      (SELECT count(*)::int FROM active_inventory) AS inventory_rows,
      (SELECT count(*)::int FROM inventory_groups) AS inventory_kpi_total,
      (SELECT count(*)::int
        FROM inventory_groups inventory_group
        WHERE EXISTS (
          SELECT 1
          FROM active_groups product_group
          WHERE COALESCE(NULLIF(product_group.normalized_title, ''), product_group.title)
            = inventory_group.title_key
        )) AS joined_kpi,
      (SELECT count(*)::int
        FROM inventory_groups inventory_group
        WHERE NOT EXISTS (
          SELECT 1
          FROM active_groups product_group
          WHERE COALESCE(NULLIF(product_group.normalized_title, ''), product_group.title)
            = inventory_group.title_key
        )) AS unjoined_kpi
  `);

  const inventory = await client.query(`
    SELECT
      id,
      inventory_key,
      myacg_item_code,
      product_title,
      normalized_product_title,
      raw_variant_name,
      final_price,
      myacg_available_quantity,
      myacg_sold_quantity,
      deleted_at
    FROM public.inventory_items
    WHERE myacg_item_code = ANY($1::text[])
    ORDER BY myacg_item_code, inventory_key
  `, [skus]);

  const variants = await client.query(`
    SELECT
      requested.sku AS myacg_item_code,
      count(variant.*) FILTER (WHERE variant.deleted_at IS NULL)::int AS active_count,
      count(variant.*)::int AS total_count
    FROM unnest($1::text[]) requested(sku)
    LEFT JOIN public.product_variants variant ON variant.myacg_item_code = requested.sku
    GROUP BY requested.sku
    ORDER BY requested.sku
  `, [skus]);

  const groups = await client.query(`
    WITH requested AS (
      SELECT sku
      FROM unnest($1::text[]) requested_sku(sku)
    ), wanted AS (
      SELECT
        requested.sku AS myacg_item_code,
        COALESCE(NULLIF(inventory.normalized_product_title, ''), inventory.product_title) AS title_key
      FROM requested
      LEFT JOIN public.inventory_items inventory ON inventory.myacg_item_code = requested.sku
    )
    SELECT
      wanted.myacg_item_code,
      count(product_group.*) FILTER (WHERE product_group.deleted_at IS NULL)::int AS active_count,
      count(product_group.*)::int AS total_count
    FROM wanted
    LEFT JOIN public.product_groups product_group
      ON COALESCE(NULLIF(product_group.normalized_title, ''), product_group.title) = wanted.title_key
    GROUP BY wanted.myacg_item_code
    ORDER BY wanted.myacg_item_code
  `, [skus]);

  const catalogImports = await client.query(`
    SELECT
      latest_catalog_import_id,
      count(*)::int AS inventory_rows,
      count(DISTINCT COALESCE(NULLIF(normalized_product_title, ''), product_title))::int AS inventory_kpi_total,
      max(catalog_last_seen_at) AS last_seen_at
    FROM public.inventory_items
    WHERE deleted_at IS NULL
      AND latest_catalog_import_id IS NOT NULL
    GROUP BY latest_catalog_import_id
    ORDER BY max(catalog_last_seen_at) DESC NULLS LAST
    LIMIT 10
  `);

  console.log(JSON.stringify({
    status: 'STAGING_INVENTORY_SELECT_ONLY_READBACK_PASS',
    targetProjectRef: STAGING_PROJECT_REF,
    transactionReadOnly: true,
    kpi: kpi.rows[0],
    inventory: inventory.rows,
    groups: groups.rows,
    variants: variants.rows,
    recentCatalogImports: catalogImports.rows,
    operationCounts: { select: 6, write: 0 },
  }, null, 2));

  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
