import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const vite = await createServer({ configFile: false, cacheDir: join(tmpdir(), 'waca-v3-registry-vite'),
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { RESOURCE_CLASSIFICATION } = await vite.ssrLoadModule('/src/lib/durableResourceRegistry.ts');
  const { CLOUD_RESTORE_TABLES } = await vite.ssrLoadModule('/src/providers/cloud/cloudAtomicRestore.ts');
  const { CLOSING_DATE_SIDECAR_STORES } = await vite.ssrLoadModule('/src/lib/closingDateResolutionSidecarSchema.ts');
  const a = RESOURCE_CLASSIFICATION.A_MUST_BACKUP_RESTORE;
  const b = RESOURCE_CLASSIFICATION.B_DERIVED_REBUILDABLE;
  const c = RESOURCE_CLASSIFICATION.C_EPHEMERAL_EXCLUDED;
  const keys = a.map(row => row.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate durable resource');
  for (const row of a) {
    assert.ok(row.backupKey && row.restore && row.cloud, `${row.key} lacks backup/restore/cloud classification`);
  }
  const cloud = a.filter(row => row.cloud !== 'deadline-sidecar-section').map(row => row.cloud).sort();
  assert.deepEqual(cloud, CLOUD_RESTORE_TABLES.map(([, table]) => table).sort(),
    'Cloud restore resource map must cover every durable Cloud table');
  const sidecar = new Set(Object.values(CLOSING_DATE_SIDECAR_STORES));
  const durableSidecar = a.filter(row => row.restore === 'deadline-sidecar').map(row =>
    CLOSING_DATE_SIDECAR_STORES[row.key === 'deadlineVerifiedMappings' ? 'verifiedMappings'
      : row.key === 'deadlineApplyBatches' ? 'applyBatches' : 'applyItems']);
  const classifiedSidecar = new Set([...durableSidecar,
    ...b.filter(row => row.key.startsWith('closing_date_')).map(row => row.key)]);
  assert.deepEqual([...classifiedSidecar].sort(), [...sidecar].sort(),
    'Every Deadline sidecar store must be explicitly classified');
  const dbSource = readFileSync('src/lib/db.ts', 'utf8');
  const collections = ['ATOMIC_IMPORT_COLLECTIONS', 'OPTIONAL_ATOMIC_IMPORT_COLLECTIONS'].flatMap(name => {
    const block = dbSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`));
    assert.ok(block, `${name} missing`);
    return [...block[1].matchAll(/\['([^']+)',\s*'[^']+'\]/g)].map(match => match[1]);
  });
  const expectedCore = a.filter(row => row.restore === 'core-idb' && row.key !== 'wacaCutoverState')
    .map(row => row.backupKey).sort();
  assert.deepEqual(collections.sort(), expectedCore, 'Local atomic import collections diverged from durable registry');
  const workbenchSource = readFileSync('src/lib/workbenchJsonBackup.ts', 'utf8');
  assert.match(workbenchSource, /data\.dashboardCategoryImages\s*=/u);
  assert.match(dbSource, /dashboardCategoryImages:\s*DASHBOARD_IMAGE_CATEGORY_KEYS\.map/u);
  assert.match(dbSource, /validateDashboardImageBackup\(data\.dashboardCategoryImages\)/u);
  const migrationSource = readFileSync('supabase/sql/044_waca_cloud_ledger.sql', 'utf8');
  const migratedWacaTables = [...migrationSource.matchAll(/create table public\.(waca_[a-z_]+)\s*\(/giu)]
    .map(match => match[1]).sort();
  assert.deepEqual(migratedWacaTables, a.filter(row => row.cloud.startsWith('waca_')).map(row => row.cloud).sort(),
    'Every newly created WACA Cloud table must be classified');
  assert.ok(c.includes('erp_waca_revision_v1') && c.includes('erp_last_import_backup'));
  console.log(`PASS durable registry: ${a.length} A, ${b.length} B, ${c.length} C, ${cloud.length} Cloud tables, ${sidecar.size} Deadline stores`);
} finally { await vite.close(); }
