import type { ProductGroup } from './db';
import {
  createApplyAuditBundle,
  createAtomicRollbackResult,
  createVerifiedMapping,
  isActiveVerifiedMapping,
  mappingVerifiesCandidate,
  planAtomicClosingDateApply,
  revokeVerifiedMapping,
  sameSourceProduct,
} from './closingDateResolutionDomain';
import type {
  ApplyAuditBundle,
  ApplyResolutionBatchResponse,
  AtomicTransactionResult,
  ResolutionApplySelection,
  ResolutionBatch,
  VerifiedMappingRegistryEntry,
} from './closingDateResolutionDomain';
import { assertClosingDateWorkbenchUiAccess } from './closingDateWorkbenchAccess';
import { NEXT_SANDBOX_INDEXED_DB_NAME } from './testSandboxEnvironment';

const PRODUCT_GROUPS_KEY = 'erp_product_groups';
const MAIN_STORE_NAME = 'kv';
export const CLOSING_DATE_ATOMIC_MAPPINGS_KEY = 'closing_date_workbench_verified_mappings_v1';
export const CLOSING_DATE_ATOMIC_AUDITS_KEY = 'closing_date_workbench_apply_audits_v1';

export type ClosingDateAtomicApplyFaultPoint =
  | 'BEFORE_PRODUCT_GROUPS_PUT'
  | 'AFTER_PRODUCT_GROUPS_PUT'
  | 'AFTER_VERIFIED_MAPPINGS_PUT'
  | 'AFTER_APPLY_AUDIT_PUT';

export interface ClosingDateAtomicApplyOptions {
  resolutionBatch: ResolutionBatch;
  selections: readonly ResolutionApplySelection[];
  applyBatchId: string;
  applyItemIds: readonly string[];
  idempotencyKey: string;
  databaseName?: string;
  appliedAt: string;
  faultInjector?: (point: ClosingDateAtomicApplyFaultPoint) => void;
}

export interface ClosingDateApplyIdentity {
  applyBatchId: string;
  applyItemIds: readonly string[];
  idempotencyKey: string;
}

const fnv1a32 = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export function createClosingDateApplyIdentity(
  resolutionBatch: ResolutionBatch,
  selections: readonly ResolutionApplySelection[],
): ClosingDateApplyIdentity {
  const signature = selections.map(selection => [
    selection.result.id,
    selection.selectedCandidateId ?? selection.result.selectedCandidateId,
    selection.mappingId ?? selection.pendingMapping?.id ?? selection.result.selectedMappingId ?? null,
  ]);
  const hash = fnv1a32(JSON.stringify([resolutionBatch.id, signature]));
  return {
    applyBatchId: `closing-date-apply:${resolutionBatch.id}:${hash}`,
    applyItemIds: selections.map((selection, index) => (
      `closing-date-apply-item:${hash}:${index}:${fnv1a32(selection.result.id)}`
    )),
    idempotencyKey: `closing-date-apply-idempotency:${resolutionBatch.id}:${hash}`,
  };
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

const storedArray = <T>(value: unknown, label: string): T[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} storage is malformed`);
  return value as T[];
};

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

class AtomicApplyAbortError extends Error {
  readonly pendingAudit: ApplyAuditBundle | null;

  constructor(
    message: string,
    pendingAudit: ApplyAuditBundle | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AtomicApplyAbortError';
    this.pendingAudit = pendingAudit;
  }
}

const resolvePendingMappings = (
  selections: readonly ResolutionApplySelection[],
  storedMappings: readonly VerifiedMappingRegistryEntry[],
  appliedAt: string,
): { selections: ResolutionApplySelection[]; mappings: VerifiedMappingRegistryEntry[] } => {
  let mappings = storedMappings.map(mapping => createVerifiedMapping(mapping));
  const resolvedSelections = selections.map(selection => {
    if (!selection.pendingMapping) return selection;
    const candidateId = selection.selectedCandidateId ?? selection.result.selectedCandidateId;
    const candidate = selection.result.candidates.find(item => item.id === candidateId);
    const pending = createVerifiedMapping(selection.pendingMapping);
    if (!candidate || !mappingVerifiesCandidate(pending, candidate, selection.result.erpProductGroupId)) {
      throw new Error(`Pending Verified Mapping does not match selected candidate: ${selection.result.id}`);
    }
    const existing = mappings.find(mapping => (
      isActiveVerifiedMapping(mapping)
      && mapping.erpProductGroupId === pending.erpProductGroupId
      && sameSourceProduct(mapping.source, pending.source)
    ));
    const persisted = existing ?? pending;
    if (!existing) {
      mappings = mappings.map(mapping => (
        isActiveVerifiedMapping(mapping)
        && mapping.erpProductGroupId === pending.erpProductGroupId
          ? revokeVerifiedMapping(mapping, appliedAt, 'SUPERSEDED_BY_MANUAL_SELECTION')
          : mapping
      ));
      mappings.push(pending);
    }
    return {
      ...selection,
      selectedCandidateId: candidate.id,
      mappingId: persisted.id,
      pendingMapping: existing ? null : persisted,
    };
  });
  return { selections: resolvedSelections, mappings };
};

const responseFromAudit = (audit: ApplyAuditBundle): ApplyResolutionBatchResponse => ({
  applyBatchId: audit.batch.id,
  resolutionBatchId: audit.batch.resolutionBatchId,
  status: audit.batch.status,
  atomicTransactionResult: audit.batch.atomicTransactionResult,
  audit,
});

const runAtomicApplyTransaction = async (
  options: ClosingDateAtomicApplyOptions,
  databaseName: string,
  transactionId: string,
): Promise<ApplyResolutionBatchResponse> => {
  const database = await openNextDatabase(databaseName);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(MAIN_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(MAIN_STORE_NAME);
      const groupsRequest = store.get(PRODUCT_GROUPS_KEY) as IDBRequest<ProductGroup[] | undefined>;
      const mappingsRequest = store.get(CLOSING_DATE_ATOMIC_MAPPINGS_KEY) as IDBRequest<
        VerifiedMappingRegistryEntry[] | undefined
      >;
      const auditsRequest = store.get(CLOSING_DATE_ATOMIC_AUDITS_KEY) as IDBRequest<
        ApplyAuditBundle[] | undefined
      >;
      let pendingReads = 3;
      let failure: unknown;
      let outcome: ApplyResolutionBatchResponse | null = null;
      let pendingAudit: ApplyAuditBundle | null = null;

      const abort = (error: unknown): void => {
        failure = error;
        try {
          transaction.abort();
        } catch {
          // Transaction already reached a terminal state.
        }
      };
      const finishRead = (): void => {
        pendingReads -= 1;
        if (pendingReads !== 0 || failure) return;
        try {
          if (!Array.isArray(groupsRequest.result)) {
            throw new Error('Next Product Groups storage is missing or malformed');
          }
          const mappings = storedArray<VerifiedMappingRegistryEntry>(
            mappingsRequest.result,
            'Closing Date Verified Mapping',
          );
          const audits = storedArray<ApplyAuditBundle>(
            auditsRequest.result,
            'Closing Date Apply Audit',
          );
          const existingAudit = audits.find(audit => (
            audit.batch.idempotencyKey === options.idempotencyKey
          ));
          if (existingAudit) {
            if (existingAudit.batch.id !== options.applyBatchId) {
              throw new Error(`Closing Date apply idempotency conflict: ${options.idempotencyKey}`);
            }
            outcome = responseFromAudit(existingAudit);
            return;
          }

          const resolved = resolvePendingMappings(options.selections, mappings, options.appliedAt);
          const plan = planAtomicClosingDateApply({
            resolutionBatchId: options.resolutionBatch.id,
            selections: resolved.selections,
            currentProducts: currentStates(groupsRequest.result),
          });
          pendingAudit = createApplyAuditBundle({
            applyBatchId: options.applyBatchId,
            applyItemIds: options.applyItemIds,
            idempotencyKey: options.idempotencyKey,
            plan,
            createdAt: options.appliedAt,
          });
          if (plan.status === 'CONFLICT') {
            outcome = responseFromAudit(pendingAudit);
            return;
          }

          const transactionResult: AtomicTransactionResult = {
            outcome: 'COMMITTED',
            atomic: true,
            committed: true,
            rolledBack: false,
            writeCount: plan.writeIntents.length,
            transactionId,
          };
          const appliedAudit = finalizeAppliedAudit(pendingAudit, transactionResult, options.appliedAt);
          const intentByGroup = new Map(plan.writeIntents.map(intent => [intent.erpProductGroupId, intent]));
          const nextGroups = groupsRequest.result.map(group => {
            const intent = intentByGroup.get(group.id);
            return intent
              ? { ...group, closing_date: formatStoredClosingDate(intent.afterClosingDate) }
              : group;
          });

          options.faultInjector?.('BEFORE_PRODUCT_GROUPS_PUT');
          const writes = [
            {
              request: store.put(nextGroups, PRODUCT_GROUPS_KEY),
              point: 'AFTER_PRODUCT_GROUPS_PUT' as const,
            },
            {
              request: store.put(resolved.mappings, CLOSING_DATE_ATOMIC_MAPPINGS_KEY),
              point: 'AFTER_VERIFIED_MAPPINGS_PUT' as const,
            },
            {
              request: store.put([...audits, appliedAudit], CLOSING_DATE_ATOMIC_AUDITS_KEY),
              point: 'AFTER_APPLY_AUDIT_PUT' as const,
            },
          ];
          let completedWrites = 0;
          writes.forEach(({ request, point }) => {
            request.onerror = () => abort(request.error ?? new Error(`Atomic write failed: ${point}`));
            request.onsuccess = () => {
              try {
                options.faultInjector?.(point);
                completedWrites += 1;
                if (completedWrites === writes.length) outcome = responseFromAudit(appliedAudit);
              } catch (error) {
                abort(error);
              }
            };
          });
        } catch (error) {
          abort(error);
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
      transaction.onabort = () => {
        const reason = failure instanceof Error
          ? failure.message
          : transaction.error?.message ?? 'Atomic closing-date transaction rolled back';
        reject(new AtomicApplyAbortError(reason, pendingAudit, {
          cause: failure instanceof Error ? failure : transaction.error,
        }));
      };
      [groupsRequest, mappingsRequest, auditsRequest].forEach(request => {
        request.onerror = () => abort(request.error ?? new Error('Atomic apply read failed'));
        request.onsuccess = finishRead;
      });
    });
  } finally {
    database.close();
  }
};

export async function findAtomicClosingDateVerifiedMappings(
  erpProductGroupIds: readonly string[],
  databaseName = NEXT_SANDBOX_INDEXED_DB_NAME,
): Promise<readonly VerifiedMappingRegistryEntry[]> {
  if (erpProductGroupIds.length === 0) return [];
  const wanted = new Set(erpProductGroupIds);
  const database = await openNextDatabase(databaseName);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(MAIN_STORE_NAME, 'readonly');
      const request = transaction.objectStore(MAIN_STORE_NAME).get(
        CLOSING_DATE_ATOMIC_MAPPINGS_KEY,
      ) as IDBRequest<VerifiedMappingRegistryEntry[] | undefined>;
      request.onsuccess = () => {
        try {
          resolve(storedArray<VerifiedMappingRegistryEntry>(request.result, 'Closing Date Verified Mapping')
            .map(mapping => createVerifiedMapping(mapping))
            .filter(mapping => isActiveVerifiedMapping(mapping) && wanted.has(mapping.erpProductGroupId)));
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to read atomic Verified Mappings'));
    });
  } finally {
    database.close();
  }
}

export async function getAtomicClosingDateApplyAudits(
  databaseName = NEXT_SANDBOX_INDEXED_DB_NAME,
): Promise<readonly ApplyAuditBundle[]> {
  const database = await openNextDatabase(databaseName);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(MAIN_STORE_NAME, 'readonly');
      const request = transaction.objectStore(MAIN_STORE_NAME).get(
        CLOSING_DATE_ATOMIC_AUDITS_KEY,
      ) as IDBRequest<ApplyAuditBundle[] | undefined>;
      request.onsuccess = () => {
        try {
          resolve(storedArray<ApplyAuditBundle>(request.result, 'Closing Date Apply Audit'));
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to read atomic Apply Audits'));
    });
  } finally {
    database.close();
  }
}

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

  try {
    return await runAtomicApplyTransaction(options, databaseName, transactionId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const rollback = createAtomicRollbackResult(reason, transactionId);
    if (!(error instanceof AtomicApplyAbortError) || !error.pendingAudit) throw error;
    const rolledBackAudit = finalizeRolledBackAudit(error.pendingAudit, rollback, reason);
    return {
      applyBatchId: rolledBackAudit.batch.id,
      resolutionBatchId: rolledBackAudit.batch.resolutionBatchId,
      status: rolledBackAudit.batch.status,
      atomicTransactionResult: rolledBackAudit.batch.atomicTransactionResult,
      audit: rolledBackAudit,
    };
  }
}
