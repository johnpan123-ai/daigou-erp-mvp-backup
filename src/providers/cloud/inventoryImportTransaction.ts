import type { CloudFieldMutationOperation } from './cloudFieldCas';
import { deterministicCloudUuid } from './cloudEntityPayload';

/** Stored in the existing compressed journal BEFORE dispatch. Never reconstruct
 * a retry from current rows: the expected fields are the original CAS intent. */
export interface InventoryImportIntent {
  key: string;
  request: {
    family: 'inventory_import';
    batchId: string;
    restoreEpoch: number;
    operations: CloudFieldMutationOperation[];
  };
}
export type InventoryCommitOutcome = 'COMMITTED' | 'NOT_COMMITTED' | 'UNKNOWN';
export const importInventoryKey = (batchId: string) => deterministicCloudUuid('buyanime-import-inventory:' + batchId);
export function inventoryImportIntent(batchId: string, restoreEpoch: number, operations: CloudFieldMutationOperation[]): InventoryImportIntent {
  return { key: importInventoryKey(batchId), request: { family: 'inventory_import', batchId, restoreEpoch, operations } };
}
export function validInventoryIntent(intent: InventoryImportIntent, batchId: string, epoch: number | undefined): boolean {
  return intent.key === importInventoryKey(batchId) && intent.request?.family === 'inventory_import'
    && intent.request.batchId === batchId && intent.request.restoreEpoch === epoch
    && Number.isSafeInteger(epoch) && Number(epoch) >= 0
    && Array.isArray(intent.request.operations) && intent.request.operations.length <= 10000
    && new Set(intent.request.operations.map(op => op.id)).size === intent.request.operations.length
    && intent.request.operations.every(op => ['create', 'patch'].includes(op.kind));
}
