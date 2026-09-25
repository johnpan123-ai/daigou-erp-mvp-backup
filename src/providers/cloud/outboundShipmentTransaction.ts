import type { OutboundShipment, OutboundShipmentItem } from '../../lib/db';
import { buildCloudCollectionMutationPlan, type CloudDeleteOperation } from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';

export const OUTBOUND_SHIPMENT_TRANSACTION_RPC = 'erp_apply_outbound_shipment_transaction';
const PENDING_INTENT_PREFIX = 'erp_outbound_shipment_pending_intent_v1:';
const PENDING_RPC_PREFIX = 'erp_outbound_shipment_pending_rpc_v1:';

export interface OutboundShipmentDeleteCommand {
  idempotencyKey: string;
  transactionType: 'delete-shipment';
  shipmentId: string;
}

export interface OutboundShipmentDeleteRequest {
  transactionType: 'delete-shipment';
  targetProjectRef: string;
  shipmentId: string;
  shipmentOperation: CloudDeleteOperation;
  itemOperations: CloudDeleteOperation[];
}

export interface OutboundShipmentDeleteSuccess {
  ok: true;
  transactionType: 'delete-shipment';
  idempotencyKey: string;
  replayed: boolean;
  shipmentId: string;
  itemIds: string[];
  syncPending?: boolean;
}

export type OutboundShipmentDeleteFailureKind = 'server-rejected' | 'result-unknown' | 'committed-sync-pending';
const MESSAGES: Record<OutboundShipmentDeleteFailureKind, string> = {
  'server-rejected': '伺服器已拒絕刪除出庫單，請重新讀取資料後再確認。',
  'result-unknown': '刪除結果待查證，請勿重複操作。',
  'committed-sync-pending': '出庫單已刪除，畫面同步尚未完成，請勿重複操作。',
};

export class OutboundShipmentDeleteBoundaryError extends Error {
  readonly code = 'OUTBOUND_SHIPMENT_DELETE_BOUNDARY';
  readonly kind: OutboundShipmentDeleteFailureKind;

  constructor(kind: OutboundShipmentDeleteFailureKind) {
    super(MESSAGES[kind]);
    this.name = 'OutboundShipmentDeleteBoundaryError';
    this.kind = kind;
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storageOrNull = (): StorageLike | null => {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
};
const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
};
const stablePayload = (value: unknown): string => JSON.stringify(stableValue(value));

export class OutboundShipmentDeleteIntentCoordinator {
  private readonly memory = new Map<string, string>();
  private readonly storage: StorageLike | null;
  private readonly createUuid: () => string;
  constructor(
    storage: StorageLike | null = storageOrNull(),
    createUuid: () => string = () => crypto.randomUUID(),
  ) {
    this.storage = storage;
    this.createUuid = createUuid;
  }

  resolve(shipmentId: string): OutboundShipmentDeleteCommand {
    const key = `${PENDING_INTENT_PREFIX}${shipmentId}`;
    const serialized = this.storage?.getItem(key) ?? this.memory.get(key) ?? null;
    if (serialized) {
      try {
        const command = JSON.parse(serialized) as OutboundShipmentDeleteCommand;
        if (command.transactionType === 'delete-shipment' && command.shipmentId === shipmentId) return command;
      } catch { /* replace malformed browser-only state */ }
    }
    const command: OutboundShipmentDeleteCommand = {
      idempotencyKey: this.createUuid(), transactionType: 'delete-shipment', shipmentId,
    };
    const next = JSON.stringify(command);
    this.memory.set(key, next);
    this.storage?.setItem(key, next);
    return command;
  }

  complete(command: OutboundShipmentDeleteCommand): void {
    const key = `${PENDING_INTENT_PREFIX}${command.shipmentId}`;
    const serialized = this.storage?.getItem(key) ?? this.memory.get(key) ?? null;
    if (!serialized) return;
    try {
      if ((JSON.parse(serialized) as OutboundShipmentDeleteCommand).idempotencyKey !== command.idempotencyKey) return;
    } catch { return; }
    this.memory.delete(key);
    this.storage?.removeItem(key);
  }
}

export const outboundShipmentDeleteIntentCoordinator = new OutboundShipmentDeleteIntentCoordinator();

export const buildOutboundShipmentDeleteRequest = (
  shipment: OutboundShipment,
  items: OutboundShipmentItem[],
  targetProjectRef: string,
): OutboundShipmentDeleteRequest => {
  if (!/^[a-z0-9]{20}$/u.test(targetProjectRef)) throw new Error('OUTBOUND_TARGET_PROJECT_REF_REQUIRED');
  const shipmentOperations = buildCloudCollectionMutationPlan(
    'outbound_shipments', [toCloudFieldRow('outbound_shipments', shipment)], [],
  );
  const itemOperations = buildCloudCollectionMutationPlan(
    'outbound_shipment_items', items.map(item => toCloudFieldRow('outbound_shipment_items', item)), [],
  );
  const shipmentOperation = shipmentOperations[0];
  if (!shipmentOperation || shipmentOperation.kind !== 'delete') throw new Error('OUTBOUND_DELETE_OPERATION_REQUIRED');
  if (itemOperations.some(operation => operation.kind !== 'delete')) throw new Error('OUTBOUND_ITEM_DELETE_OPERATIONS_REQUIRED');
  return {
    transactionType: 'delete-shipment',
    targetProjectRef,
    shipmentId: shipment.id,
    shipmentOperation,
    itemOperations: itemOperations as CloudDeleteOperation[],
  };
};

export const readOrCreatePendingOutboundDeleteRequest = (
  command: OutboundShipmentDeleteCommand,
  factory: () => OutboundShipmentDeleteRequest,
  storage: StorageLike | null = storageOrNull(),
): OutboundShipmentDeleteRequest => {
  const key = `${PENDING_RPC_PREFIX}${command.idempotencyKey}`;
  const fingerprint = stablePayload(command);
  const serialized = storage?.getItem(key);
  if (serialized) {
    try {
      const pending = JSON.parse(serialized) as { fingerprint?: string; request?: OutboundShipmentDeleteRequest };
      if (pending.fingerprint === fingerprint && pending.request) return pending.request;
    } catch { /* replace malformed browser-only state */ }
  }
  const request = factory();
  storage?.setItem(key, JSON.stringify({ fingerprint, request }));
  return request;
};

export const clearPendingOutboundDeleteRequest = (
  idempotencyKey: string,
  storage: StorageLike | null = storageOrNull(),
): void => storage?.removeItem(`${PENDING_RPC_PREFIX}${idempotencyKey}`);

export const assertOutboundShipmentDeleteSucceeded = (value: unknown): OutboundShipmentDeleteSuccess => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OutboundShipmentDeleteBoundaryError('server-rejected');
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true || result.transactionType !== 'delete-shipment'
    || typeof result.shipmentId !== 'string' || !Array.isArray(result.itemIds)) {
    throw new OutboundShipmentDeleteBoundaryError('server-rejected');
  }
  return result as unknown as OutboundShipmentDeleteSuccess;
};
