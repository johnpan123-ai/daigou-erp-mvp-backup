import type { SupabaseRuntimeRole } from './supabaseEnvironmentBoundary';
import { STAGING_SUPABASE_PROJECT_REF } from './supabaseEnvironmentBoundary';
import type { PurchaseBatchTransactionRpcRequest } from '../providers/cloud/purchaseBatchTransaction';
import { PURCHASE_BATCH_TRANSACTION_RPC } from '../providers/cloud/purchaseBatchTransaction';

export const P0_4_TEST_PREFIX = 'P0-4-IDEMPOTENCY-TEST-';
export const P0_4_HARNESS_STATUS_RPC = 'erp_p0_4_authenticated_test_status';
export const P0_4_HARNESS_CLEANUP_RPC = 'erp_p0_4_authenticated_test_cleanup';
export const P0_4_HARNESS_RESIDUAL_RPC = 'erp_p0_4_authenticated_test_residuals';

export type P04HarnessScenario =
  | 'normal-create'
  | 'retry-same-key'
  | 'same-key-different-payload'
  | 'concurrent-duplicate'
  | 'timeout-unknown-retry'
  | 'failed-transaction-retry'
  | 'atomic-edit'
  | 'item-cas-conflict'
  | 'stale-delete'
  | 'cross-batch-protection'
  | 'double-submit';

export const P0_4_HARNESS_SCENARIOS: ReadonlyArray<{ id: P04HarnessScenario; label: string }> = [
  { id: 'normal-create', label: 'Normal create' },
  { id: 'retry-same-key', label: 'Retry same key' },
  { id: 'same-key-different-payload', label: 'Same key / different payload' },
  { id: 'concurrent-duplicate', label: 'Concurrent duplicate' },
  { id: 'timeout-unknown-retry', label: 'Timeout / unknown outcome retry' },
  { id: 'failed-transaction-retry', label: 'Failed transaction retry' },
  { id: 'atomic-edit', label: 'Atomic edit' },
  { id: 'item-cas-conflict', label: 'Item CAS conflict' },
  { id: 'stale-delete', label: 'Stale delete' },
  { id: 'cross-batch-protection', label: 'Cross-Batch protection' },
  { id: 'double-submit', label: 'Double submit' },
];

export interface P04HarnessBoundaryInput {
  projectRef: string;
  runtimeRole: SupabaseRuntimeRole;
  viteMode?: string | null;
  deploymentEnvironment?: string | null;
}

export function assertP04HarnessBoundary(input: P04HarnessBoundaryInput): void {
  const mode = input.viteMode?.trim().toLowerCase();
  const deployment = input.deploymentEnvironment?.trim().toLowerCase();
  const allowedRuntimeRoles: ReadonlyArray<SupabaseRuntimeRole> = ['staging', 'experimental', 'test'];
  const allowedModes = ['staging', 'experimental', 'test', 'development'];
  const allowedDeployments = ['staging', 'experimental', 'test', 'development'];
  if (input.projectRef !== STAGING_SUPABASE_PROJECT_REF
    || !allowedRuntimeRoles.includes(input.runtimeRole)
    || !mode
    || !allowedModes.includes(mode)
    || !deployment
    || !allowedDeployments.includes(deployment)) {
    throw new Error('P0_4_STAGING_TEST_HARNESS_DISABLED');
  }
}

export interface P04HarnessRpcError {
  message: string;
  code?: string;
}

export interface P04HarnessRpcResponse {
  data: unknown;
  error: P04HarnessRpcError | null;
}

export type P04HarnessRpcInvoker = (
  functionName: string,
  args?: Record<string, unknown>,
) => Promise<P04HarnessRpcResponse>;

export interface P04HarnessStatus {
  authenticated: boolean;
  editor: boolean;
  role: string | null;
  productGroupId: string | null;
  productVariantId: string | null;
}

export interface P04HarnessRunResult {
  scenario: P04HarnessScenario;
  marker: string;
  passed: boolean;
  details: unknown;
}

type RpcSuccess = {
  ok: true;
  replayed?: boolean;
  batch: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
};

const objectValue = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const successValue = (value: unknown): RpcSuccess => {
  const record = objectValue(value);
  if (record.ok !== true || !record.batch || !Array.isArray(record.items)) {
    throw new Error(`P0_4_HARNESS_EXPECTED_SUCCESS:${String(record.code ?? 'UNKNOWN')}`);
  }
  return record as unknown as RpcSuccess;
};

const failureCode = (value: unknown): string | null => {
  const record = objectValue(value);
  return record.ok === false && typeof record.code === 'string' ? record.code : null;
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class StagingP04AuthenticatedHarness {
  private readonly environment: Readonly<P04HarnessBoundaryInput>;
  private readonly invokeRpc: P04HarnessRpcInvoker;
  private readonly createUuid: () => string;
  private readonly now: () => Date;
  readonly marker: string;
  private status: P04HarnessStatus | null = null;

  constructor(
    environment: P04HarnessBoundaryInput,
    invokeRpc: P04HarnessRpcInvoker,
    createUuid: () => string = () => crypto.randomUUID(),
    now: () => Date = () => new Date(),
  ) {
    this.environment = Object.freeze({ ...environment });
    this.assertEnvironment();
    this.invokeRpc = invokeRpc;
    this.createUuid = createUuid;
    this.now = now;
    this.marker = `${P0_4_TEST_PREFIX}${this.now().toISOString().replace(/[^0-9A-Z]/giu, '-')}-${this.createUuid().slice(0, 8).toUpperCase()}`;
  }

  private assertEnvironment(): void {
    assertP04HarnessBoundary(this.environment);
  }

  private async call(functionName: string, args?: Record<string, unknown>): Promise<unknown> {
    this.assertEnvironment();
    const response = await this.invokeRpc(functionName, args);
    if (response.error) {
      const error = new Error(response.error.message) as Error & { code?: string };
      error.code = response.error.code;
      throw error;
    }
    return response.data;
  }

  async loadStatus(): Promise<P04HarnessStatus> {
    const raw = objectValue(await this.call(P0_4_HARNESS_STATUS_RPC));
    const prerequisites = objectValue(raw.prerequisites);
    const status: P04HarnessStatus = {
      authenticated: raw.authenticated === true,
      editor: raw.editor === true,
      role: typeof raw.role === 'string' ? raw.role : null,
      productGroupId: typeof prerequisites.productGroupId === 'string' ? prerequisites.productGroupId : null,
      productVariantId: typeof prerequisites.productVariantId === 'string' ? prerequisites.productVariantId : null,
    };
    if (!status.authenticated || !status.editor) throw new Error('P0_4_AUTHENTICATED_EDITOR_REQUIRED');
    if (!status.productGroupId || !status.productVariantId) throw new Error('P0_4_TEST_PREREQUISITE_MISSING');
    this.status = status;
    return status;
  }

  private requireStatus(): P04HarnessStatus {
    if (!this.status) throw new Error('P0_4_HARNESS_STATUS_REQUIRED');
    return this.status;
  }

  private createRequest(suffix: string): { key: string; batchId: string; itemId: string; request: PurchaseBatchTransactionRpcRequest } {
    const status = this.requireStatus();
    const batchId = this.createUuid();
    const itemId = this.createUuid();
    const key = this.createUuid();
    const name = `${this.marker}-${suffix.toUpperCase()}`;
    return {
      key,
      batchId,
      itemId,
      request: {
        operationType: 'create',
        batchId,
        batchOperations: [{
          kind: 'create', id: batchId, values: {
            local_id: batchId,
            product_group_id: status.productGroupId,
            name,
            date: this.now().toISOString().slice(0, 10),
            note: 'STAGING TEST ONLY',
            currency: 'JPY',
          },
        }],
        itemOperations: [{
          kind: 'create', id: itemId, values: {
            local_id: itemId,
            purchase_batch_id: batchId,
            product_variant_id: status.productVariantId,
            quantity: 1,
            cost: 1,
            note: 'STAGING TEST ONLY',
          },
        }],
      },
    };
  }

  private apply(key: string, request: PurchaseBatchTransactionRpcRequest): Promise<unknown> {
    this.assertEnvironment();
    return this.call(PURCHASE_BATCH_TRANSACTION_RPC, {
      p_idempotency_key: key,
      p_request: request,
    });
  }

  private async createFixture(suffix: string) {
    const fixture = this.createRequest(suffix);
    const result = successValue(await this.apply(fixture.key, fixture.request));
    return { ...fixture, result };
  }

  async run(scenario: P04HarnessScenario): Promise<P04HarnessRunResult> {
    if (!this.status) await this.loadStatus();
    let details: unknown;

    if (scenario === 'normal-create') {
      details = (await this.createFixture('NORMAL')).result;
    } else if (scenario === 'retry-same-key' || scenario === 'timeout-unknown-retry') {
      const fixture = this.createRequest(scenario);
      const first = successValue(await this.apply(fixture.key, fixture.request));
      // In the unknown-outcome case the first response is intentionally not used to
      // update any UI/cache. The exact same authenticated request is then retried.
      const retry = successValue(await this.apply(fixture.key, fixture.request));
      if (String(first.batch.id) !== String(retry.batch.id) || retry.replayed !== true) {
        throw new Error('P0_4_RETRY_CANONICAL_RESULT_MISMATCH');
      }
      details = { canonicalBatchId: retry.batch.id, replayed: retry.replayed };
    } else if (scenario === 'same-key-different-payload') {
      const fixture = this.createRequest('PAYLOAD-MISMATCH');
      await this.apply(fixture.key, fixture.request);
      const changed = clone(fixture.request);
      (changed.batchOperations[0] as { values: Record<string, unknown> }).values.note = 'DIFFERENT PAYLOAD';
      const result = await this.apply(fixture.key, changed);
      if (failureCode(result) !== 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH') throw new Error('P0_4_PAYLOAD_MISMATCH_ACCEPTED');
      details = result;
    } else if (scenario === 'concurrent-duplicate' || scenario === 'double-submit') {
      const fixture = this.createRequest(scenario);
      const [left, right] = await Promise.all([
        this.apply(fixture.key, fixture.request),
        this.apply(fixture.key, fixture.request),
      ]);
      const first = successValue(left);
      const second = successValue(right);
      if (String(first.batch.id) !== String(second.batch.id)) throw new Error('P0_4_CONCURRENT_CANONICAL_RESULT_MISMATCH');
      details = { canonicalBatchId: first.batch.id, replayed: [first.replayed, second.replayed] };
    } else if (scenario === 'failed-transaction-retry') {
      const fixture = this.createRequest('FAILED-RETRY');
      const invalid = clone(fixture.request);
      (invalid.itemOperations[0] as { values: Record<string, unknown> }).values.product_variant_id = this.createUuid();
      let failed: boolean;
      try {
        const result = await this.apply(fixture.key, invalid);
        failed = failureCode(result) === 'TRANSACTION_CONSTRAINT_FAILED';
      } catch {
        failed = true;
      }
      if (!failed) throw new Error('P0_4_FAILURE_FIXTURE_WAS_ACCEPTED');
      const retry = successValue(await this.apply(fixture.key, fixture.request));
      details = { retryBatchId: retry.batch.id };
    } else if (scenario === 'atomic-edit') {
      const fixture = await this.createFixture('ATOMIC-EDIT');
      const item = fixture.result.items[0];
      const edit: PurchaseBatchTransactionRpcRequest = {
        operationType: 'edit', batchId: fixture.batchId,
        batchOperations: [{ kind: 'patch', id: fixture.batchId, expected: { note: 'STAGING TEST ONLY' }, changes: { note: 'ATOMIC EDIT COMPLETE' }, observedVersion: Number(fixture.result.batch.version) }],
        itemOperations: [{ kind: 'patch', id: fixture.itemId, expected: { quantity: 1 }, changes: { quantity: 2 }, observedVersion: Number(item.version) }],
      };
      details = successValue(await this.apply(this.createUuid(), edit));
    } else if (scenario === 'item-cas-conflict') {
      const fixture = await this.createFixture('ITEM-CONFLICT');
      const item = fixture.result.items[0];
      const valid: PurchaseBatchTransactionRpcRequest = {
        operationType: 'edit', batchId: fixture.batchId, batchOperations: [],
        itemOperations: [{ kind: 'patch', id: fixture.itemId, expected: { quantity: 1 }, changes: { quantity: 2 }, observedVersion: Number(item.version) }],
      };
      await this.apply(this.createUuid(), valid);
      const stale = clone(valid);
      (stale.itemOperations[0] as { changes: Record<string, unknown> }).changes.quantity = 3;
      const result = await this.apply(this.createUuid(), stale);
      if (failureCode(result) !== 'FIELD_CONFLICT') throw new Error('P0_4_ITEM_CONFLICT_NOT_REJECTED');
      details = result;
    } else if (scenario === 'stale-delete') {
      const fixture = await this.createFixture('STALE-DELETE');
      const item = fixture.result.items[0];
      await this.apply(this.createUuid(), {
        operationType: 'edit', batchId: fixture.batchId, batchOperations: [],
        itemOperations: [{ kind: 'patch', id: fixture.itemId, expected: { note: 'STAGING TEST ONLY' }, changes: { note: 'VERSION BUMP' }, observedVersion: Number(item.version) }],
      });
      const result = await this.apply(this.createUuid(), {
        operationType: 'edit', batchId: fixture.batchId, batchOperations: [],
        itemOperations: [{ kind: 'delete', id: fixture.itemId, expectedVersion: Number(item.version) }],
      });
      if (failureCode(result) !== 'STALE_DELETE') throw new Error('P0_4_STALE_DELETE_ACCEPTED');
      details = result;
    } else {
      const left = await this.createFixture('CROSS-A');
      const right = await this.createFixture('CROSS-B');
      const leftItem = left.result.items[0];
      const result = await this.apply(this.createUuid(), {
        operationType: 'edit', batchId: right.batchId, batchOperations: [],
        itemOperations: [{ kind: 'patch', id: left.itemId, expected: { quantity: 1 }, changes: { quantity: 9 }, observedVersion: Number(leftItem.version) }],
      });
      if (failureCode(result) !== 'RECORD_DELETED_OR_MISSING') throw new Error('P0_4_CROSS_BATCH_MUTATION_ACCEPTED');
      details = result;
    }

    return { scenario, marker: this.marker, passed: true, details };
  }

  async cleanup(): Promise<unknown> {
    this.assertEnvironment();
    const result = objectValue(await this.call(P0_4_HARNESS_CLEANUP_RPC, { p_marker: this.marker }));
    const residual = objectValue(result.residual);
    if (Object.values(residual).some(value => Number(value) !== 0)) throw new Error('P0_4_TEST_CLEANUP_RESIDUAL');
    return result;
  }

  async residuals(): Promise<unknown> {
    this.assertEnvironment();
    return this.call(P0_4_HARNESS_RESIDUAL_RPC, { p_marker: this.marker });
  }
}
