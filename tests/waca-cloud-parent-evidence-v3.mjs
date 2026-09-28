import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, cacheDir: join(tmpdir(), 'waca-v3-parent-vite'),
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { toCloudFieldRow } = await vite.ssrLoadModule('/src/providers/cloud/cloudEntityPayload.ts');
  const { CLOUD_FIELD_ENTITY_CONTRACTS } = await vite.ssrLoadModule('/src/providers/cloud/cloudFieldCas.ts');
  const { linksFromMyAcgInventory } = await vite.ssrLoadModule('/src/waca/masterReference.ts');
  const inventory = {
    inventory_key: 'test::G001::figure', myacg_item_code: 'G001', myacg_parent_code: 'GP001',
    product_title: 'Test', raw_variant_name: 'figure', listing_type: '', final_price: 0,
    myacg_available_quantity: 0, myacg_sold_quantity: 0, myacg_listed_at: '',
  };
  const row = toCloudFieldRow('inventory_items', inventory);
  assert.equal(row.myacg_parent_code, 'GP001');
  assert.ok(CLOUD_FIELD_ENTITY_CONTRACTS.inventory_items.create.includes('myacg_parent_code'));
  assert.ok(CLOUD_FIELD_ENTITY_CONTRACTS.inventory_items.patch.includes('myacg_parent_code'));
  const variants = [{ id: 'variant-1', product_group_id: 'group-1', myacg_item_code: 'G001' }];
  const evidence = linksFromMyAcgInventory([{ ...inventory, myacg_parent_code: row.myacg_parent_code }],
    variants, 'catalog.xls', '2026-09-28T00:00:00Z');
  assert.equal(evidence.links[0].mainCode, 'GP001');
  assert.equal(evidence.links[0].childCode, 'G001');
  const page = readFileSync('src/pages/Inventory.tsx', 'utf8');
  assert.match(page, /currentMode === 'next' \|\| cloudMode/u);
  assert.match(page, /commitNextWacaSnapshot\(\{ \.\.\.waca, masterLinks \}/u);
  const provider = readFileSync('src/providers/cloud/supabaseProvider.ts', 'utf8');
  assert.equal((provider.match(/myacg_parent_code: r\.myacg_parent_code \|\| undefined/gu) ?? []).length, 2);
  assert.match(provider, /async getAuthoritativeWacaVariants\(\)/u);
  assert.match(readFileSync('src/pages/WacaIntegration.tsx', 'utf8'),
    /const savedVariants = await dataProvider\.getAuthoritativeWacaVariants\(\)/u);
  const sql = readFileSync('supabase/sql/046_waca_myacg_parent_evidence.sql', 'utf8');
  assert.match(sql, /alter table public\.inventory_items add column if not exists myacg_parent_code text/u);
  console.log('PASS Cloud BuyAnime GP evidence survives payload, CAS, reload, and WACA matching');
} finally { await vite.close(); }
