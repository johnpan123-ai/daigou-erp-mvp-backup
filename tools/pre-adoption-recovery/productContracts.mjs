import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

/**
 * Load the product's existing registries and validators instead of maintaining
 * a second recovery-only resource list. The returned values are detached from
 * Vite before the temporary module runner is closed.
 */
export async function loadProductContracts(root = process.cwd()) {
  const vite = await createServer({
    root,
    configFile: false,
    cacheDir: join(tmpdir(), 'erp2-pre-adoption-recovery-v1-vite'),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const registryModule = await vite.ssrLoadModule('/src/lib/durableResourceRegistry.ts');
    const legacyModule = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreLegacySnapshot.ts');
    const relationModule = await vite.ssrLoadModule('/src/providers/cloud/cloudRestoreRelations.ts');
    const deadlineModule = await vite.ssrLoadModule('/src/lib/closingDateSidecarBackup.ts');
    const deadlineSchemaModule = await vite.ssrLoadModule('/src/lib/closingDateResolutionSidecarSchema.ts');
    return {
      durableResources: registryModule.DURABLE_RESOURCE_REGISTRY.map(row => ({ ...row })),
      buildLegacyCloudRestoreManifest: legacyModule.buildLegacyCloudRestoreManifest,
      cloudRestoreRelations: relationModule.CLOUD_RESTORE_RELATIONS.map(row => ({ ...row })),
      validateDeadlineDurableBackup: deadlineModule.validateDeadlineDurableBackup,
      deadlineDatabaseName: deadlineSchemaModule.CLOUD_CLOSING_DATE_SIDECAR_DB_NAME,
      deadlineStoreNames: Object.fromEntries(Object.entries(deadlineModule.DEADLINE_DURABLE_BACKUP_KEYS)),
    };
  } finally {
    await vite.close();
  }
}
