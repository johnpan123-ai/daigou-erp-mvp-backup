import type { PurchaseBatch, PurchaseBatchItem } from '../../lib/db';
import {
  buildCloudCollectionMutationPlan,
  type CloudFieldMutationFailure,
  type CloudFieldMutationOperation,
} from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';

export const PURCHASE_BATCH_TRANSACTION_RPC = 'erp_apply_purchase_batch_transaction';
export const PURCHASE_BATCH_PENDING_INTENT_PREFIX = 'erp_purchase_batch_pending_intent_v1:';
export const PURCHASE_BATCH_PENDING_RPC_PREFIX = 'erp_purchase_batch_pending_rpc_v1:';

export interface PurchaseBatchTransactionCommand {
  idempotencyKey: string;
  batch: PurchaseBatch;
  items: PurchaseBatchItem[];
}

export interface PurchaseBatchTransactionRpcRequest {
  operationType: 'create' | 'edit';
  batchId: string;
  batchOperations: CloudFieldMutationOperation[];
  itemOperations: CloudFieldMutationOperation[];
}

export interface PurchaseBatchTransactionSuccess {
  ok: true;
  operationType: 'create' | 'edit';
  idempotencyKey: string;
  replayed: boolean;
  batch: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
}

export type PurchaseBatchSubmitFailureKind =
  | 'precondition-blocked'
  | 'server-rejected'
  | 'result-unknown'
  | 'committed-sync-pending';

const PURCHASE_BATCH_SUBMIT_MESSAGES: Record<PurchaseBatchSubmitFailureKind, string> = {
  'precondition-blocked': '目前帳號或雲端狀態不允許儲存，本次尚未送出；草稿已保留。',
  'server-rejected': '伺服器已拒絕這次採購儲存，草稿仍保留，請重新確認後再試。',
  'result-unknown': '採購儲存結果待查證，請勿重複操作。',
  'committed-sync-pending': '採購已提交，畫面同步尚未完成，請勿重複操作。',
};

/** A fixed-output boundary error. Raw transport/database errors must never reach the UI. */
export class PurchaseBatchSubmitBoundaryError extends Error {
  readonly code = 'PURCHASE_BATCH_SUBMIT_BOUNDARY';
  readonly kind: PurchaseBatchSubmitFailureKind;

  constructor(kind: PurchaseBatchSubmitFailureKind) {
    super(PURCHASE_BATCH_SUBMIT_MESSAGES[kind]);
    this.name = 'PurchaseBatchSubmitBoundaryError';
    this.kind = kind;
  }
}

export const isPurchaseBatchSubmitBoundaryError = (
  value: unknown,
): value is PurchaseBatchSubmitBoundaryError => value instanceof PurchaseBatchSubmitBoundaryError;

export type PurchaseBatchTransactionResult = PurchaseBatchTransactionSuccess | CloudFieldMutationFailure | {
  ok: false;
  code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' | 'TRANSACTION_CONSTRAINT_FAILED' | 'INVALID_TRANSACTION';
  entity?: 'purchase_batches' | 'purchase_batch_items';
  recordId?: string;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
};

export const stablePurchaseBatchPayload = (value: unknown): string => JSON.stringify(stableValue(value));

const browserSessionStorage = (): StorageLike | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

export class PurchaseBatchIntentCoordinator {
  private readonly memory = new Map<string, string>();
  private readonly storage: StorageLike | null;
  private readonly createUuid: () => string;

  constructor(
    storage: StorageLike | null = browserSessionStorage(),
    createUuid: () => string = () => crypto.randomUUID(),
  ) {
    this.storage = storage;
    this.createUuid = createUuid;
  }

  resolve(
    scope: string,
    draft: unknown,
    createCommand: (idempotencyKey: string) => PurchaseBatchTransactionCommand,
  ): PurchaseBatchTransactionCommand {
    const storageKey = `${PURCHASE_BATCH_PENDING_INTENT_PREFIX}${scope}`;
    const fingerprint = stablePurchaseBatchPayload(draft);
    const serialized = this.storage?.getItem(storageKey) ?? this.memory.get(storageKey) ?? null;
    if (serialized) {
      try {
        const pending = JSON.parse(serialized) as { fingerprint?: string; command?: PurchaseBatchTransactionCommand };
        if (pending.fingerprint === fingerprint && pending.command) return pending.command;
      } catch {
        // A malformed browser-only pending intent is replaced before any server mutation.
      }
    }

    const command = createCommand(this.createUuid());
    const next = JSON.stringify({ fingerprint, command });
    this.memory.set(storageKey, next);
    this.storage?.setItem(storageKey, next);
    return command;
  }

  complete(scope: string, idempotencyKey: string): void {
    const storageKey = `${PURCHASE_BATCH_PENDING_INTENT_PREFIX}${scope}`;
    const serialized = this.storage?.getItem(storageKey) ?? this.memory.get(storageKey) ?? null;
    if (!serialized) return;
    try {
      const pending = JSON.parse(serialized) as { command?: PurchaseBatchTransactionCommand };
      if (pending.command?.idempotencyKey !== idempotencyKey) return;
    } catch {
      return;
    }
    this.memory.delete(storageKey);
    this.storage?.removeItem(storageKey);
  }
}

export const purchaseBatchIntentCoordinator = new PurchaseBatchIntentCoordinator();

export const buildPurchaseBatchTransactionRequest = (
  currentBatch: PurchaseBatch | undefined,
  currentItems: PurchaseBatchItem[],
  command: PurchaseBatchTransactionCommand,
): PurchaseBatchTransactionRpcRequest => {
  const nextBatch = toCloudFieldRow('purchase_batches', command.batch);
  const nextItems = command.items.map(item => toCloudFieldRow('purchase_batch_items', item));
  const currentBatchRows = currentBatch ? [toCloudFieldRow('purchase_batches', currentBatch)] : [];
  const currentItemRows = currentItems.map(item => toCloudFieldRow('purchase_batch_items', item));

  return {
    operationType: currentBatch ? 'edit' : 'create',
    batchId: String(nextBatch.id),
    batchOperations: buildCloudCollectionMutationPlan('purchase_batches', currentBatchRows, [nextBatch]),
    itemOperations: buildCloudCollectionMutationPlan('purchase_batch_items', currentItemRows, nextItems),
  };
};

export const readOrCreatePendingRpcRequest = (
  command: PurchaseBatchTransactionCommand,
  factory: () => PurchaseBatchTransactionRpcRequest,
  storage: StorageLike | null = browserSessionStorage(),
): PurchaseBatchTransactionRpcRequest => {
  const key = `${PURCHASE_BATCH_PENDING_RPC_PREFIX}${command.idempotencyKey}`;
  const commandFingerprint = stablePurchaseBatchPayload(command);
  const serialized = storage?.getItem(key);
  if (serialized) {
    try {
      const pending = JSON.parse(serialized) as { commandFingerprint?: string; request?: PurchaseBatchTransactionRpcRequest };
      if (pending.commandFingerprint === commandFingerprint && pending.request) return pending.request;
    } catch {
      // Replace malformed browser-only state with a freshly validated request.
    }
  }
  const request = factory();
  storage?.setItem(key, JSON.stringify({ commandFingerprint, request }));
  return request;
};

export const clearPendingRpcRequest = (
  idempotencyKey: string,
  storage: StorageLike | null = browserSessionStorage(),
): void => storage?.removeItem(`${PURCHASE_BATCH_PENDING_RPC_PREFIX}${idempotencyKey}`);

export const assertPurchaseBatchTransactionSucceeded = (value: unknown): PurchaseBatchTransactionSuccess => {
  if (!isPlainObject(value) || value.ok !== true || !isPlainObject(value.batch) || !Array.isArray(value.items)) {
    const failure = isPlainObject(value) ? value : {};
    const error = new Error(
      failure.code === 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'
        ? '同一筆採購操作的內容已改變，系統已拒絕重複送出。'
        : '採購批次已由其他裝置更新，請重新確認後再儲存。',
    ) as Error & { transactionResult?: unknown };
    error.name = 'PurchaseBatchTransactionError';
    error.transactionResult = value;
    throw error;
  }
  return value as unknown as PurchaseBatchTransactionSuccess;
};
