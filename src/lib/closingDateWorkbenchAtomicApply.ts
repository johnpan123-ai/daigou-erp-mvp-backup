import type { ProductGroup } from './db';
import {
  createApplyAuditBundle,
  createAtomicRollbackResult,
  planAtomicClosingDateApply,
} from './closingDateResolutionDomain';
import type {
  ApplyAuditBundle,
  ApplyResolutionBatchResponse,
  AtomicApplyPlan,
  AtomicTransactionResult,
  ResolutionApplySelection,
  ResolutionBatch,
} from './closingDateResolutionDomain';
import type { ClosingDateResolutionSidecarRepository } from './closingDateResolutionSidecarRepository';
import { assertClosingDateWorkbenchUiAccess } from './closingDateWorkbenchAccess';
import { NEXT_SANDBOX_INDEXED_DB_NAME } from './testSandboxEnvironment';

const PRODUCT_GROUPS_KEY = 'erp_product_groups';
const MAIN_STORE_NAME = 'kv';

export type ClosingDateAtomicApplyFaultPoint =
  | 'BEFORE_PRODUCT_GROUPS_PUT'
  | 'AFTER_PRODUCT_GROUPS_PUT';

export interface ClosingDateAtomicApplyOptions {
  repository: ClosingDateResolutionSidecarRepository;
  resolutionBatch: ResolutionBatch;
  selections: readonly ResolutionApplySelection[];
  applyBatchId: string;
  applyItemIds: readonly string[];
  idempotencyKey: string;
  databaseName?: string;
  appliedAt: string;
  faultInjector?: (point: ClosingDateAtomicApplyFaultPoint) => void;
}

interface MainTransactionOutcome {
  plan: AtomicApplyPlan;
  transactionResult: AtomicTransactionResult;
}

const openNextDatabase = (databaseName: string): Promise<IDBDatabase> => new Promise(
  (resolve, reject) => {
    if (!databaseName.startsWith(NEXT_SANDBOX_INDEXED_DB_NAME)) {
      reject(new Error(`Refusing non-Next ERP database: ${databaseName}`));
      return;
    }
    const request = window.indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MAIN_STORE_NAME)) {
        request.result.createObjectStore(MAIN_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open Next ERP database'));
    request.onblocked = () => reject(new Error(`Next ERP database open blocked: ${databaseName}`));
  },
);

const currentStates = (groups: readonly ProductGroup[]) => groups.map(group => ({
  erpProductGroupId: group.id,
  updatedAt: group.updated_at ?? null,
  closingDate: group.closing_date ?? null,
}));

const formatStoredClosingDate = (value: string): string => value.replace(/-/g, '/');

const finalizeAppliedAudit = (
  pending: ApplyAuditBundle,
  transactionResult: AtomicTransactionResult,
  appliedAt: string,
): ApplyAuditBundle => ({
  batch: {
    ...pending.batch,
    status: 'APPLIED',
    appliedCount: pending.items.length,
    atomicTransactionResult: transactionResult,
    conflictCount: 0,
    rollbackInformation: null,
    appliedAt,
  },
  items: pending.items.map(item => ({
    ...item,
    result: 'APPLIED',
    conflictInformation: [],
    appliedAt,
  })),
});

const finalizeRolledBackAudit = (
  pending: ApplyAuditBundle,
  transactionResult: AtomicTransactionResult,
  reason: string,
): ApplyAuditBundle => ({
  batch: {
    ...pending.batch,
    status: 'ROLLED_BACK',
    appliedCount: 0,
    atomicTransactionResult: transactionResult,
    rollbackInformation: reason,
    appliedAt: null,
  },
  items: pending.items.map(item => ({
    ...item,
    result: 'ROLLED_BACK',
    appliedAt: null,
  })),
});

const runAtomicProductGroupTransaction = async (
  databaseName: string,
  resolutionBatchId: string,
  selections: readonly ResolutionApplySelection[],
  transactionId: string,
  faultInjector?: ClosingDateAtomicApplyOptions['faultInjector'],
): Promise<MainTransactionOutcome> => {
  const database = await openNextDatabase(databaseName);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(MAIN_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(MAIN_STORE_NAME);
      const read = store.get(PRODUCT_GROUPS_KEY) as IDBRequest<ProductGroup[] | undefined>;
      let outcome: MainTransactionOutcome | null = null;
      let failure: unknown;

      const abort = (error: unknown): void => {
        failure = error;
        try {
          transaction.abort();
        } catch {
          // Transaction already reached a terminal state.
        }
      };

      transaction.oncomplete = () => {
        if (!outcome) {
          reject(new Error('Atomic closing-date transaction completed without an outcome'));
          return;
        }
        resolve(outcome);
      };
      transaction.onerror = () => {
        if (!failure && transaction.error) failure = transaction.error;
      };
      transaction.onabort = () => reject(
        failure instanceof Error
          ? failure
          : transaction.error ?? new Error('Atomic closing-date transaction rolled back'),
      );
      read.onerror = () => abort(read.error ?? new Error('Unable to read Next Product Groups'));
      read.onsuccess = () => {
        try {
          if (!Array.isArray(read.result)) {
            throw new Error('Next Product Groups storage is missing or malformed');
          }
          const groups = read.result;
          const plan = planAtomicClosingDateApply({
            resolutionBatchId,
            selections,
            currentProducts: currentStates(groups),
          });
          if (plan.status === 'CONFLICT') {
            outcome = { plan, transactionResult: plan.transactionResult };
            return;
          }

          const intentByGroup = new Map(plan.writeIntents.map(intent => [intent.erpProductGroupId, intent]));
          const nextGroups = groups.map(group => {
            const intent = intentByGroup.get(group.id);
            return intent
              ? { ...group, closing_date: formatStoredClosingDate(intent.afterClosingDate) }
              : group;
          });
          faultInjector?.('BEFORE_PRODUCT_GROUPS_PUT');
          const write = store.put(nextGroups, PRODUCT_GROUPS_KEY);
          write.onerror = () => abort(write.error ?? new Error('Unable to write Next Product Groups'));
          write.onsuccess = () => {
            try {
              faultInjector?.('AFTER_PRODUCT_GROUPS_PUT');
              const transactionResult: AtomicTransactionResult = {
                outcome: 'COMMITTED',
                atomic: true,
                committed: true,
                rolledBack: false,
                writeCount: plan.writeIntents.length,
                transactionId,
              };
              outcome = { plan, transactionResult };
            } catch (error) {
              abort(error);
            }
          };
        } catch (error) {
          abort(error);
        }
      };
    });
  } finally {
    database.close();
  }
};

export async function applyClosingDateResolutionBatch(
  options: ClosingDateAtomicApplyOptions,
): Promise<ApplyResolutionBatchResponse> {
  assertClosingDateWorkbenchUiAccess();
  if (options.resolutionBatch.status !== 'COMPLETED') {
    throw new Error(`Only a completed resolution batch can be applied: ${options.resolutionBatch.status}`);
  }
  if (options.selections.length === 0) throw new Error('No closing-date resolution was selected');
  if (new Set(options.selections.map(selection => selection.result.erpProductGroupId)).size !== options.selections.length) {
    throw new Error('Apply request contains duplicate ProductGroup IDs');
  }
  if (options.applyItemIds.length !== options.selections.length) {
    throw new Error('Every apply selection requires one audit item ID');
  }
  for (const selection of options.selections) {
    if (
      selection.result.batchId !== options.resolutionBatch.id
      || selection.result.snapshotVersion !== options.resolutionBatch.snapshotVersion
      || selection.result.ruleVersion !== options.resolutionBatch.ruleVersion
    ) {
      throw new Error(`Resolution result does not belong to the selected batch: ${selection.result.id}`);
    }
  }

  const databaseName = options.databaseName ?? NEXT_SANDBOX_INDEXED_DB_NAME;
  const transactionId = `next-closing-date:${options.applyBatchId}`;

  // First create a durable PENDING/CONFLICT audit from a readonly snapshot. The
  // actual write transaction repeats every stale check before its single put.
  const database = await openNextDatabase(databaseName);
  let initialPlan: AtomicApplyPlan;
  try {
    const groups = await new Promise<ProductGroup[]>((resolve, reject) => {
      const transaction = database.transaction(MAIN_STORE_NAME, 'readonly');
      const request = transaction.objectStore(MAIN_STORE_NAME).get(PRODUCT_GROUPS_KEY) as IDBRequest<
        ProductGroup[] | undefined
      >;
      request.onsuccess = () => {
        if (Array.isArray(request.result)) resolve(request.result);
        else reject(new Error('Next Product Groups storage is missing or malformed'));
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to read Next Product Groups'));
    });
    initialPlan = planAtomicClosingDateApply({
      resolutionBatchId: options.resolutionBatch.id,
      selections: options.selections,
      currentProducts: currentStates(groups),
    });
  } finally {
    database.close();
  }

  const initialAudit = createApplyAuditBundle({
    applyBatchId: options.applyBatchId,
    applyItemIds: options.applyItemIds,
    idempotencyKey: options.idempotencyKey,
    plan: initialPlan,
    createdAt: options.appliedAt,
  });
  const persisted = await options.repository.saveApplyAudit(initialAudit);
  if (!persisted.created) {
    return {
      applyBatchId: persisted.audit.batch.id,
      resolutionBatchId: persisted.audit.batch.resolutionBatchId,
      status: persisted.audit.batch.status,
      atomicTransactionResult: persisted.audit.batch.atomicTransactionResult,
      audit: persisted.audit,
    };
  }
  if (initialPlan.status === 'CONFLICT') {
    return {
      applyBatchId: initialAudit.batch.id,
      resolutionBatchId: initialAudit.batch.resolutionBatchId,
      status: initialAudit.batch.status,
      atomicTransactionResult: initialAudit.batch.atomicTransactionResult,
      audit: initialAudit,
    };
  }

  let transaction: MainTransactionOutcome;
  try {
    transaction = await runAtomicProductGroupTransaction(
      databaseName,
      options.resolutionBatch.id,
      options.selections,
      transactionId,
      options.faultInjector,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const rollback = createAtomicRollbackResult(reason, transactionId);
    const rolledBackAudit = finalizeRolledBackAudit(initialAudit, rollback, reason);
    await options.repository.replaceApplyAudit(rolledBackAudit);
    return {
      applyBatchId: rolledBackAudit.batch.id,
      resolutionBatchId: rolledBackAudit.batch.resolutionBatchId,
      status: rolledBackAudit.batch.status,
      atomicTransactionResult: rolledBackAudit.batch.atomicTransactionResult,
      audit: rolledBackAudit,
    };
  }

  if (transaction.plan.status === 'CONFLICT') {
    const conflictAudit = createApplyAuditBundle({
      applyBatchId: options.applyBatchId,
      applyItemIds: options.applyItemIds,
      idempotencyKey: options.idempotencyKey,
      plan: transaction.plan,
      createdAt: options.appliedAt,
    });
    await options.repository.replaceApplyAudit(conflictAudit);
    return {
      applyBatchId: conflictAudit.batch.id,
      resolutionBatchId: conflictAudit.batch.resolutionBatchId,
      status: conflictAudit.batch.status,
      atomicTransactionResult: conflictAudit.batch.atomicTransactionResult,
      audit: conflictAudit,
    };
  }

  const appliedAudit = finalizeAppliedAudit(
    initialAudit,
    transaction.transactionResult,
    options.appliedAt,
  );
  try {
    await options.repository.replaceApplyAudit(appliedAudit);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `結單日主資料已 atomic 提交，但 Apply Audit 完成標記失敗；請停止重試並檢查 PENDING audit：${reason}`,
    );
  }
  return {
    applyBatchId: appliedAudit.batch.id,
    resolutionBatchId: appliedAudit.batch.resolutionBatchId,
    status: appliedAudit.batch.status,
    atomicTransactionResult: appliedAudit.batch.atomicTransactionResult,
    audit: appliedAudit,
  };
}
