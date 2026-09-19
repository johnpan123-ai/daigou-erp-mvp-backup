// Polyfill crypto.randomUUID for insecure contexts (HTTP)
(function polyfillCrypto() {
  try {
    const fallbackUUID = function randomUUID() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };

    const targetGlobals = [];
    if (typeof globalThis !== 'undefined') targetGlobals.push(globalThis);
    if (typeof window !== 'undefined') targetGlobals.push(window);
    if (typeof self !== 'undefined') targetGlobals.push(self);

    for (const g of targetGlobals) {
      let currentCrypto = (g as any).crypto;
      if (!currentCrypto) {
        try {
          Object.defineProperty(g, 'crypto', {
            value: {},
            writable: true,
            configurable: true,
            enumerable: true
          });
          currentCrypto = (g as any).crypto;
        } catch (e) {
          // ignore
        }
      }

      if (currentCrypto && !currentCrypto.randomUUID) {
        try {
          Object.defineProperty(currentCrypto, 'randomUUID', {
            value: fallbackUUID,
            writable: true,
            configurable: true,
            enumerable: false
          });
        } catch (err) {
          // If crypto is read-only or non-extensible
          const originalCrypto = currentCrypto;
          const newCrypto = Object.create(originalCrypto || {});

          Object.defineProperty(newCrypto, 'randomUUID', {
            value: fallbackUUID,
            writable: true,
            configurable: true,
            enumerable: false
          });

          if (originalCrypto && typeof originalCrypto.getRandomValues === 'function') {
            Object.defineProperty(newCrypto, 'getRandomValues', {
              value: originalCrypto.getRandomValues.bind(originalCrypto),
              writable: true,
              configurable: true,
              enumerable: false
            });
          }

          try {
            Object.defineProperty(g, 'crypto', {
              value: newCrypto,
              configurable: true,
              writable: true,
              enumerable: true
            });
          } catch (e2) {
            // Last resort: assign directly
            try {
              (g as any).crypto = newCrypto;
            } catch (e3) {
              console.error('Failed to override crypto object:', e3);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to polyfill crypto.randomUUID:', e);
  }
})();

import { supabase } from './supabaseClient';
import { cloudCacheDb as db, normalizeProductTitle, prepareInventoryUpsert } from '../../lib/db';
import { checkDataSizeWarnings } from '../../lib/dataSizeAdvisory';
import { CloudRestoreDisabledError } from '../cloudRestorePolicy';
import { clearLocalCloudWrites, markLocalCloudWrite } from './cloudRealtimeEchoRegistry';
import {
  assertCloudFieldMutationSucceeded,
  buildCloudCollectionMutationPlan,
  buildCloudPatchOperation,
  isCloudFieldMutationError,
  notifyCloudFieldMutationConflict,
  type CloudFieldMutationOperation,
  type CloudMutableEntity,
  type CloudPatchOperation,
} from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';
import {
  assertCloudWriteAllowed,
  isLikelyCloudConnectivityError,
  markCloudReadFailed,
  markCloudReadFresh,
  markCloudReadLoading,
  markCloudReachable,
  markCloudRequestFailed,
} from './cloudConnectivity';
import { CloudTargetedCache } from './cloudTargetedCache';
import { CLOUD_TABLE_RESOURCE } from './cloudSyncDomain';
import {
  PURCHASE_BATCH_TRANSACTION_RPC,
  PurchaseBatchSubmitBoundaryError,
  assertPurchaseBatchTransactionSucceeded,
  buildPurchaseBatchTransactionRequest,
  clearPendingRpcRequest,
  readOrCreatePendingRpcRequest,
  type PurchaseBatchTransactionCommand,
} from './purchaseBatchTransaction';
import {
  JAPAN_PACKAGE_TRANSACTION_RPC,
  JapanPackageSubmitBoundaryError,
  assertJapanPackageTransactionSucceeded,
  buildJapanPackageTransactionRequest,
  clearPendingJapanPackageRequest,
  readOrCreatePendingJapanPackageRequest,
  type JapanPackageTransactionCommand,
  type JapanPackageTransactionSuccess,
} from './japanPackageTransaction';
import {
  CLOUD_RESTORE_RPC,
  CLOUD_RESTORE_SNAPSHOT_RPC,
  CLOUD_RESTORE_SCHEMA_VERSION,
  CLOUD_RESTORE_TABLES,
  assertCloudRestoreServerResult,
  buildCloudRestoreManifest,
  type CloudRestoreCommand,
  type CloudRestoreResult,
} from './cloudAtomicRestore';
import {
  CLOUD_RESTORE_PORTABILITY_PREFLIGHT_RPC,
  assertCloudRestoreTargetCompatibilityResult,
  type CloudRestoreTargetCompatibilityResult,
} from './cloudRestorePortability';
import {
  createCloudRestoreSafeSubmitError,
  normalizeCloudRestoreSubmitError,
  preserveCloudRestoreSuccessThroughRefresh,
  recordCloudRestoreSubmitDiagnostic,
} from './cloudRestoreSubmit';
import type { IDataProvider } from '../types';
import type { 
  InventoryItem, 
  SalesOrder, 
  SalesOrderItem, 
  ProductGroup, 
  ProductCategory, 
  ProductVariant, 
  PurchaseBatch, 
  PurchaseBatchItem, 
  PrivateOrder, 
  PrivateOrderItem, 
  ImportBatch,
  ImportStats,
  JapanPackage,
  JapanPackageItem,
  BundleComponent,
  OutboundShipment,
  OutboundShipmentItem
} from '../../lib/db';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidUuid = (val: any): boolean => typeof val === 'string' && UUID_REGEX.test(val);
const generateFallbackUuid = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

const concurrencyFingerprint = (record: Record<string, unknown>): string => {
  const copy = { ...record };
  delete copy.updated_at;
  delete copy.version;
  return JSON.stringify(copy, Object.keys(copy).sort());
};

const changedOrNewRows = <T extends { id: string }>(current: T[], incoming: T[]): T[] => {
  const currentById = new Map(current.map(row => [row.id, row]));
  return incoming.filter(row => {
    const previous = currentById.get(row.id);
    return !previous || concurrencyFingerprint(previous as any) !== concurrencyFingerprint(row as any);
  });
};

function getDeterministicUuid(str: string): string {
  if (isValidUuid(str)) {
    return str;
  }
  // Convert standard string (e.g. MYACG_12345) to a deterministic UUID using cyrb128
  const cyrb128 = (s: string) => {
    let h1 = 1779033703, h2 = 302473350, h3 = 336245363, h4 = 50249321;
    for (let i = 0, k; i < s.length; i++) {
      k = s.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1^h2^h3^h4)>>>0, (h2^h1)>>>0, (h3^h1)>>>0, (h4^h1)>>>0];
  };

  const hashes = cyrb128(str);
  const toHex8 = (num: number) => num.toString(16).padStart(8, '0');

  const h1 = toHex8(hashes[0]);
  const h2 = toHex8(hashes[1]);
  const h3 = toHex8(hashes[2]);
  const h4 = toHex8(hashes[3]);

  const part1 = h1;
  const part2 = h2.substring(0, 4);
  const part3 = '5' + h2.substring(5, 8); // version 5
  const variantChar = ['8', '9', 'a', 'b'][parseInt(h3.charAt(0), 16) % 4];
  const part4 = variantChar + h3.substring(1, 4);
  const part5 = h3.substring(4, 8) + h4;

  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

function isSchemaMissingError(err: unknown): boolean {
  if (!err) return false;
  const record = err as { message?: unknown; code?: unknown };
  const msg = String(record.message ?? '').toLowerCase();
  const code = String(record.code ?? '');
  return code === '42P01' || msg.includes('could not find the table') || msg.includes('relation') || msg.includes('does not exist');
}
async function retrySupabase(
  fn: () => PromiseLike<{ data: unknown; error: unknown }>,
  maxRetries = 3,
  baseDelay = 500,
): Promise<void> {
  assertCloudWriteAllowed();
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let error: unknown;
    try {
      ({ error } = await fn());
    } catch (caughtError) {
      markCloudRequestFailed(caughtError);
      throw caughtError;
    }
    if (!error) {
      markCloudReachable();
      return;
    }
    markCloudRequestFailed(error);
    lastError = error;
    if (isLikelyCloudConnectivityError(error)) throw error;
    if (isSchemaMissingError(error)) throw error;
    if (attempt < maxRetries - 1) {
      const delay = baseDelay * Math.pow(2, attempt);
      const retryMessage = error instanceof Error ? error.message : error;
      console.warn(`[retrySupabase] attempt ${attempt + 1} failed, retrying in ${delay}ms...`, retryMessage);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

const fetchAll = async <T>(
  fetchFn: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>
): Promise<T[]> => {
  let allData: T[] = [];
  let page = 0;
  const size = 1000;
  const seen = new Set<string>();
  while (true) {
    const { data, error } = await fetchFn(page * size, (page + 1) * size - 1);
    if (error) {
      markCloudRequestFailed(error);
      throw error;
    }
    markCloudReachable();
    if (!data || data.length === 0) break;
    for (const item of data) {
      const anyItem = item as any;
      const key = anyItem.id || anyItem.inventory_key || anyItem.category_key;
      if (key) {
        if (!seen.has(key)) {
          seen.add(key);
          allData.push(item);
        }
      } else {
        allData.push(item);
      }
    }
    if (data.length < size) break;
    page++;
  }
  return allData;
};


export class SupabaseProvider implements IDataProvider {
  private readonly mutationCache = new CloudTargetedCache();

  async validateCloudRestoreTarget(command: CloudRestoreCommand): Promise<CloudRestoreTargetCompatibilityResult> {
    assertCloudWriteAllowed();
    if (!command.candidate.portability) {
      throw createCloudRestoreSafeSubmitError(
        { code: 'CLOUD_RESTORE_PORTABILITY_POLICY_INVALID' },
        'pre-dispatch',
      );
    }
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(CLOUD_RESTORE_PORTABILITY_PREFLIGHT_RPC, {
        p_snapshot: command.candidate.data,
        p_manifest: command.candidate.manifest,
        p_target_project_ref: command.candidate.portability.targetProjectRef,
      }));
    } catch (caughtError) {
      try { markCloudRequestFailed(caughtError); } catch { /* Keep the safe error authoritative. */ }
      throw createCloudRestoreSafeSubmitError(
        { code: 'CLOUD_RESTORE_TARGET_COMPATIBILITY_BLOCKED' },
        'pre-dispatch',
      );
    }
    if (error) {
      try { markCloudRequestFailed(error); } catch { /* Keep the safe error authoritative. */ }
      throw createCloudRestoreSafeSubmitError(
        { code: 'CLOUD_RESTORE_TARGET_COMPATIBILITY_BLOCKED' },
        'pre-dispatch',
      );
    }
    markCloudReachable();
    return assertCloudRestoreTargetCompatibilityResult(data, command.candidate);
  }

  async restoreCloudSnapshot(command: CloudRestoreCommand): Promise<CloudRestoreResult> {
    assertCloudWriteAllowed();
    if (command.confirmation !== 'OVERWRITE CLOUD DATA') {
      throw createCloudRestoreSafeSubmitError(
        { code: 'CLOUD_RESTORE_EXPLICIT_CONFIRMATION_REQUIRED' },
        'pre-dispatch',
      );
    }
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(CLOUD_RESTORE_RPC, {
        p_idempotency_key: command.idempotencyKey,
        p_snapshot_fingerprint: command.candidate.manifest.snapshotFingerprint,
        p_snapshot: command.candidate.data,
        p_manifest: command.candidate.manifest,
        p_source_environment: command.candidate.sourceEnvironment,
      }));
    } catch (caughtError) {
      try { markCloudRequestFailed(caughtError); } catch { /* Raw error inspection must not replace the safe failure. */ }
      const safeError = createCloudRestoreSafeSubmitError(caughtError, 'transport');
      const visible = normalizeCloudRestoreSubmitError(safeError, 'rpc', {
        source: 'transport',
        attemptCorrelationId: command.attemptCorrelationId,
      });
      recordCloudRestoreSubmitDiagnostic({
        event: 'rpc-error',
        phase: 'rpc',
        outcome: visible.outcome,
        attemptCorrelationId: command.attemptCorrelationId,
        idempotencyKey: command.idempotencyKey,
        error: visible,
      });
      throw safeError;
    }
    if (error) {
      try { markCloudRequestFailed(error); } catch { /* Raw error inspection must not replace the safe failure. */ }
      const safeError = createCloudRestoreSafeSubmitError(error, 'server-response');
      const visible = normalizeCloudRestoreSubmitError(safeError, 'rpc', {
        source: 'server-response',
        attemptCorrelationId: command.attemptCorrelationId,
      });
      recordCloudRestoreSubmitDiagnostic({
        event: 'rpc-error',
        phase: 'rpc',
        outcome: visible.outcome,
        attemptCorrelationId: command.attemptCorrelationId,
        idempotencyKey: command.idempotencyKey,
        error: visible,
      });
      throw safeError;
    }
    markCloudReachable();
    let result: CloudRestoreResult;
    try {
      result = assertCloudRestoreServerResult(data);
    } catch (resultError) {
      const safeError = createCloudRestoreSafeSubmitError(resultError, 'server-response');
      const visible = normalizeCloudRestoreSubmitError(safeError, 'rpc', {
        source: 'server-response',
        attemptCorrelationId: command.attemptCorrelationId,
      });
      recordCloudRestoreSubmitDiagnostic({
        event: 'rpc-error',
        phase: 'rpc',
        outcome: visible.outcome,
        attemptCorrelationId: command.attemptCorrelationId,
        idempotencyKey: command.idempotencyKey,
        error: visible,
      });
      throw safeError;
    }
    recordCloudRestoreSubmitDiagnostic({
      event: 'rpc-response',
      phase: 'rpc',
      outcome: 'success',
      attemptCorrelationId: command.attemptCorrelationId,
      idempotencyKey: command.idempotencyKey,
    });
    return preserveCloudRestoreSuccessThroughRefresh(
      result,
      () => this.mutationCache.refresh({
        reason: 'reconnect',
        resources: ['products', 'purchases', 'privateOrders', 'inventory', 'bundles', 'japanPackages', 'outboundShipments', 'salesOrders'],
        changes: [],
      }),
      {
        attemptCorrelationId: command.attemptCorrelationId,
        idempotencyKey: command.idempotencyKey,
      },
    );
  }

  private async applyCloudFieldMutations(
    entity: CloudMutableEntity,
    operations: CloudFieldMutationOperation[],
  ): Promise<void> {
    if (operations.length === 0) return;
    const ids = operations.map(operation => operation.id);
    assertCloudWriteAllowed();
    markLocalCloudWrite(entity, ids);
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc('erp_apply_field_mutations', {
        p_entity: entity,
        p_operations: operations,
      }));
    } catch (caughtError) {
      clearLocalCloudWrites(entity, ids);
      markCloudRequestFailed(caughtError);
      throw caughtError;
    }
    if (error) {
      clearLocalCloudWrites(entity, ids);
      markCloudRequestFailed(error);
      throw error;
    }
    markCloudReachable();
    try {
      assertCloudFieldMutationSucceeded(data, entity);
    } catch (mutationError) {
      clearLocalCloudWrites(entity, ids);
      if (isCloudFieldMutationError(mutationError)) notifyCloudFieldMutationConflict(mutationError);
      throw mutationError;
    }
    await this.refreshAcknowledgedCloudRows(entity, ids.map(databaseId => ({ databaseId })));
  }

  private async applyCloudCollection(
    entity: CloudMutableEntity,
    currentRows: unknown[],
    nextRows: unknown[],
    options: { deleteMissing?: boolean } = {},
  ): Promise<void> {
    const current = currentRows.map(row => toCloudFieldRow(entity, row));
    const next = nextRows.map(row => toCloudFieldRow(entity, row));
    const operations = buildCloudCollectionMutationPlan(entity, current, next, options);
    await this.applyCloudFieldMutations(entity, operations);
  }

  private async deleteCloudProductGroupTrees(groupIds: string[]): Promise<void> {
    const [groups, categories, variants] = await Promise.all([
      db.getProductGroups(),
      db.getProductCategories(),
      db.getProductVariants(),
    ]);
    const groupSet = new Set(groupIds);
    const selectedGroups = groups.filter(group => groupSet.has(group.id));
    if (selectedGroups.length !== groupSet.size) throw new Error('CLOUD_GROUP_DELETE_BASE_MISSING');
    const expected = selectedGroups.map(group => ({
      id: String(toCloudFieldRow('product_groups', group).id),
      expectedVersion: Number(toCloudFieldRow('product_groups', group).version),
      categories: categories.filter(category => category.product_group_id === group.id).map(category => ({
        id: String(toCloudFieldRow('product_categories', category).id),
        expectedVersion: Number(toCloudFieldRow('product_categories', category).version),
      })),
      variants: variants.filter(variant => variant.product_group_id === group.id).map(variant => ({
        id: String(toCloudFieldRow('product_variants', variant).id),
        expectedVersion: Number(toCloudFieldRow('product_variants', variant).version),
      })),
    }));
    if (expected.some(group => !Number.isInteger(group.expectedVersion)
      || group.categories.some(category => !Number.isInteger(category.expectedVersion))
      || group.variants.some(variant => !Number.isInteger(variant.expectedVersion)))) {
      throw new Error('CLOUD_MUTATION_VERSION_REQUIRED');
    }

    const idsByTable = {
      product_groups: expected.map(group => group.id),
      product_categories: expected.flatMap(group => group.categories.map(category => category.id)),
      product_variants: expected.flatMap(group => group.variants.map(variant => variant.id)),
    };
    Object.entries(idsByTable).forEach(([table, ids]) => markLocalCloudWrite(table, ids));
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc('erp_delete_product_group_trees', { p_groups: expected }));
    } catch (caughtError) {
      Object.entries(idsByTable).forEach(([table, ids]) => clearLocalCloudWrites(table, ids));
      markCloudRequestFailed(caughtError);
      throw caughtError;
    }
    if (error) {
      Object.entries(idsByTable).forEach(([table, ids]) => clearLocalCloudWrites(table, ids));
      markCloudRequestFailed(error);
      throw error;
    }
    markCloudReachable();
    try {
      assertCloudFieldMutationSucceeded(data, 'product_groups');
    } catch (mutationError) {
      Object.entries(idsByTable).forEach(([table, ids]) => clearLocalCloudWrites(table, ids));
      if (isCloudFieldMutationError(mutationError)) notifyCloudFieldMutationConflict(mutationError);
      throw mutationError;
    }
    await Promise.all(Object.entries(idsByTable).map(([table, ids]) => (
      this.refreshAcknowledgedCloudRows(table, ids.map(databaseId => ({ databaseId })))
    )));
  }

  private async refreshAcknowledgedCloudRows(
    table: string,
    identities: Array<{ databaseId: string; canonicalId?: string }>,
  ): Promise<void> {
    const resource = CLOUD_TABLE_RESOURCE[table];
    if (!resource) throw new Error(`Unsupported Cloud mutation cache table: ${table}`);
    const unique = [...new Map(identities
      .filter(identity => identity.databaseId)
      .map(identity => [identity.databaseId, identity])).values()];
    if (unique.length === 0) return;
    await this.mutationCache.refresh({
      reason: 'realtime',
      resources: [resource],
      changes: unique.map(identity => ({
        table,
        databaseId: identity.databaseId,
        canonicalId: identity.canonicalId || identity.databaseId,
        localId: identity.canonicalId || null,
        resource,
        kind: 'UPDATE',
        origin: 'local',
      })),
    });
  }

  private isPulled = false;
  private pullPromise: Promise<void> | null = null;
  private corePullCompletionPromise: Promise<void> | null = null;
  private authoritativeCacheGeneration = 0;
  private cachedRole: 'owner' | 'staff' | 'viewer' | 'helper' | null = null;
  private cachedRoleUserId: string | null = null;

  private async requireCloudWritePermission(): Promise<void> {
    if (!(await this.canWriteCloud())) {
      throw new Error('目前帳號沒有雲端寫入權限，快取未變更。');
    }
  }

  async getRole(): Promise<'owner' | 'staff' | 'viewer' | 'helper' | null> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      this.cachedRole = null;
      this.cachedRoleUserId = null;
      return null;
    }
    
    const userId = session.user.id;
    if (this.cachedRoleUserId === userId && this.cachedRole !== null) {
      return this.cachedRole;
    }
    
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('user_id', userId)
        .single();
      
      if (error || !data) {
        if (error) markCloudRequestFailed(error);
        return null;
      }
      markCloudReachable();
      
      this.cachedRole = data.role as any;
      this.cachedRoleUserId = userId;
      return this.cachedRole;
    } catch (e) {
      return null;
    }
  }

  async canWriteCloud(): Promise<boolean> {
    assertCloudWriteAllowed();
    const role = await this.getRole();
    return role === 'owner' || role === 'staff' || role === 'helper';
  }

  async testConnection(): Promise<string> {
    try {
      const { data, error } = await supabase
        .from('erp_healthcheck')
        .select('message')
        .limit(1);

      if (error) {
        throw error;
      }

      if (data && data.length > 0) {
        return data[0].message || 'Success';
      }
      return 'Connected, but no test data found.';
    } catch (err: any) {
      console.error('Supabase connection test failed:', err);
      throw new Error(err.message || 'Connection failed');
    }
  }

  /**
   * Phase 3-E-1: 從 Supabase 抓取 3 張核心商品資料表並快取至本地的唯讀同步程序
   * 已修正：增加等待 Supabase Auth 驗證狀態初始化，避免未載入 Session 即以匿名 (anon) 身份拉取空資料。
   */
  async pullCoreProductData(force = false): Promise<void> {
    const SYNC_VERSION = 'v2_pagination';
    const currentSyncVer = localStorage.getItem('erp_cloud_cache_sync_version');
    let shouldForce = force;
    if (currentSyncVer !== SYNC_VERSION) {
      console.log(`[Sync] Sync version mismatch (found ${currentSyncVer || 'none'}, expected ${SYNC_VERSION}). Forcing full pull...`);
      shouldForce = true;
      localStorage.setItem('erp_cloud_cache_sync_version', SYNC_VERSION);
    }

    if (shouldForce) {
      this.isPulled = false;
      this.pullPromise = null;
    }
    if (this.isPulled) return;
    if (this.pullPromise) return this.pullPromise;
    const startingAuthoritativeGeneration = this.authoritativeCacheGeneration;

    const syncPromise = (async () => {
      try {
        try {
          markCloudReadLoading();
          console.log('[Sync] 正在等待 Supabase 驗證狀態初始化...');
          
          // 等待並獲取當前登入的 session，確保 JWT token 已載入 client
          const { data: { session } } = await supabase.auth.getSession();
          
          if (!session) {
            console.warn('[Sync] Supabase 尚未偵測到有效登入 Session，略過雲端 Pull 以避免覆蓋本機資料。');
            const cachedGroups = await db.getProductGroups();
            markCloudReadFailed(new Error('Cloud session unavailable'), cachedGroups.length > 0);
            return;
          }

          console.log(`[Sync] 已驗證登入身份: ${session.user.email}，正在從 Supabase 進行商品核心主檔（Groups, Categories, Variants）的全量只讀同步...`);
          
          // 1. 同時從 Supabase 抓取未刪除的資料，並支援分頁處理
          const [groups, categories, variants, batches, batchItems, po, poi, jp, jpi] = await Promise.all([
            fetchAll<any>(async (from, to) => supabase.from('product_groups').select('*').is('deleted_at', null).order('id').range(from, to)),
            fetchAll<any>(async (from, to) => supabase.from('product_categories').select('*').is('deleted_at', null).order('id').range(from, to)),
            fetchAll<any>(async (from, to) => supabase.from('product_variants').select('*').is('deleted_at', null).order('id').range(from, to)),
            fetchAll<any>(async (from, to) => supabase.from('purchase_batches').select('*').is('deleted_at', null).order('id').range(from, to)),
            fetchAll<any>(async (from, to) => supabase.from('purchase_batch_items').select('*').is('deleted_at', null).order('id').range(from, to)),
            fetchAll<any>(async (from, to) => supabase.from('private_orders').select('*').is('deleted_at', null).order('id').range(from, to)),
            fetchAll<any>(async (from, to) => supabase.from('private_order_items').select('*').is('deleted_at', null).order('id').range(from, to)),
            fetchAll<any>(async (from, to) => supabase.from('japan_packages').select('*').is('deleted_at', null).order('id').range(from, to)),
            fetchAll<any>(async (from, to) => supabase.from('japan_package_items').select('*').is('deleted_at', null).order('id').range(from, to))
          ]);
          const [bcData, osData, osiData, salesOrderRows, salesOrderItemRows, inventoryRows, dashboardImageRows] = await Promise.all([
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fetchAll<any>(async (from, to) => supabase.from('bundle_components').select('*').order('id').range(from, to)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fetchAll<any>(async (from, to) => supabase.from('outbound_shipments').select('*').is('deleted_at', null).order('id').range(from, to)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fetchAll<any>(async (from, to) => supabase.from('outbound_shipment_items').select('*').is('deleted_at', null).order('id').range(from, to)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fetchAll<any>(async (from, to) => supabase.from('sales_orders').select('*').is('deleted_at', null).order('id').range(from, to)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fetchAll<any>(async (from, to) => supabase.from('sales_order_items').select('*').is('deleted_at', null).order('id').range(from, to)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fetchAll<any>(async (from, to) => supabase.from('inventory_items').select('*').is('deleted_at', null).order('inventory_key').range(from, to)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fetchAll<any>(async (from, to) => supabase.from('dashboard_category_images').select('category_key, image_url, storage_path').is('deleted_at', null).order('category_key').range(from, to)),
          ]);

          const gLen = groups.length;
          const cLen = categories.length;
          const vLen = variants.length;
          const bLen = batches.length;
          const biLen = batchItems.length;
          const poLen = po.length;
          const poiLen = poi.length;

          console.log(`[Sync] 從 Supabase 成功拉取到資料：product_groups = ${gLen} 筆, product_categories = ${cLen} 筆, product_variants = ${vLen} 筆, purchase_batches = ${bLen} 筆, purchase_batch_items = ${biLen} 筆, private_orders = ${poLen} 筆, private_order_items = ${poiLen} 筆`);
          console.log(`[Cloud Pull] pulled groups count: ${gLen}`);
          console.log(`[Cloud Pull] pulled variants count: ${vLen}`);
          console.log('[Cloud Pull] variants sample:', variants.length > 0 ? JSON.stringify(variants[0]) : 'empty');
          console.log('[Default Cost Sync] cloud pulled sample:', variants.length > 0 ? JSON.stringify(variants[0]) : 'empty');
          console.log(`[Private Order Sync] cloud pulled orders count: ${poLen}`);
          console.log(`[Private Order Sync] cloud pulled items count: ${poiLen}`);

          // A. Auth/session role check
          const role = await this.getRole();
          console.log(`[Cloud Pull Guard] session ok: ${session.user.email} | role: ${role || 'null'}`);
          if (!role) {
            const roleMsg = `[Cloud Pull Guard] User role is unreadable or null. Aborting sync.`;
            console.warn(roleMsg);
            console.log('[Cloud Pull Guard] abort sync to prevent pushing stale local cache');
            console.log('[Cloud Pull Guard] keep local cache');
            throw new Error(roleMsg);
          }

          // B. Pull 結果完整性防呆
          const localGroups = await db.getProductGroups();
          const localVariants = await db.getProductVariants();
          const localSalesOrders = await db.getSalesOrders();
          const localSalesOrderItems = await db.getSalesOrderItems();

          const lg = localGroups.length;
          const lv = localVariants.length;
          const lso = localSalesOrders.length;
          const lsoi = localSalesOrderItems.length;

          console.log(`[Cloud Pull Guard] local counts - groups: ${lg}, variants: ${lv}, orders: ${lso}, items: ${lsoi}`);
          console.log(`[Cloud Pull Guard] remote counts - groups: ${gLen}, variants: ${vLen}`);

          // A complete successful response is authoritative even when it contains zero rows.
          // The Cloud cache must reflect that empty server state instead of reviving stale rows.

          // 2. 將雲端拉回的資料覆寫寫入本地 IndexedDB / LocalStorage 快取
          console.log(`[Sync] 正在寫入本地快取：groups: ${gLen} 筆, categories: ${cLen} 筆, variants: ${vLen} 筆, batches: ${bLen} 筆, batchItems: ${biLen} 筆, privateOrders: ${poLen} 筆, privateOrderItems: ${poiLen} 筆`);
          
          console.log(`[Before IndexedDB Save Variants] count: ${variants.length}`);
          console.log('[Before IndexedDB Save Variants] sample:', variants.length > 0 ? JSON.stringify(variants[0]) : 'empty');
          const mappedBatchItems = batchItems.map((r: any) => ({
            id: r.local_id || r.id,
            database_id: r.id,
            purchase_batch_id: r.purchase_batch_id,
            product_variant_id: r.product_variant_id,
            quantity: r.quantity || 0,
            cost: Number(r.cost ?? 0),
            note: r.note || '',
            updated_at: r.updated_at,
            version: r.version
          }));
          const mappedOrders: PrivateOrder[] = po.map(r => ({
            id: r.local_id || r.id,
            database_id: r.id,
            product_group_id: r.product_group_id,
            customer_name: r.customer_name,
            contact: r.contact || '',
            note: r.note || '',
            created_at: r.created_at,
            updated_at: r.updated_at,
            version: r.version
          }));

          const mappedItems: PrivateOrderItem[] = poi.map(r => ({
            id: r.local_id || r.id,
            database_id: r.id,
            private_order_id: r.private_order_id,
            product_variant_id: r.product_variant_id,
            quantity: r.quantity || 0,
            amount: Number(r.amount || 0),
            note: r.note || '',
            updated_at: r.updated_at,
            version: r.version
          }));

          // Japan Packages Sync
          const mappedPackages = jp.map((r: any) => ({
            id: r.id,
            title: r.title,
            vendor_name: r.vendor_name || '',
            carrier: r.carrier || '',
            tracking_number: r.tracking_number || '',
            shipped_at: r.shipped_at || '',
            expected_arrival_at: r.expected_arrival_at || '',
            arrived_at: r.arrived_at || '',
            status: r.status || 'registered',
            note: r.note || '',
            created_at: r.created_at,
            updated_at: r.updated_at,
            version: r.version
          }));
          const mappedPackageItems = jpi.map((r: any) => ({
            id: r.id,
            japan_package_id: r.japan_package_id,
            product_group_id: r.product_group_id || null,
            product_variant_id: r.product_variant_id || null,
            purchase_batch_id: r.purchase_batch_id || null,
            purchase_batch_item_id: r.purchase_batch_item_id || null,
            product_title: r.product_title || '',
            category_name: r.category_name || '',
            variant_name: r.variant_name || '',
            sku: r.sku || '',
            quantity: Number(r.quantity ?? 1),
            note: r.note || '',
            checked: Boolean(r.checked ?? false),
            checked_at: r.checked_at || null,
            created_at: r.created_at,
            updated_at: r.updated_at,
            version: r.version
          }));
          console.log(`[Sync] 從 Supabase 成功拉取到 bundle_components = ${bcData.length} 筆`);
          const mappedBundleComponents: BundleComponent[] = bcData.map(r => ({
            id: r.id,
            database_id: r.id,
            bundle_variant_id: r.bundle_variant_id,
            component_variant_id: r.component_variant_id,
            created_at: r.created_at,
            updated_at: r.updated_at,
            version: r.version
          }));
          console.log(`[Sync] 從 Supabase 成功拉取到 outbound_shipments = ${osData.length} 筆, outbound_shipment_items = ${osiData.length} 筆`);
          const mappedShipments: OutboundShipment[] = osData.map(r => ({
            id: r.id, title: r.title, status: r.status || 'draft',
            carrier: r.carrier || '', tracking_number: r.tracking_number || '',
            weight_kg: r.weight_kg ? Number(r.weight_kg) : undefined,
            shipping_cost: r.shipping_cost ? Number(r.shipping_cost) : undefined,
            shipped_at: r.shipped_at || '', received_at: r.received_at || '',
            note: r.note || '', created_at: r.created_at, updated_at: r.updated_at, version: r.version
          }));
          const mappedShipmentItems: OutboundShipmentItem[] = osiData.map(r => ({
            id: r.id, outbound_shipment_id: r.outbound_shipment_id,
            japan_package_item_id: r.japan_package_item_id || null,
            product_group_id: r.product_group_id || null,
            product_variant_id: r.product_variant_id || null,
            product_title: r.product_title || '', variant_name: r.variant_name || '',
            sku: r.sku || '', quantity: Number(r.quantity ?? 1),
            checked: Boolean(r.checked ?? false), checked_at: r.checked_at || null,
            note: r.note || '', created_at: r.created_at, updated_at: r.updated_at, version: r.version
          }));
          const mappedSalesOrders: SalesOrder[] = salesOrderRows.map(r => ({
            id: r.local_id || r.id,
            database_id: r.id,
            platform: r.platform,
            order_number: r.order_number,
            buyer_name: r.buyer_name,
            created_at: r.created_at,
            updated_at: r.updated_at,
            version: r.version
          }));
          const orderUuidToLocalIdMap = new Map<string, string>();
          for (const order of mappedSalesOrders) {
            const uuid = getDeterministicUuid(order.id.trim().toUpperCase());
            orderUuidToLocalIdMap.set(uuid, order.id);
          }
          const mappedSalesOrderItems: SalesOrderItem[] = salesOrderItemRows.map(r => ({
            id: r.local_id || r.id,
            database_id: r.id,
            order_database_id: r.order_id,
            order_id: orderUuidToLocalIdMap.get(r.order_id) || r.order_id,
            product_variant_id: r.product_variant_id || undefined,
            myacg_item_code: r.myacg_item_code,
            product_name: r.product_name || undefined,
            variant_name: r.variant_name || undefined,
            quantity: r.quantity,
            price: r.price !== null ? Number(r.price) : undefined,
            amount: r.amount !== null ? Number(r.amount) : undefined,
            order_status: r.order_status || undefined,
            updated_at: r.updated_at,
            version: r.version
          }));
          const mappedInventory: InventoryItem[] = inventoryRows.map(r => ({
            id: r.id,
            database_id: r.id,
            inventory_key: r.inventory_key || `${normalizeProductTitle(r.product_title)}::${r.myacg_item_code}::${r.raw_variant_name || ''}`,
            myacg_item_code: r.myacg_item_code,
            product_id: r.product_id || undefined,
            product_title: r.product_title,
            normalized_product_title: r.normalized_product_title || undefined,
            raw_variant_name: r.raw_variant_name || '',
            listing_type: r.listing_type || '',
            final_price: r.final_price || 0,
            myacg_available_quantity: r.myacg_available_quantity || 0,
            myacg_sold_quantity: r.myacg_sold_quantity || 0,
            myacg_demand_quantity: r.myacg_demand_quantity || undefined,
            myacg_listed_at: r.myacg_listed_at || '',
            import_sort_index: r.import_sort_index || undefined,
            latest_catalog_import_id: r.latest_catalog_import_id || undefined,
            catalog_last_seen_at: r.catalog_last_seen_at || undefined,
            updated_at: r.updated_at,
            version: r.version
          }));

          // A successful Cloud read is applied as one all-or-nothing cache transaction.
          // Until this point every operation is read-only, so any failed/timeout request
          // leaves the previous Cloud cache intact.
          const cacheApplied = await db.importData(JSON.stringify({
            inventory: mappedInventory,
            salesOrders: mappedSalesOrders,
            salesOrderItems: mappedSalesOrderItems,
            productGroups: groups,
            productCategories: categories,
            productVariants: variants,
            purchaseBatches: batches,
            purchaseBatchItems: mappedBatchItems,
            privateOrders: mappedOrders,
            privateOrderItems: mappedItems,
            japanPackages: mappedPackages,
            japanPackageItems: mappedPackageItems,
            outboundShipments: mappedShipments,
            outboundShipmentItems: mappedShipmentItems,
            bundleComponents: mappedBundleComponents,
            importBatches: [],
          }));
          if (!cacheApplied) throw new Error('Cloud cache atomic replacement failed');
          this.authoritativeCacheGeneration += 1;

          // Dashboard images are cache-only and are replaced only after the complete
          // server read and IndexedDB transaction have succeeded.
          for (let index = localStorage.length - 1; index >= 0; index -= 1) {
            const key = localStorage.key(index);
            if (key?.startsWith('dashboard_cloud_img_') || key?.startsWith('dashboard_cloud_path_')) {
              localStorage.removeItem(key);
            }
          }
          dashboardImageRows.forEach(item => {
            if (!item.category_key) return;
            if (item.image_url) localStorage.setItem(`dashboard_cloud_img_${item.category_key}`, item.image_url);
            if (item.storage_path) localStorage.setItem(`dashboard_cloud_path_${item.category_key}`, item.storage_path);
          });

          this.isPulled = true;
          const completeCloudRowCount = gLen + cLen + vLen + bLen + biLen + poLen + poiLen
            + jp.length + jpi.length + bcData.length + osData.length + osiData.length
            + mappedSalesOrders.length + mappedSalesOrderItems.length + mappedInventory.length
            + dashboardImageRows.length;
          markCloudReadFresh(completeCloudRowCount);
          console.log(`[Sync Pull] core applied: groups ${gLen} categories ${cLen} variants ${vLen} batches ${bLen} batchItems ${biLen}`);

          checkDataSizeWarnings({
            product_variants: vLen,
            purchase_batch_items: biLen,
            private_order_items: poiLen,
          }, role);
        } catch (err: any) {
          console.error('[Sync] 商品核心主檔同步失敗:', err);
          const cachedRows = await Promise.all([
            db.getProductGroups(),
            db.getProductCategories(),
            db.getProductVariants(),
            db.getPurchaseBatches(),
            db.getPurchaseBatchItems(),
            db.getPrivateOrders(),
            db.getPrivateOrderItems(),
          ]);
          markCloudReadFailed(err, cachedRows.some(rows => rows.length > 0));
          if (isSchemaMissingError(err)) {
            alert(`雲端資料庫結構缺失：${err.message || JSON.stringify(err)}。同步流程已中斷，請聯絡管理員匯入 SQL Migration 補建表格！`);
            this.isPulled = false;
            throw err;
          }
          console.log('[Sync Pull] core failed: keep local cache');
        }
      } finally {
        this.pullPromise = null;
      }
    })();

    this.corePullCompletionPromise = syncPromise;

    const syncTimeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Cloud sync timed out after 4000ms')), 4000);
    });

    this.pullPromise = Promise.race([syncPromise, syncTimeout]).catch(async err => {
      console.warn('[Sync Timeout Fallback] Sync failed or timed out. Falling back to local cache.', err);
      // The detached authoritative pull continues after the four-second UI boundary.
      // If it committed while this fallback was being scheduled, it is newer than the
      // timeout and must not be downgraded back to stale or made eligible for a second pull.
      if (this.authoritativeCacheGeneration > startingAuthoritativeGeneration) return;
      const cachedRows = await Promise.all([
        db.getProductGroups(),
        db.getProductCategories(),
        db.getProductVariants(),
        db.getPurchaseBatches(),
        db.getPurchaseBatchItems(),
        db.getPrivateOrders(),
        db.getPrivateOrderItems(),
      ]);
      if (this.authoritativeCacheGeneration > startingAuthoritativeGeneration) return;
      markCloudReadFailed(err, cachedRows.some(rows => rows.length > 0));
      this.isPulled = false;
    });

    return this.pullPromise;
  }

  async waitForCloudBootstrapConvergence(): Promise<boolean> {
    const startingGeneration = this.authoritativeCacheGeneration;
    void this.pullCoreProductData().catch(() => undefined);
    const completion = this.corePullCompletionPromise;
    if (!completion) return false;
    try {
      await completion;
    } catch {
      return false;
    }
    return this.authoritativeCacheGeneration > startingGeneration;
  }

  async getInventoryCatalogSnapshot(): Promise<{
    inventory: InventoryItem[];
    productGroups: ProductGroup[];
  }> {
    return db.getCloudInventoryCatalogSnapshot();
  }

  // === 3 張 Synced 表讀取 (Pull 後從本地快取讀取) ===
  async getProductGroups(): Promise<ProductGroup[]> {
    await this.pullCoreProductData();
    const data = await db.getProductGroups();
    console.log(`[IndexedDB Get Groups] count: ${data.length}`);
    return data;
  }

  async getProductCategories(): Promise<ProductCategory[]> {
    await this.pullCoreProductData();
    const data = await db.getProductCategories();
    console.log(`[IndexedDB Get Categories] count: ${data.length}`);
    return data;
  }

  async getProductVariants(options?: { recalc?: boolean }): Promise<ProductVariant[]> {
    try {
      await this.pullCoreProductData();
    } catch (err) {
      console.warn('[Sync] pullCoreProductData failed in getProductVariants, falling back to local cache', err);
    }
    const data = await db.getProductVariants(options);
    console.log(`[IndexedDB Read Variants] count: ${data.length}`);
    return data;
  }

  async saveProductGroups(groups: ProductGroup[]): Promise<void> {
    await this.requireCloudWritePermission();
    const currentLocalGroups = await db.getProductGroups();
    const sanitizedGroups: ProductGroup[] = [];
    let categoriesWithRekeyedParents: ProductCategory[] | null = null;
    let variantsWithRekeyedParents: ProductVariant[] | null = null;
    for (const g of groups) {
      if (!isValidUuid(g.id)) {
        const newId = generateFallbackUuid();
        console.warn(`[UUID Stabilization] Detected invalid Group ID "${g.id}". Regenerated to "${newId}".`);
        
        // Update any child categories in IndexedDB
        const cats: ProductCategory[] = categoriesWithRekeyedParents ?? await db.getProductCategories();
        const childCats = cats.filter(c => c.product_group_id === g.id);
        if (childCats.length > 0) {
          childCats.forEach(c => c.product_group_id = newId);
          categoriesWithRekeyedParents = cats;
        }

        // Update any child variants in IndexedDB
        const vars: ProductVariant[] = variantsWithRekeyedParents ?? await db.getProductVariants();
        const childVars = vars.filter(v => v.product_group_id === g.id);
        if (childVars.length > 0) {
          childVars.forEach(v => v.product_group_id = newId);
          variantsWithRekeyedParents = vars;
        }

        sanitizedGroups.push({ ...g, id: newId });
      } else {
        sanitizedGroups.push(g);
      }
    }

    // 2. 如果傳入陣列為空，直接略過，不向 Supabase 發送 upsert
    if (sanitizedGroups.length === 0) {
      return;
    }

    try {
      // 篩選出合法 UUID 的資料
      const validGroups = changedOrNewRows(currentLocalGroups, sanitizedGroups).filter(g => isValidUuid(g.id));

      if (validGroups.length === 0) {
        console.log('[Sync Push] product_groups skipped: no valid rows');
        return;
      }

      console.log(`[Cloud Push] product_groups count: ${validGroups.length}`);

      await this.applyCloudCollection('product_groups', currentLocalGroups, sanitizedGroups, { deleteMissing: false });
      if (categoriesWithRekeyedParents) await this.saveProductCategories(categoriesWithRekeyedParents);
      if (variantsWithRekeyedParents) await this.saveProductVariants(variantsWithRekeyedParents);

      {
        console.log(`[Sync Push] product_groups field mutation success: ${validGroups.length} candidate rows`);
      }
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步商品群組發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    await this.requireCloudWritePermission();
    // Identify deleted ones by comparing with current local storage records, BEFORE it gets
    // overwritten below. Without this, a caller that just omits a category from the array
    // (e.g. reparseProductVariants()'s empty-category cleanup) only ever removes it locally --
    // product_categories.deleted_at is never set in Supabase, so the next pullCoreProductData()
    // pulls it right back.
    const currentLocalCategories = await db.getProductCategories();

    const sanitizedCategories = [];
    const groups = await db.getProductGroups();
    const vars = await db.getProductVariants();
    let categoriesChanged = false;
    let variantsChanged = false;

    for (const c of categories) {
      const updatedCat = { ...c };

      // Ensure Category ID is valid UUID
      if (!isValidUuid(c.id)) {
        const newCatId = generateFallbackUuid();
        console.warn(`[UUID Stabilization] Detected invalid Category ID "${c.id}". Regenerated to "${newCatId}".`);
        updatedCat.id = newCatId;
        categoriesChanged = true;

        // Cascade to product_variants in IndexedDB
        const childVars = vars.filter(v => v.product_category_id === c.id);
        if (childVars.length > 0) {
          childVars.forEach(v => {
            v.product_category_id = newCatId;
          });
          variantsChanged = true;
        }
      }

      // Ensure product_group_id is valid UUID
      if (!isValidUuid(updatedCat.product_group_id)) {
        // Try to find the group by title if the invalid ID is actually a title
        const matchingGroup = groups.find(g => g.id === updatedCat.product_group_id || g.title === updatedCat.product_group_id);
        if (matchingGroup && isValidUuid(matchingGroup.id)) {
          updatedCat.product_group_id = matchingGroup.id;
          categoriesChanged = true;
        } else {
          const newGroupId = generateFallbackUuid();
          console.warn(`[UUID Stabilization] Category "${updatedCat.title}" has invalid Group ID "${updatedCat.product_group_id}". Generated fallback Group ID "${newGroupId}".`);
          updatedCat.product_group_id = newGroupId;
          categoriesChanged = true;
        }
      }

      sanitizedCategories.push(updatedCat);
    }

    const finalCategories = categoriesChanged ? sanitizedCategories : categories;

    try {
      // (A) Handle soft deletion of categories removed from the incoming set
      const finalIds = new Set(finalCategories.map(c => c.id));
      const removedCategories = currentLocalCategories.filter(c => !finalIds.has(c.id));
      if (removedCategories.length > 0) {
        const removedIds = removedCategories.map(c => c.id).filter(isValidUuid);
        if (removedIds.length > 0) {
          console.log(`[Sync Push] product_categories marking deleted_at: ${removedIds.length} rows`);
        }
      }

      // (B) 如果傳入陣列為空，直接略過，不向 Supabase 發送 upsert
      if (finalCategories.length === 0) {
        await this.applyCloudCollection('product_categories', currentLocalCategories, finalCategories);
        return;
      }

      // 篩選出具備合法 UUID 之 id 與 product_group_id 的分類資料
      const validCategories = finalCategories.filter(c =>
        isValidUuid(c.id) && isValidUuid(c.product_group_id)
      );

      if (validCategories.length === 0) {
        console.log('[Sync Push] product_categories skipped: no valid rows');
        await this.refreshAcknowledgedCloudRows('product_categories', removedCategories.map(category => ({ databaseId: category.id })));
        return;
      }

      console.log(`[Cloud Push] product_categories count: ${validCategories.length}`);

      await this.applyCloudCollection('product_categories', currentLocalCategories, finalCategories);
      if (variantsChanged) await this.saveProductVariants(vars);

      {
        console.log(`[Sync Push] product_categories field mutation success: ${validCategories.length} candidate rows`);
      }
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步商品分類發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  /**
   * WARNING: Do NOT use this method for single-field UI updates.
   * This is reserved for bulk import or full synchronization.
   * For single-field or local updates, use updateProductVariantPatch instead.
   */
  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    await this.requireCloudWritePermission();
    if (!variants || variants.length === 0) {
      console.warn("[Sync Push] SKIP saveProductVariants because variants array is empty");
      return;
    }
    const sanitizedVariants = [];
    const groups = await db.getProductGroups();
    const categories = await db.getProductCategories();
    let variantsChanged = false;

    for (const v of variants) {
      const updatedVar = { ...v };

      // Ensure Variant ID is valid UUID
      if (!isValidUuid(v.id)) {
        const newVarId = generateFallbackUuid();
        console.warn(`[UUID Stabilization] Detected invalid Variant ID "${v.id}". Regenerated to "${newVarId}".`);
        updatedVar.id = newVarId;
        variantsChanged = true;
      }

      // Ensure product_group_id is valid UUID
      if (!isValidUuid(updatedVar.product_group_id)) {
        const matchingGroup = groups.find(g => g.id === updatedVar.product_group_id || g.title === updatedVar.product_group_id);
        if (matchingGroup && isValidUuid(matchingGroup.id)) {
          updatedVar.product_group_id = matchingGroup.id;
          variantsChanged = true;
        } else {
          const newGroupId = generateFallbackUuid();
          console.warn(`[UUID Stabilization] Variant "${updatedVar.variant_name}" has invalid Group ID "${updatedVar.product_group_id}". Generated fallback Group ID "${newGroupId}".`);
          updatedVar.product_group_id = newGroupId;
          variantsChanged = true;
        }
      }

      // Ensure product_category_id is either valid UUID or null
      if (updatedVar.product_category_id !== undefined && updatedVar.product_category_id !== null) {
        if (!isValidUuid(updatedVar.product_category_id)) {
          const matchingCat = categories.find(c => c.id === updatedVar.product_category_id || c.title === updatedVar.product_category_id);
          if (matchingCat && isValidUuid(matchingCat.id)) {
            updatedVar.product_category_id = matchingCat.id;
            variantsChanged = true;
          } else {
            console.warn(`[UUID Stabilization] Variant "${updatedVar.variant_name}" has invalid Category ID "${updatedVar.product_category_id}". Setting to undefined.`);
            updatedVar.product_category_id = undefined;
            variantsChanged = true;
          }
        }
      }

      sanitizedVariants.push(updatedVar);
    }

    // Read the current cache only for stale comparison. The acknowledged rows
    // are read back from Supabase before the Cloud cache is changed.
    const allLocalVars = await db.getProductVariants();
    // 2. 如果傳入陣列為空，直接略過，不向 Supabase 發送 upsert
    const finalVariants = variantsChanged ? sanitizedVariants : variants;
    if (finalVariants.length === 0) {
      return;
    }

    try {
      // 篩選出具備合法 UUID 之 id 與 product_group_id 的規格資料
      const validVariants = changedOrNewRows(allLocalVars, finalVariants).filter(v =>
        isValidUuid(v.id) && isValidUuid(v.product_group_id)
      );

      if (validVariants.length === 0) {
        console.log('[Sync Push] product_variants skipped: no valid rows');
        return;
      }

      console.log(`[Cloud Push] product_variants count: ${validVariants.length}`);

      await this.applyCloudCollection('product_variants', allLocalVars, finalVariants, { deleteMissing: false });

      console.log(`[Cloud Cache Commit] product_variants acknowledged count: ${validVariants.length}`);

      console.log(`[Sync Push] product_variants field mutation success: ${validVariants.length} candidate rows`);
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步商品規格發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void> {
    await this.requireCloudWritePermission();
    const localVariant = (await db.getProductVariants()).find(variant => variant.id === id);
    if (!localVariant) throw new Error(`Product variant not found: ${id}`);
    try {
      console.log(`[Cloud Patch] product_variants target id: ${id}, patch keys: ${Object.keys(patch).join(', ')}`);
      const base = toCloudFieldRow('product_variants', localVariant);
      const operation = buildCloudPatchOperation('product_variants', base, patch as Record<string, unknown>);
      if (operation) await this.applyCloudFieldMutations('product_variants', [operation]);

      console.log(`[Sync Patch] product_variants update success for id: ${id}`);
    } catch (err: any) {
      console.error(`[Cloud Patch ERROR] Supabase error message: ${err.message || err}`);
      if (!isCloudFieldMutationError(err)) alert(`雲端局部更新商品規格發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async updateProductVariantPatchBulk(patches: { id: string, patch: Partial<ProductVariant> }[]): Promise<void> {
    await this.requireCloudWritePermission();
    if (patches.length === 0) return;

    try {
      console.log(`[Cloud Patch Bulk] product_variants target count: ${patches.length}`);
      const allLocalVars = await db.getProductVariants();
      const byId = new Map(allLocalVars.map(variant => [variant.id, variant]));
      const operations = patches.map(item => {
        const variant = byId.get(item.id);
        if (!variant) throw new Error(`Product variant not found: ${item.id}`);
        return buildCloudPatchOperation(
          'product_variants',
          toCloudFieldRow('product_variants', variant),
          item.patch as Record<string, unknown>,
        );
      }).filter((operation): operation is CloudPatchOperation => Boolean(operation));
      await this.applyCloudFieldMutations('product_variants', operations);

      console.log(`[Sync Patch Bulk] product_variants bulk update success for count: ${patches.length}`);
    } catch (err: any) {
      console.error(`[Cloud Patch Bulk ERROR] Supabase error message: ${err.message || err}`);
      if (!isCloudFieldMutationError(err)) alert(`雲端批量局部更新商品規格發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }


  // === 4 張非 Synced 核心表與本地輔助表 (完全委託本地 db) ===
  async getInventory(): Promise<InventoryItem[]> {
    return db.getInventory();
  }

  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    await this.requireCloudWritePermission();
    const currentInventory = await db.getInventory();
    const { inventory: preparedInventory, stats } = prepareInventoryUpsert(currentInventory, items);

    await this.applyCloudCollection('inventory_items', currentInventory, preparedInventory);
    return stats;
  }

  async getSalesOrders(): Promise<SalesOrder[]> {
    return db.getSalesOrders();
  }

  async saveSalesOrders(orders: SalesOrder[]): Promise<void> {
    await this.requireCloudWritePermission();
    const currentOrders = await db.getSalesOrders();

    // 2. Cloud Mode 時 upsert sales_orders
    if (orders.length === 0) {
      return;
    }

    try {
      console.log(`[Sync Push] sales_orders preparing: ${orders.length} rows`);

      await this.applyCloudCollection('sales_orders', currentOrders, orders, { deleteMissing: false });

      console.log(`[Sync Push] sales_orders field mutation success: ${orders.length} candidate rows`);
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步銷售訂單發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async getSalesOrderItems(): Promise<SalesOrderItem[]> {
    return db.getSalesOrderItems();
  }

  async saveSalesOrderItems(items: SalesOrderItem[]): Promise<void> {
    await this.requireCloudWritePermission();
    const currentItems = await db.getSalesOrderItems();

    // 2. Cloud Mode 時 upsert sales_order_items
    if (items.length === 0) {
      return;
    }

    try {
      console.log(`[Sync Push] sales_order_items preparing: ${items.length} rows`);

      await this.applyCloudCollection('sales_order_items', currentItems, items, { deleteMissing: false });

      console.log(`[Sync Push] sales_order_items field mutation success: ${items.length} candidate rows`);
    } catch (err: any) {
      console.error(`[Cloud Push ERROR] Supabase error message: ${err.message || err}`);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步訂單明細發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async pullSalesOrders(): Promise<number> {
    try {
      const data = await fetchAll<any>(async (from, to) =>
        supabase
          .from('sales_orders')
          .select('*')
          .is('deleted_at', null)
          .order('id')
          .range(from, to)
      );

      const rso = data?.length || 0;

      console.log(`[Cloud Pull] sales_orders remote count: ${rso}`);

      const rows = data || [];
      const mappedOrders: SalesOrder[] = rows.map(r => ({
        id: r.local_id || r.id,
        database_id: r.id,
        platform: r.platform,
        order_number: r.order_number,
        buyer_name: r.buyer_name,
        created_at: r.created_at,
        updated_at: r.updated_at,
        version: r.version
      }));

      // Write directly to local DB
      await db.saveSalesOrders(mappedOrders);
      console.log(`[Sync Pull] sales_orders applied: ${mappedOrders.length} rows`);
      return mappedOrders.length;
    } catch (err: any) {
      console.error(`[Sync Pull ERROR] sales_orders failed (Schema 缺失?): ${err.message || err}`);
      if (err.message && (err.message.includes('42P01') || err.message.toLowerCase().includes('relation') || err.message.toLowerCase().includes('could not find the table'))) {
        alert('核心資料表 sales_orders 缺失，請聯絡系統管理員匯入 SQL Migration 建立表格！');
      }
      throw err;
    }
  }

  async pullSalesOrderItems(): Promise<number> {
    try {
      const data = await fetchAll<any>(async (from, to) =>
        supabase
          .from('sales_order_items')
          .select('*')
          .is('deleted_at', null)
          .order('id')
          .range(from, to)
      );

      const rsoi = data?.length || 0;

      console.log(`[Cloud Pull] sales_order_items remote count: ${rsoi}`);

      const orders = await db.getSalesOrders();
      const orderUuidToLocalIdMap = new Map<string, string>();
      for (const order of orders) {
        const uuid = getDeterministicUuid(order.id.trim().toUpperCase());
        orderUuidToLocalIdMap.set(uuid, order.id);
      }

      const rows = data || [];
      const mappedItems: SalesOrderItem[] = rows.map(r => {
        const localOrderId: string = orderUuidToLocalIdMap.get(r.order_id) || r.order_id;
        return {
          id: r.local_id || r.id,
          database_id: r.id,
          order_database_id: r.order_id,
          order_id: localOrderId,
          product_variant_id: r.product_variant_id || undefined,
          myacg_item_code: r.myacg_item_code,
          product_name: r.product_name || undefined,
          variant_name: r.variant_name || undefined,
          quantity: r.quantity,
          price: r.price !== null ? Number(r.price) : undefined,
          amount: r.amount !== null ? Number(r.amount) : undefined,
          order_status: r.order_status || undefined,
          updated_at: r.updated_at,
          version: r.version
        };
      });

      // Write directly to local DB
      await db.saveSalesOrderItems(mappedItems);
      console.log(`[Sync Pull] sales_order_items applied: ${mappedItems.length} rows`);
      return mappedItems.length;
    } catch (err: any) {
      console.error(`[Sync Pull ERROR] sales_order_items failed (Schema 缺失?): ${err.message || err}`);
      if (err.message && (err.message.includes('42P01') || err.message.toLowerCase().includes('relation') || err.message.toLowerCase().includes('could not find the table'))) {
        alert('核心資料表 sales_order_items 缺失，請聯絡系統管理員匯入 SQL Migration 建立表格！');
      }
      throw err;
    }
  }

  async pullInventory(): Promise<number> {
    try {
      const data = await fetchAll<any>(async (from, to) =>
        supabase
          .from('inventory_items')
          .select('*')
          .is('deleted_at', null)
          .order('inventory_key')
          .range(from, to)
      );

      const rinv = data?.length || 0;

      console.log(`[Inventory Sync] pulled count: ${rinv}`);

      const rows = data || [];
      const mappedItems: InventoryItem[] = rows.map(r => ({
        id: r.id,
        database_id: r.id,
        inventory_key: r.inventory_key || `${normalizeProductTitle(r.product_title)}::${r.myacg_item_code}::${r.raw_variant_name || ''}`,
        myacg_item_code: r.myacg_item_code,
        product_id: r.product_id || undefined,
        product_title: r.product_title,
        normalized_product_title: r.normalized_product_title || undefined,
        raw_variant_name: r.raw_variant_name || '',
        listing_type: r.listing_type || '',
        final_price: r.final_price || 0,
        myacg_available_quantity: r.myacg_available_quantity || 0,
        myacg_sold_quantity: r.myacg_sold_quantity || 0,
        myacg_demand_quantity: r.myacg_demand_quantity || undefined,
        myacg_listed_at: r.myacg_listed_at || '',
        import_sort_index: r.import_sort_index || undefined,
        latest_catalog_import_id: r.latest_catalog_import_id || undefined,
        catalog_last_seen_at: r.catalog_last_seen_at || undefined,
        updated_at: r.updated_at,
        version: r.version
      }));

      await db.saveInventory(mappedItems);
      console.log(`[Inventory Sync] save count: ${mappedItems.length}`);
      if (mappedItems.length > 0) {
        console.log(`[Inventory Sync] sample: ${JSON.stringify(mappedItems[0])}`);
      }
      return mappedItems.length;
    } catch (err: any) {
      console.error(`[Inventory Sync ERROR] pull failed: ${err.message || err}`);
      throw err;
    }
  }

  async getPurchaseBatches(): Promise<PurchaseBatch[]> {
    return db.getPurchaseBatches();
  }

  async savePurchaseBatches(batches: PurchaseBatch[]): Promise<void> {
    await this.requireCloudWritePermission();
    // 1. Identify deleted ones by comparing with current local storage records
    const currentLocal = await db.getPurchaseBatches();
    const incomingIds = new Set(batches.map(b => b.id));
    const removedBatches = currentLocal.filter(b => !incomingIds.has(b.id));

    // 3. Supabase Cloud Sync
    try {
      // (A) Handle soft deletion of removed batches in Supabase
      if (removedBatches.length > 0) {
        const removedIds = removedBatches.map(b => b.id).filter(isValidUuid);
        if (removedIds.length > 0) {
          console.log(`[Sync Push] purchase_batches marking deleted_at: ${removedIds.length} rows`);
        }
      }

      // (B) Upsert incoming active batches to Supabase
      const activeBatches = changedOrNewRows(currentLocal, batches).filter(b => isValidUuid(b.id) && isValidUuid(b.product_group_id));
      if (activeBatches.length > 0) {
        console.log(`[Sync Push] purchase_batches upserting: ${activeBatches.length} rows`);
      }
      await this.applyCloudCollection('purchase_batches', currentLocal, batches);
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步採購批次發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async getPurchaseBatchItems(): Promise<PurchaseBatchItem[]> {
    return db.getPurchaseBatchItems();
  }

  async savePurchaseBatchItems(items: PurchaseBatchItem[]): Promise<void> {
    await this.requireCloudWritePermission();
    // 1. Identify deleted ones by comparing with current local storage records
    const currentLocal = await db.getPurchaseBatchItems();
    const incomingIds = new Set(items.map(i => i.id));
    const removedItems = currentLocal.filter(i => !incomingIds.has(i.id));

    // 3. Supabase Cloud Sync
    try {
      // (A) Handle soft deletion of removed items in Supabase
      if (removedItems.length > 0) {
        const removedIds = removedItems.map(i => i.id).filter(isValidUuid);
        if (removedIds.length > 0) {
          console.log(`[Sync Push] purchase_batch_items marking deleted_at: ${removedIds.length} rows`);
        }
      }

      // (B) Upsert incoming active items to Supabase
      const activeItems = changedOrNewRows(currentLocal, items).filter(i => isValidUuid(i.id) && isValidUuid(i.purchase_batch_id) && isValidUuid(i.product_variant_id));
      if (activeItems.length > 0) {
        console.log(`[Sync Push] purchase_batch_items upserting: ${activeItems.length} rows`);
      }
      await this.applyCloudCollection('purchase_batch_items', currentLocal, items);
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步採購批次明細發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async savePurchaseBatchTransaction(command: PurchaseBatchTransactionCommand): Promise<void> {
    try {
      await this.requireCloudWritePermission();
    } catch {
      throw new PurchaseBatchSubmitBoundaryError('precondition-blocked');
    }
    assertCloudWriteAllowed();
    const [currentBatches, currentItems] = await Promise.all([
      db.getPurchaseBatches(),
      db.getPurchaseBatchItems(),
    ]);
    const currentBatch = currentBatches.find(batch => batch.id === command.batch.id);
    const scopedItems = currentItems.filter(item => item.purchase_batch_id === command.batch.id);
    const request = readOrCreatePendingRpcRequest(
      command,
      () => buildPurchaseBatchTransactionRequest(currentBatch, scopedItems, command),
    );
    const batchIds = request.batchOperations.map(operation => operation.id);
    const itemIds = request.itemOperations.map(operation => operation.id);
    markLocalCloudWrite('purchase_batches', batchIds);
    markLocalCloudWrite('purchase_batch_items', itemIds);

    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(PURCHASE_BATCH_TRANSACTION_RPC, {
        p_idempotency_key: command.idempotencyKey,
        p_request: request,
      }));
    } catch (caughtError) {
      clearLocalCloudWrites('purchase_batches', batchIds);
      clearLocalCloudWrites('purchase_batch_items', itemIds);
      markCloudRequestFailed(caughtError);
      throw new PurchaseBatchSubmitBoundaryError('result-unknown');
    }
    if (error) {
      clearLocalCloudWrites('purchase_batches', batchIds);
      clearLocalCloudWrites('purchase_batch_items', itemIds);
      markCloudRequestFailed(error);
      throw new PurchaseBatchSubmitBoundaryError('server-rejected');
    }
    markCloudReachable();

    let result;
    try {
      result = assertPurchaseBatchTransactionSucceeded(data);
    } catch (transactionError) {
      clearLocalCloudWrites('purchase_batches', batchIds);
      clearLocalCloudWrites('purchase_batch_items', itemIds);
      if (isCloudFieldMutationError(transactionError)) notifyCloudFieldMutationConflict(transactionError);
      throw transactionError;
    }

    const canonicalBatch = {
      ...result.batch,
      id: String(result.batch.id),
      database_id: String(result.batch.id),
      note: String(result.batch.note || ''),
      date: String(result.batch.date || ''),
    } as unknown as PurchaseBatch;
    const canonicalItems = result.items.map(row => ({
      ...row,
      id: String(row.id),
      database_id: String(row.id),
      purchase_batch_id: String(row.purchase_batch_id),
      product_variant_id: String(row.product_variant_id),
      quantity: Number(row.quantity ?? 0),
      cost: Number(row.cost ?? 0),
      note: String(row.note || ''),
    } as PurchaseBatchItem));
    const nextBatches = [...currentBatches.filter(batch => batch.id !== canonicalBatch.id), canonicalBatch];
    const nextItems = [
      ...currentItems.filter(item => item.purchase_batch_id !== canonicalBatch.id),
      ...canonicalItems,
    ];
    try {
      // The Server mutation has succeeded before this local cache transaction starts.
      await db.savePurchaseBatchTransaction(nextBatches, nextItems);
      clearPendingRpcRequest(command.idempotencyKey);
    } catch {
      clearLocalCloudWrites('purchase_batches', batchIds);
      clearLocalCloudWrites('purchase_batch_items', itemIds);
      throw new PurchaseBatchSubmitBoundaryError('committed-sync-pending');
    }
  }

  async getPrivateOrders(): Promise<PrivateOrder[]> {
    await this.pullCoreProductData();
    return db.getPrivateOrders();
  }

  async savePrivateOrders(orders: PrivateOrder[]): Promise<void> {
    await this.requireCloudWritePermission();
    // 1. Identify deleted ones by comparing with current local storage records (must read
    // BEFORE overwriting local storage below). Without this, a UI delete that just omits a
    // row from the array only ever removes it locally -- private_orders.deleted_at is never
    // set in Supabase, so the next pullCoreProductData() (e.g. after F5) pulls it right back.
    const currentLocal = await db.getPrivateOrders();
    const incomingIds = new Set(orders.map(o => o.id));
    const removedOrders = currentLocal.filter(o => !incomingIds.has(o.id));
    try {
      // (A) Handle soft deletion of removed orders in Supabase
      if (removedOrders.length > 0) {
        const removedIds = removedOrders.map(o => o.id).filter(isValidUuid);
        if (removedIds.length > 0) {
          console.log(`[Sync Push] private_orders marking deleted_at: ${removedIds.length} rows`);
        }
      }

      // (B) 防呆與空陣列檢查 (若 orders.length === 0，直接 skip 雲端 upsert)
      if (!orders || orders.length === 0) {
        console.log('[Private Order Sync] skip empty cloud upsert for private_orders');
        await this.applyCloudCollection('private_orders', currentLocal, orders);
        return;
      }

      // 僅過濾出合法 UUID 的 active orders 進行 upsert
      const activeOrders = changedOrNewRows(currentLocal, orders).filter(o => isValidUuid(o.id) && isValidUuid(o.product_group_id));
      if (activeOrders.length === 0) {
        console.log('[Private Order Sync] skip empty active cloud upsert for private_orders');
        await this.refreshAcknowledgedCloudRows('private_orders', removedOrders.map(order => ({ databaseId: order.id, canonicalId: order.id })));
        return;
      }

      console.log(`[Private Order Sync] upsert orders count: ${activeOrders.length}`);
      await this.applyCloudCollection('private_orders', currentLocal, orders);
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步私下訂單發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async getPrivateOrderItems(): Promise<PrivateOrderItem[]> {
    await this.pullCoreProductData();
    return db.getPrivateOrderItems();
  }

  async savePrivateOrderItems(items: PrivateOrderItem[]): Promise<void> {
    await this.requireCloudWritePermission();
    const currentLocal = await db.getPrivateOrderItems();
    // 3. 防呆與空陣列檢查 (若 items.length === 0，直接 skip 雲端 upsert)
    if (!items || items.length === 0) {
      console.log('[Private Order Sync] skip empty cloud upsert for private_order_items');
      return;
    }

    try {
      // 4. 僅過濾出合法 UUID 的 active items
      const activeItems = changedOrNewRows(currentLocal, items).filter(i => isValidUuid(i.id) && isValidUuid(i.private_order_id) && isValidUuid(i.product_variant_id));
      if (activeItems.length === 0) {
        console.log('[Private Order Sync] skip empty active cloud upsert for private_order_items');
        return;
      }

      // 5. 確保父訂單已成功寫入雲端以避免外鍵衝突 (Foreign Key check)
      const parentOrderIds = Array.from(new Set(activeItems.map(i => i.private_order_id)));
      const { data: existingParentOrders, error: checkError } = await supabase
        .from('private_orders')
        .select('id')
        .in('id', parentOrderIds);

      if (checkError) {
        markCloudRequestFailed(checkError);
        console.error('[Private Order Sync] failed to verify parent orders:', checkError);
        throw checkError;
      }
      markCloudReachable();

      const existingParentSet = new Set(existingParentOrders?.map(o => o.id) || []);
      const readyItems = activeItems.filter(i => existingParentSet.has(i.private_order_id));
      const skippedCount = activeItems.length - readyItems.length;

      if (skippedCount > 0) {
        throw new Error(`[Private Order Sync] ${skippedCount} items have no parent private_orders in Supabase; cache commit refused.`);
      }

      if (readyItems.length === 0) {
        console.log('[Private Order Sync] skip items cloud upsert because no items have parent orders in Supabase');
        return;
      }

      console.log(`[Private Order Sync] upsert items count: ${readyItems.length}`);
      await this.applyCloudCollection('private_order_items', currentLocal, readyItems, { deleteMissing: false });
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步私下訂單項目發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async deletePrivateOrderItems(ids: string[]): Promise<void> {
    await this.requireCloudWritePermission();

    // 3. 防呆與空陣列檢查
    if (!ids || ids.length === 0) {
      console.log('[Private Order Sync] skip empty cloud delete for private_order_items');
      return;
    }

    try {
      // 4. 僅過濾出合法 UUID 的 ids
      const validIds = ids.filter(id => isValidUuid(id));
      if (validIds.length === 0) {
        console.log('[Private Order Sync] skip empty active cloud delete for private_order_items');
        return;
      }

      console.log(`[Private Order Sync] delete items count: ${validIds.length}`);
      const currentItems = await db.getPrivateOrderItems();
      await this.applyCloudCollection(
        'private_order_items',
        currentItems,
        currentItems.filter(item => !validIds.includes(item.id)),
      );
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase delete error message:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(`雲端刪除私下訂單項目發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async getJapanPackages(): Promise<JapanPackage[]> {
    return db.getJapanPackages();
  }

  async getBundleComponents(): Promise<BundleComponent[]> {
    return db.getBundleComponents();
  }

  async saveBundleComponents(components: BundleComponent[]): Promise<void> {
    await this.requireCloudWritePermission();

    try {
      await this.applyCloudCollection('bundle_components', await db.getBundleComponents(), components, { deleteMissing: false });
    } catch (err: any) {
      console.error('[Cloud Push ERROR] bundle_components sync exception:', err.message || err);
      throw err;
    }
  }

  async saveBundleComponentsForVariant(bundleVariantId: string, componentVariantIds: string[]): Promise<void> {
    await this.requireCloudWritePermission();
    const all = await this.getBundleComponents();
    const now = new Date().toISOString();
    const newItems: BundleComponent[] = componentVariantIds.map(cId => ({
      id: crypto.randomUUID(),
      bundle_variant_id: bundleVariantId,
      component_variant_id: cId,
      created_at: now
    }));
    try {
      const next = [
        ...all.filter(component => component.bundle_variant_id !== bundleVariantId),
        ...newItems,
      ];
      await this.applyCloudCollection('bundle_components', all, next);
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase sync error for bundle_components:', err.message || err);
      throw err;
    }
  }

  async saveJapanPackages(packages: JapanPackage[]): Promise<void> {
    await this.requireCloudWritePermission();
    // 1. Identify deleted ones by comparing with current local storage records
    const currentLocal = await db.getJapanPackages();
    const incomingIds = new Set(packages.map(p => p.id));
    const removedPackages = currentLocal.filter(p => !incomingIds.has(p.id));

    try {
      // (A) Handle soft deletion of removed packages in Supabase
      if (removedPackages.length > 0) {
        const removedIds = removedPackages.map(p => p.id).filter(isValidUuid);
        if (removedIds.length > 0) {
          console.log(`[Sync Push] japan_packages marking deleted_at: ${removedIds.length} rows`);
        }
      }

      // (B) Upsert incoming active packages to Supabase
      const activePackages = packages.filter(p => isValidUuid(p.id));
      if (activePackages.length > 0) {
        console.log(`[Sync Push] japan_packages upserting: ${activePackages.length} rows`);
      }
      await this.applyCloudCollection('japan_packages', currentLocal, packages);
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步日本包裹發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async getJapanPackageItems(): Promise<JapanPackageItem[]> {
    return db.getJapanPackageItems();
  }

  async applyJapanPackageTransaction(command: JapanPackageTransactionCommand): Promise<JapanPackageTransactionSuccess> {
    await this.requireCloudWritePermission();
    const [currentPackages, currentItems] = await Promise.all([
      db.getJapanPackages(),
      db.getJapanPackageItems(),
    ]);
    const packageId = command.transactionType === 'create-package' ? command.package.id : command.packageId;
    const currentPackage = currentPackages.find(pkg => pkg.id === packageId);
    const scopedItems = currentItems.filter(item => item.japan_package_id === packageId);
    const request = readOrCreatePendingJapanPackageRequest(
      command,
      () => buildJapanPackageTransactionRequest(currentPackage, scopedItems, command),
    );
    const packageIds = [request.packageId];
    const itemIds = request.itemOperations.map(operation => operation.id);
    markLocalCloudWrite('japan_packages', packageIds);
    markLocalCloudWrite('japan_package_items', itemIds);

    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(JAPAN_PACKAGE_TRANSACTION_RPC, {
        p_idempotency_key: command.idempotencyKey,
        p_request: request,
      }));
    } catch (caughtError) {
      clearLocalCloudWrites('japan_packages', packageIds);
      clearLocalCloudWrites('japan_package_items', itemIds);
      markCloudRequestFailed(caughtError);
      throw new JapanPackageSubmitBoundaryError('result-unknown');
    }
    if (error) {
      clearLocalCloudWrites('japan_packages', packageIds);
      clearLocalCloudWrites('japan_package_items', itemIds);
      markCloudRequestFailed(error);
      throw new JapanPackageSubmitBoundaryError('server-rejected');
    }
    markCloudReachable();

    let result: JapanPackageTransactionSuccess;
    try {
      result = assertJapanPackageTransactionSucceeded(data);
    } catch {
      clearLocalCloudWrites('japan_packages', packageIds);
      clearLocalCloudWrites('japan_package_items', itemIds);
      throw new JapanPackageSubmitBoundaryError('server-rejected');
    }

    const canonicalPackage = {
      ...result.package,
      id: String(result.package.id),
      database_id: String(result.package.id),
      title: String(result.package.title || ''),
      status: String(result.package.status || 'registered'),
      note: String(result.package.note || ''),
      version: Number(result.package.version ?? 1),
    } as unknown as JapanPackage;
    const canonicalItems = result.items.map(row => ({
      ...row,
      id: String(row.id),
      database_id: String(row.id),
      japan_package_id: String(row.japan_package_id),
      quantity: Number(row.quantity ?? 0),
      checked: Boolean(row.checked),
      version: Number(row.version ?? 1),
    } as JapanPackageItem));
    const nextPackages = [...currentPackages.filter(pkg => pkg.id !== canonicalPackage.id), canonicalPackage];
    const nextItems = [
      ...currentItems.filter(item => item.japan_package_id !== canonicalPackage.id),
      ...canonicalItems,
    ];
    try {
      await db.saveJapanPackageTransaction(nextPackages, nextItems);
      clearPendingJapanPackageRequest(command.idempotencyKey);
    } catch {
      clearLocalCloudWrites('japan_packages', packageIds);
      clearLocalCloudWrites('japan_package_items', itemIds);
      return {
        ...result,
        package: canonicalPackage as unknown as Record<string, unknown>,
        items: canonicalItems as unknown as Array<Record<string, unknown>>,
        syncPending: true,
      };
    }
    return {
      ...result,
      package: canonicalPackage as unknown as Record<string, unknown>,
      items: canonicalItems as unknown as Array<Record<string, unknown>>,
    };
  }

  async saveJapanPackageItems(items: JapanPackageItem[]): Promise<void> {
    await this.requireCloudWritePermission();
    // 1. Identify deleted ones by comparing with current local storage records
    const currentLocal = await db.getJapanPackageItems();
    const incomingIds = new Set(items.map(i => i.id));
    const removedItems = currentLocal.filter(i => !incomingIds.has(i.id));

    try {
      // (A) Handle soft deletion of removed items in Supabase
      if (removedItems.length > 0) {
        const removedIds = removedItems.map(i => i.id).filter(isValidUuid);
        if (removedIds.length > 0) {
          console.log(`[Sync Push] japan_package_items marking deleted_at: ${removedIds.length} rows`);
        }
      }

      // (B) Upsert incoming active items to Supabase
      const activeItems = items.filter(i => isValidUuid(i.id) && isValidUuid(i.japan_package_id));
      if (activeItems.length > 0) {
        console.log(`[Sync Push] japan_package_items upserting: ${activeItems.length} rows`);
      }
      await this.applyCloudCollection('japan_package_items', currentLocal, items);
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步日本包裹明細發生異常：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async getOutboundShipments(): Promise<OutboundShipment[]> {
    return db.getOutboundShipments();
  }

  async getOutboundShipmentItems(): Promise<OutboundShipmentItem[]> {
    return db.getOutboundShipmentItems();
  }

  async saveOutboundShipments(shipments: OutboundShipment[]): Promise<void> {
    await this.requireCloudWritePermission();
    const currentLocal = await db.getOutboundShipments();

    try {
      const active = shipments.filter(s => isValidUuid(s.id));
      if (active.length > 0) console.log(`[Sync Push] outbound_shipments changed candidates: ${active.length}`);
      await this.applyCloudCollection('outbound_shipments', currentLocal, shipments);
    } catch (err: any) {
      console.error('[Cloud Push ERROR] outbound_shipments:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步出庫單失敗：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async saveOutboundShipmentItems(items: OutboundShipmentItem[]): Promise<void> {
    await this.requireCloudWritePermission();
    const currentLocal = await db.getOutboundShipmentItems();

    try {
      const active = items.filter(i => isValidUuid(i.id) && isValidUuid(i.outbound_shipment_id));
      if (active.length > 0) console.log(`[Sync Push] outbound_shipment_items changed candidates: ${active.length}`);
      await this.applyCloudCollection('outbound_shipment_items', currentLocal, items);
    } catch (err: any) {
      console.error('[Cloud Push ERROR] outbound_shipment_items:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(`雲端同步出庫明細失敗：${err.message || err}。雲端快取未變更。`);
      throw err;
    }
  }

  async getImportBatches(): Promise<ImportBatch[]> {
    return db.getImportBatches();
  }

  async saveImportBatches(batches: ImportBatch[]): Promise<void> {
    void batches;
    throw new Error('雲端匯入批次必須由 Server 完成；本機快取不接受獨立寫入。');
  }

  // === 資料庫管理與輔助方法 (完全委託本地 db) ===
  async exportData(): Promise<void> {
    let rawData: unknown;
    let error: unknown;
    try {
      ({ data: rawData, error } = await supabase.rpc(CLOUD_RESTORE_SNAPSHOT_RPC));
    } catch (caughtError) {
      markCloudRequestFailed(caughtError);
      throw caughtError;
    }
    if (error) {
      markCloudRequestFailed(error);
      throw error;
    }
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      const invalid = new Error('CLOUD_RESTORE_SNAPSHOT_INVALID');
      markCloudRequestFailed(invalid);
      throw invalid;
    }
    markCloudReachable();
    const prepared = await buildCloudRestoreManifest(rawData as Record<string, unknown>, rawData as Record<string, unknown>);
    const fileData = Object.fromEntries(CLOUD_RESTORE_TABLES.map(([collection, table]) => [collection, prepared.data[table]]));
    const snapshot = {
      schemaVersion: CLOUD_RESTORE_SCHEMA_VERSION,
      sourceEnvironment: 'cloud-authoritative',
      manifest: prepared.manifest,
      data: fileData,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cloud-authoritative-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async importData(jsonString: string): Promise<boolean> {
    void jsonString;
    throw new CloudRestoreDisabledError();
  }

  async clearData(): Promise<void> {
    throw new Error('雲端模式禁止從瀏覽器清除 Cloud cache 或正式資料。');
  }

  async clearPurchaseRecords(): Promise<void> {
    throw new Error('雲端模式禁止從瀏覽器清除採購資料。');
  }

  async createPurchaseRecordFromInventory(itemCodes: string[]): Promise<void> {
    void itemCodes;
    throw new Error('雲端建立訂購紀錄目前已安全停用：需先由 Server 完成正式 mutation，再更新 Cloud cache。');
    /* Legacy local-first implementation intentionally unreachable in Cloud Mode.
    // 1. 先執行 db.createPurchaseRecordFromInventory(itemCodes)
    await db.createPurchaseRecordFromInventory(itemCodes);
    
    // 2. 接著重新取得 groups, categories, inventory, salesOrderItems, variants
    const groups = await db.getProductGroups();
    const categories = await db.getProductCategories();
    const inventory = await db.getInventory();
    const salesOrderItems = await db.getSalesOrderItems();
    const allVariants = await db.getProductVariants();
    
    // 3. 只針對本次 itemCodes 對應到的 variants 重新計算：myacg_auto_quantity, effective_myacg_quantity
    const targetCodes = new Set(itemCodes.map(code => code.trim().toUpperCase()));
    const targetVariants: ProductVariant[] = [];
    
    console.log(`[Import Quantity Debug] target itemCodes: ${JSON.stringify(itemCodes)}`);
    
    for (const v of allVariants) {
      if (v.myacg_item_code && targetCodes.has(v.myacg_item_code.trim().toUpperCase())) {
        const matchedInv = inventory.find(i => i.myacg_item_code.trim().toUpperCase() === v.myacg_item_code.trim().toUpperCase());
        console.log(`[Import Quantity Debug] inventory matched: SKU=${v.myacg_item_code}, found=${!!matchedInv}, sold_qty=${matchedInv?.myacg_sold_quantity}`);
        
        const effectiveMyacg = calculateFinalMyacgDemand(v.myacg_item_code, inventory, salesOrderItems);
        
        console.log(`[Import Quantity Debug] variant recalculated: SKU=${v.myacg_item_code}, old_auto=${v.myacg_auto_quantity}, new_auto=${effectiveMyacg}`);
        
        v.myacg_auto_quantity = effectiveMyacg;
        v.effective_myacg_quantity = effectiveMyacg;
        targetVariants.push(v);
      }
    }
    
    // 4. 儲存前加 log
    if (targetVariants.length > 0) {
      console.log(`[Import Quantity Debug] save variants sample: ${JSON.stringify(targetVariants[0])}`);
    } else {
      console.log(`[Import Quantity Debug] save variants sample: empty`);
    }
    
    // 5. 本地儲存：必須是 allVariants，以防覆蓋 IndexedDB 清空其他規格
    await db.saveProductVariants(allVariants);
    
    // 6. 雲端同步更新的 groups, categories
    await this.saveProductGroups(groups);
    await this.saveProductCategories(categories);
    
    // 7. 雲端同步 targetVariants（只 upsert 本次更新的規格，且只包含已定義欄位）
    if (await this.canWriteCloud()) {
      if (targetVariants.length > 0) {
        const validVariants = targetVariants.filter(v => 
          isValidUuid(v.id) && isValidUuid(v.product_group_id)
        );
        
        if (validVariants.length > 0) {
          console.log(`[Cloud Push] upserting target variants count: ${validVariants.length}`);
          const upsertData = validVariants.map(v => {
            const payload: any = {
              id: v.id,
              local_id: cloudLocalIdOf(v as ProductVariant & { local_id?: string }),
              product_group_id: v.product_group_id,
              product_category_id: isValidUuid(v.product_category_id) ? v.product_category_id : null,
              myacg_item_code: v.myacg_item_code,
              variant_name: v.variant_name,
              raw_variant_name: v.raw_variant_name || null,
              product_title: v.product_title,
              note: v.note || '',
              sort_order: v.sort_order || 0,
              catalog_missing: v.catalog_missing || false,
              source: v.source || null,
              default_jpy_cost: v.default_jpy_cost ?? null,
              default_twd_cost: v.default_twd_cost ?? null,
              updated_at: new Date().toISOString()
            };
            
            if (v.myacg_manual_adjustment !== undefined) payload.myacg_manual_adjustment = v.myacg_manual_adjustment;
            if (v.waca_manual_adjustment !== undefined) payload.waca_manual_adjustment = v.waca_manual_adjustment;
            if (v.private_manual_adjustment !== undefined) payload.private_manual_adjustment = v.private_manual_adjustment;
            if (v.purchased_manual_adjustment !== undefined) payload.purchased_manual_adjustment = v.purchased_manual_adjustment;
            if (v.myacg_auto_quantity !== undefined) payload.myacg_auto_quantity = v.myacg_auto_quantity;
            if (v.effective_myacg_quantity !== undefined) payload.effective_myacg_quantity = v.effective_myacg_quantity;
            if (v.waca_auto_quantity !== undefined) payload.waca_auto_quantity = v.waca_auto_quantity;
            
            return payload;
          });
          
          const { error } = await supabase
            .from('product_variants')
            .upsert(upsertData);
            
          if (error) {
            console.error(`[Cloud Push ERROR] Supabase error message: ${error.message || JSON.stringify(error)}`);
            throw error;
          }
        }
      }
    }
    */
  }

  async reparseProductVariants(): Promise<void> {
    throw new Error('雲端重新解析規格已安全停用：不得先改 Cloud cache。');
  }

  async reparseProductTitles(): Promise<void> {
    throw new Error('雲端重新解析商品名稱已安全停用：不得先改 Cloud cache。');
  }

  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number, upgradedSkusCount?: number }> {
    throw new Error('雲端商品同步已安全停用：需先完成 Server authoritative mutation path。');
  }

  async deleteProductGroup(groupId: string): Promise<void> {
    if (!(await this.canWriteCloud())) {
      throw new Error("無權限，viewer 不可刪除商品群組");
    }

    await this.deleteCloudProductGroupTrees([groupId]);
  }

  async deleteProductVariant(id: string): Promise<void> {
    if (!(await this.canWriteCloud())) {
      throw new Error("無權限，viewer 不可刪除商品規格");
    }

    const current = await db.getProductVariants();
    await this.applyCloudCollection('product_variants', current, current.filter(variant => variant.id !== id));
  }

  async deleteProductGroups(groupIds: string[]): Promise<void> {
    if (!(await this.canWriteCloud())) {
      throw new Error("無權限，viewer 不可刪除商品群組");
    }

    if (!groupIds || groupIds.length === 0) return;

    await this.deleteCloudProductGroupTrees(groupIds);
  }

  async pullDashboardCategoryImages(): Promise<void> {
    try {
      const data = await fetchAll<any>(async (from, to) =>
        supabase
          .from('dashboard_category_images')
          .select('category_key, image_url, storage_path')
          .is('deleted_at', null)
          .order('category_key')
          .range(from, to)
      );

      if (data) {
        data.forEach(item => {
          if (item.category_key) {
            if (item.image_url) {
              localStorage.setItem(`dashboard_cloud_img_${item.category_key}`, item.image_url);
            } else {
              localStorage.removeItem(`dashboard_cloud_img_${item.category_key}`);
            }
            if (item.storage_path) {
              localStorage.setItem(`dashboard_cloud_path_${item.category_key}`, item.storage_path);
            } else {
              localStorage.removeItem(`dashboard_cloud_path_${item.category_key}`);
            }
          }
        });
        console.log(`[Sync] 成功同步 ${data.length} 筆首頁大類圖片資料`);
      }
    } catch (err: any) {
      console.error('[Sync] 同步首頁大類圖片失敗:', err.message || err);
      if (isSchemaMissingError(err)) {
        alert('雲端資料表 dashboard_category_images 缺失，同步流程已中斷，請匯入 SQL Migration 建立表格！');
      }
      throw err;
    }
  }

  async saveDashboardCategoryImage(categoryKey: string, imageUrl: string | null, storagePath: string | null): Promise<void> {
    await this.requireCloudWritePermission();

    try {
      await retrySupabase(() => supabase
        .from('dashboard_category_images')
        .upsert({
          category_key: categoryKey,
          image_url: imageUrl,
          storage_path: storagePath,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'category_key'
        }));
      if (imageUrl) localStorage.setItem(`dashboard_cloud_img_${categoryKey}`, imageUrl);
      else localStorage.removeItem(`dashboard_cloud_img_${categoryKey}`);
      if (storagePath) localStorage.setItem(`dashboard_cloud_path_${categoryKey}`, storagePath);
      else localStorage.removeItem(`dashboard_cloud_path_${categoryKey}`);
      console.log(`[Sync Push] 首頁大類圖片已儲存並推送雲端: ${categoryKey}`);
    } catch (err: any) {
      console.error(`[Sync Push] 推送首頁大類圖片失敗 (${categoryKey}):`, err.message || err);
      throw err;
    }
  }

  async getLastImportBackup(): Promise<{ data: string; timestamp: string } | null> {
    return db.getLastImportBackup();
  }

  async saveLastImportBackup(backup: { data: string; timestamp: string }): Promise<void> {
    assertCloudWriteAllowed();
    return db.saveLastImportBackup(backup);
  }

  async restoreBackup(_backupData: any): Promise<boolean> {
    throw new CloudRestoreDisabledError();
  }
}

export const supabaseProvider = new SupabaseProvider();
