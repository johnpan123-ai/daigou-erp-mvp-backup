import type { JapanPackage, JapanPackageItem } from '../../lib/db';
import { buildCloudCollectionMutationPlan, type CloudFieldMutationOperation } from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';

export const JAPAN_PACKAGE_TRANSACTION_RPC = 'erp_apply_japan_package_transaction';
const PENDING_INTENT_PREFIX = 'erp_japan_package_pending_intent_v1:';
const PENDING_RPC_PREFIX = 'erp_japan_package_pending_rpc_v1:';

export type JapanPackageTransactionType = 'create-package' | 'attach-items' | 'set-receiving';

export type JapanPackageTransactionCommand =
  | { idempotencyKey: string; transactionType: 'create-package'; package: JapanPackage }
  | { idempotencyKey: string; transactionType: 'attach-items'; packageId: string; items: JapanPackageItem[] }
  | { idempotencyKey: string; transactionType: 'set-receiving'; packageId: string; updates: Array<{ itemId: string; checked: boolean; checkedAt?: string }> };

export interface JapanPackageTransactionRpcRequest {
  transactionType: JapanPackageTransactionType;
  targetProjectRef: string;
  packageId: string;
  packageOperation: CloudFieldMutationOperation | null;
  itemOperations: CloudFieldMutationOperation[];
  expectedPackageVersion: number | null;
}

export interface JapanPackageTransactionSuccess {
  ok: true;
  transactionType: JapanPackageTransactionType;
  idempotencyKey: string;
  replayed: boolean;
  package: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  syncPending?: boolean;
}

export type JapanPackageSubmitFailureKind = 'server-rejected' | 'result-unknown' | 'committed-sync-pending';
const MESSAGES: Record<JapanPackageSubmitFailureKind, string> = {
  'server-rejected': '伺服器已拒絕這次日本包裹操作，請重新讀取資料後再確認。',
  'result-unknown': '日本包裹操作結果待查證，請勿重複操作。',
  'committed-sync-pending': '日本包裹操作已提交，畫面同步尚未完成，請勿重複操作。',
};

export class JapanPackageSubmitBoundaryError extends Error {
  readonly code = 'JAPAN_PACKAGE_SUBMIT_BOUNDARY';
  readonly kind: JapanPackageSubmitFailureKind;
  constructor(kind: JapanPackageSubmitFailureKind) {
    super(MESSAGES[kind]);
    this.kind = kind;
    this.name = 'JapanPackageSubmitBoundaryError';
  }
}

export const isJapanPackageSubmitBoundaryError = (value: unknown): value is JapanPackageSubmitBoundaryError => (
  value instanceof JapanPackageSubmitBoundaryError
);

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stableValue = (value: unknown): unknown => Array.isArray(value)
  ? value.map(stableValue)
  : isObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
    : value;
export const stableJapanPackagePayload = (value: unknown): string => JSON.stringify(stableValue(value));
const sessionStorageOrNull = (): StorageLike | null => {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
};

export class JapanPackageIntentCoordinator {
  private readonly memory = new Map<string, string>();
  private readonly storage: StorageLike | null;
  private readonly createUuid: () => string;
  constructor(
    storage: StorageLike | null = sessionStorageOrNull(),
    createUuid: () => string = () => crypto.randomUUID(),
  ) {
    this.storage = storage;
    this.createUuid = createUuid;
  }

  resolve(scope: string, draft: unknown, create: (key: string) => JapanPackageTransactionCommand): JapanPackageTransactionCommand {
    const storageKey = `${PENDING_INTENT_PREFIX}${scope}`;
    const fingerprint = stableJapanPackagePayload(draft);
    const serialized = this.storage?.getItem(storageKey) ?? this.memory.get(storageKey) ?? null;
    if (serialized) {
      try {
        const pending = JSON.parse(serialized) as { fingerprint?: string; command?: JapanPackageTransactionCommand };
        if (pending.fingerprint === fingerprint && pending.command) return pending.command;
      } catch { /* replace malformed browser-only state */ }
    }
    const command = create(this.createUuid());
    const next = JSON.stringify({ fingerprint, command });
    this.memory.set(storageKey, next);
    this.storage?.setItem(storageKey, next);
    return command;
  }

  complete(scope: string, idempotencyKey: string): void {
    const storageKey = `${PENDING_INTENT_PREFIX}${scope}`;
    const serialized = this.storage?.getItem(storageKey) ?? this.memory.get(storageKey) ?? null;
    if (!serialized) return;
    try {
      const pending = JSON.parse(serialized) as { command?: JapanPackageTransactionCommand };
      if (pending.command?.idempotencyKey !== idempotencyKey) return;
    } catch { return; }
    this.memory.delete(storageKey);
    this.storage?.removeItem(storageKey);
  }
}

export const japanPackageIntentCoordinator = new JapanPackageIntentCoordinator();

export const buildJapanPackageTransactionRequest = (
  currentPackage: JapanPackage | undefined,
  currentItems: JapanPackageItem[],
  command: JapanPackageTransactionCommand,
  targetProjectRef: string,
): JapanPackageTransactionRpcRequest => {
  if (!/^[a-z0-9]{20}$/u.test(targetProjectRef)) throw new Error('JAPAN_PACKAGE_TARGET_PROJECT_REF_REQUIRED');
  if (command.transactionType === 'create-package') {
    const operation = buildCloudCollectionMutationPlan(
      'japan_packages', [], [toCloudFieldRow('japan_packages', command.package)], { deleteMissing: false },
    )[0];
    if (!operation || operation.kind !== 'create') throw new Error('JAPAN_PACKAGE_CREATE_OPERATION_REQUIRED');
    return {
      transactionType: command.transactionType,
      targetProjectRef,
      packageId: command.package.id,
      packageOperation: operation,
      itemOperations: [],
      expectedPackageVersion: null,
    };
  }
  if (!currentPackage || currentPackage.id !== command.packageId) throw new Error('JAPAN_PACKAGE_BASE_REQUIRED');
  const expectedPackageVersion = Number(currentPackage.version);
  if (!Number.isInteger(expectedPackageVersion) || expectedPackageVersion < 1) throw new Error('JAPAN_PACKAGE_VERSION_REQUIRED');
  if (command.transactionType === 'attach-items') {
    const operations = buildCloudCollectionMutationPlan(
      'japan_package_items', [], command.items.map(item => toCloudFieldRow('japan_package_items', item)), { deleteMissing: false },
    );
    if (operations.length === 0 || operations.some(operation => operation.kind !== 'create')) {
      throw new Error('JAPAN_PACKAGE_ATTACH_CREATE_OPERATIONS_REQUIRED');
    }
    return {
      transactionType: command.transactionType,
      targetProjectRef,
      packageId: command.packageId,
      packageOperation: null,
      itemOperations: operations,
      expectedPackageVersion,
    };
  }
  const updates = new Map(command.updates.map(update => [update.itemId, update]));
  const base = currentItems.filter(item => updates.has(item.id));
  if (base.length !== updates.size) throw new Error('JAPAN_PACKAGE_RECEIVING_ITEM_BASE_REQUIRED');
  const next = base.map(item => {
    const update = updates.get(item.id)!;
    return { ...item, checked: update.checked, checked_at: update.checked ? (update.checkedAt ?? new Date().toISOString()) : undefined };
  });
  const operations = buildCloudCollectionMutationPlan(
    'japan_package_items',
    base.map(item => toCloudFieldRow('japan_package_items', item)),
    next.map(item => toCloudFieldRow('japan_package_items', item)),
    { deleteMissing: false },
  );
  if (operations.length === 0 || operations.some(operation => operation.kind !== 'patch')) {
    throw new Error('JAPAN_PACKAGE_RECEIVING_PATCH_OPERATIONS_REQUIRED');
  }
  return {
    transactionType: command.transactionType,
    targetProjectRef,
    packageId: command.packageId,
    packageOperation: null,
    itemOperations: operations,
    expectedPackageVersion,
  };
};

export const readOrCreatePendingJapanPackageRequest = (
  command: JapanPackageTransactionCommand,
  factory: () => JapanPackageTransactionRpcRequest,
  storage: StorageLike | null = sessionStorageOrNull(),
): JapanPackageTransactionRpcRequest => {
  const key = `${PENDING_RPC_PREFIX}${command.idempotencyKey}`;
  const fingerprint = stableJapanPackagePayload(command);
  const serialized = storage?.getItem(key);
  if (serialized) {
    try {
      const pending = JSON.parse(serialized) as { fingerprint?: string; request?: JapanPackageTransactionRpcRequest };
      if (pending.fingerprint === fingerprint && pending.request) return pending.request;
    } catch { /* replace malformed browser-only state */ }
  }
  const request = factory();
  storage?.setItem(key, JSON.stringify({ fingerprint, request }));
  return request;
};

export const clearPendingJapanPackageRequest = (idempotencyKey: string, storage: StorageLike | null = sessionStorageOrNull()): void => {
  storage?.removeItem(`${PENDING_RPC_PREFIX}${idempotencyKey}`);
};

export const assertJapanPackageTransactionSucceeded = (value: unknown): JapanPackageTransactionSuccess => {
  if (!isObject(value) || value.ok !== true || !isObject(value.package) || !Array.isArray(value.items)) {
    const error = new Error('JAPAN_PACKAGE_TRANSACTION_REJECTED') as Error & { transactionResult?: unknown };
    error.name = 'JapanPackageTransactionError';
    error.transactionResult = value;
    throw error;
  }
  return value as unknown as JapanPackageTransactionSuccess;
};
