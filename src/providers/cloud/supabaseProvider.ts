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

import { supabase, supabaseEnvironment } from './supabaseClient';
import type { NextWacaSnapshot } from '../../waca/nextStorage';
import { readDeadlineDurableBackup } from '../../lib/closingDateSidecarBackup';
import { CLOUD_RESTORE_RECOVERY_COLUMNS, parseCloudRestoreRecoveryRows } from './cloudRestoreRecovery';
import { isCloudRestoreFailureCode } from './cloudRestoreFailure';
import { readCloudRestoreIntegrityAudit } from './cloudRestoreIntegrityAudit';
import {
  CLOUD_RESTORE_CANDIDATE_PROOF_RPC,
  assertCloudRestoreCandidateProofResult,
  type CloudRestoreCandidateProofResult,
} from './cloudRestoreCandidateProof';
import { cloudCacheDb as db, normalizeProductTitle } from '../../lib/db';
import { checkDataSizeWarnings } from '../../lib/dataSizeAdvisory';
import { CloudRestoreDisabledError } from '../cloudRestorePolicy';
import { clearLocalCloudWrites, markLocalCloudWrite } from './cloudRealtimeEchoRegistry';
import {
  assertCloudFieldMutationSucceeded,
  assertCloudMutationOperations,
  sanitizeCloudBusinessPatch,
  CloudMutationBoundaryError,
  SaveabilityError,
  cloudMutationFailureMessage,
  buildCloudCollectionMutationPlan,
  buildCloudPatchOperation,
  isCloudFieldMutationError,
  notifyCloudFieldMutationConflict,
  type CloudFieldMutationOperation,
  type CloudMutableEntity,
  type CloudPatchOperation,
} from './cloudFieldCas';
import { toCloudFieldRow } from './cloudEntityPayload';
import { planCloudInventoryImport } from './inventoryImportPlan';
import { classifyMyAcgImportError } from '../../utils/myacgImportErrors';
import {
  assertCloudWriteAllowed,
  isLikelyCloudConnectivityError,
  markCloudReadDeferred,
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
  OUTBOUND_SHIPMENT_TRANSACTION_RPC,
  OutboundShipmentDeleteBoundaryError,
  assertOutboundShipmentDeleteSucceeded,
  buildOutboundShipmentDeleteRequest,
  clearPendingOutboundDeleteRequest,
  readOrCreatePendingOutboundDeleteRequest,
  type OutboundShipmentDeleteCommand,
  type OutboundShipmentDeleteSuccess,
} from './outboundShipmentTransaction';
import {
  CLOUD_RESTORE_RPC,
  CLOUD_RESTORE_SNAPSHOT_RPC,
  CLOUD_RESTORE_SCHEMA_VERSION,
  CLOUD_RESTORE_TABLES,
  CLOUD_RESTORE_ATTEMPT_PREPARE_RPC,
  CLOUD_RESTORE_ATTEMPT_RECONCILE_RPC,
  CLOUD_RESTORE_TIMEOUT_BUDGET_MS,
  CLOUD_RESTORE_TIMEOUT_CONTRACT_VERSION,
  assertCloudRestoreAttemptOutcome,
  assertCloudRestoreServerResult,
  buildCloudRestoreManifest,
  type CloudRestoreAttemptCommand,
  type CloudRestoreAttemptOutcome,
  type CloudRestoreCandidate,
  type CloudRestoreCommand,
  type CloudRestoreExecutionCommand,
  type CloudRestoreResult,
} from './cloudAtomicRestore';
import {
  CLOUD_RESTORE_PORTABILITY_PREFLIGHT_RPC,
  assertCloudRestoreEffectiveCandidate,
  assertCloudRestoreTargetCompatibilityResult,
  type CloudRestoreTargetCompatibilityResult,
} from './cloudRestorePortability';
import {
  createCloudRestoreSafeSubmitError,
  normalizeCloudRestoreSubmitError,
  preserveCloudRestoreSuccessThroughRefresh,
  recordCloudRestoreSubmitDiagnostic,
} from './cloudRestoreSubmit';
import { recordCloudRestoreRpcIntent } from './cloudRestoreRpcTransport';
import type { IDataProvider } from '../types';
import { buildPrivateOrderRequest, PRIVATE_ORDER_RPC, type PrivateOrderTransactionCommand } from './privateOrderTransaction';
import { readFormIntent,stableFormIntent,clearFormIntent } from './privateOrderTransaction';
import { readCloudRowsByIds } from './cloudBulkRead';
import {
  BuyAnimeImportPipeline, BuyAnimeResumeError, inventoryProof, assertImportRecord,
  type BuyAnimeImportRecord,
} from './buyAnimeImportResume';
import { readBuyAnimeJournal, readPendingBuyAnimeJournal, saveBuyAnimeJournal } from './buyAnimeImportJournal';
import { linksFromMyAcgInventory, mergeMyAcgMasterLinks } from '../../waca/masterReference';
import { planCatalogTransaction,CATALOG_RPC,type CatalogMode } from './catalogTransaction';
import { buildRelatedRequest,submitRelatedIntent,RELATED_RPC,type RelatedTransactionCommand } from './relatedTransaction';
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
  async getAuthoritativeWacaVariants(): Promise<ProductVariant[]> {
    // WACA reconciliation must never fall back to an old local cache after a
    // committed ledger transaction. Read the server's Variant projection.
    let rows: Record<string, unknown>[];
    try {
      rows = await fetchAll<Record<string, unknown>>(async (from, to) => supabase
        .from('product_variants')
        .select('*')
        .is('deleted_at', null)
        .order('id')
        .range(from, to));
    } catch (cause) { markCloudRequestFailed(cause); throw cause; }
    markCloudReachable();
    return rows.map(row => ({ ...row, id: String(row.id) })) as ProductVariant[];
  }
  async getWacaSnapshot(): Promise<NextWacaSnapshot> {
    let data: unknown;
    let error: unknown;
    try { ({ data, error } = await supabase.rpc('erp_read_waca_snapshot')); }
    catch (cause) { markCloudRequestFailed(cause); throw cause; }
    if (error) { markCloudRequestFailed(error); throw error; }
    const snapshot = data as NextWacaSnapshot | null;
    if (!snapshot || !Number.isSafeInteger(snapshot.revision)
      || !Array.isArray(snapshot.orders) || !Array.isArray(snapshot.items)
      || !Array.isArray(snapshot.mappings) || !Array.isArray(snapshot.batches)
      || !Array.isArray(snapshot.masterLinks) || !Array.isArray(snapshot.cutoverAudit)) {
      throw new Error('WACA 雲端資料格式不完整，請重新整理後再試。');
    }
    markCloudReachable();
    return snapshot;
  }

  async commitWacaSnapshot(
    snapshot: NextWacaSnapshot, expectedRevision: number, updateAutoQuantity: boolean,
  ): Promise<number> {
    await this.requireCloudWritePermission();
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc('erp_commit_waca_snapshot', {
        p_snapshot: snapshot, p_expected_revision: expectedRevision,
        p_update_auto_quantity: updateAutoQuantity,
      }));
    } catch (cause) { markCloudRequestFailed(cause); throw cause; }
    if (error) { markCloudRequestFailed(error); throw error; }
    const revision = Number((data as { revision?: unknown } | null)?.revision);
    if (!Number.isSafeInteger(revision) || revision !== expectedRevision + 1) {
      throw new Error('WACA 雲端寫入結果無法確認，請先重新讀取訂單與數量。');
    }
    markCloudReachable();
    if (updateAutoQuantity) {
      // The server has committed both ledger and quantity; invalidate this
      // client cache so the next read is not mistaken for authoritative data.
      this.isPulled = false;
      this.pullPromise = null;
    }
    return revision;
  }
  async readCloudRestoreIntegrityAudit() {
    return readCloudRestoreIntegrityAudit(supabase);
  }

  async proveCloudRestoreCandidate(candidate: CloudRestoreCandidate): Promise<CloudRestoreCandidateProofResult> {
    const effective = await assertCloudRestoreEffectiveCandidate(candidate);
    const requestId = crypto.randomUUID();
    recordCloudRestoreRpcIntent({ requestId, rpcName: CLOUD_RESTORE_CANDIDATE_PROOF_RPC });
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(CLOUD_RESTORE_CANDIDATE_PROOF_RPC, {
        p_request_id: requestId,
        p_source_snapshot: effective.sourceData,
        p_manifest: candidate.manifest,
        p_restore_mode: effective.mode,
        p_source_environment: candidate.sourceEnvironment,
      }));
    } catch (caughtError) {
      try { markCloudRequestFailed(caughtError); } catch { /* Keep the safe transport error authoritative. */ }
      throw createCloudRestoreSafeSubmitError(caughtError, 'transport');
    }
    if (error) {
      try { markCloudRequestFailed(error); } catch { /* Keep the safe server error authoritative. */ }
      throw createCloudRestoreSafeSubmitError(error, 'server-response');
    }
    markCloudReachable();
    return assertCloudRestoreCandidateProofResult(data, candidate);
  }

  private readonly mutationCache = new CloudTargetedCache();

  async getPendingCloudRestoreAttempts() {
    // This uses the current authenticated client, never a service-role client.
    // 038 RLS restricts rows to is_owner(auth.uid()) and the caller's actor hash.
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.from('erp_cloud_restore_attempts')
        .select(CLOUD_RESTORE_RECOVERY_COLUMNS)
        .eq('target_environment', supabaseEnvironment.projectRef)
        .in('status', ['prepared', 'executing'])
        .order('submitted_at', { ascending: true }));
    } catch (caughtError) {
      try { markCloudRequestFailed(caughtError); } catch { /* Keep the safe transport error authoritative. */ }
      throw createCloudRestoreSafeSubmitError(caughtError, 'transport');
    }
    if (error) {
      try { markCloudRequestFailed(error); } catch { /* Keep the safe server error authoritative. */ }
      throw createCloudRestoreSafeSubmitError(error, 'server-response');
    }
    markCloudReachable();
    return parseCloudRestoreRecoveryRows(data, supabaseEnvironment.projectRef);
  }

  private assertAttemptIdentity(
    outcome: CloudRestoreAttemptOutcome,
    command: CloudRestoreAttemptCommand,
    effectiveFingerprint?: string,
  ): CloudRestoreAttemptOutcome {
    if (outcome.attemptId !== command.attemptId || outcome.traceId !== command.traceId
      || (effectiveFingerprint !== undefined && outcome.effectiveFingerprint !== effectiveFingerprint)) {
      throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_RESULT_MISMATCH' }, 'server-response');
    }
    return outcome;
  }

  private async preserveCompletedAttempt(
    outcome: CloudRestoreAttemptOutcome,
    diagnostic: { attemptCorrelationId: string; idempotencyKey: string },
  ): Promise<CloudRestoreAttemptOutcome> {
    if (outcome.status !== 'completed' || !outcome.restoreResult) return outcome;
    const restoreResult = await preserveCloudRestoreSuccessThroughRefresh(
      outcome.restoreResult,
      () => this.mutationCache.refresh({
        reason: 'reconnect',
        resources: ['products', 'purchases', 'privateOrders', 'inventory', 'bundles', 'japanPackages', 'outboundShipments', 'salesOrders'],
        changes: [],
        authoritativeEpoch: outcome.restoreResult?.restoreEpoch,
      }),
      diagnostic,
    );
    return { ...outcome, restoreResult };
  }

  private async reconcileAttemptBoundaryUncertainty(
    command: CloudRestoreAttemptCommand,
  ): Promise<CloudRestoreAttemptOutcome> {
    try {
      const outcome = await this.reconcileCloudRestoreAttempt(command);
      if (outcome.status === 'completed') return outcome;
      if (outcome.status === 'not_committed') {
        throw createCloudRestoreSafeSubmitError({ code: outcome.failure?.code ?? 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED' }, 'server-response');
      }
      throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_PENDING' }, 'transport');
    } catch (error) {
      const visible = normalizeCloudRestoreSubmitError(error, 'rpc', {
        source: 'post-dispatch', attemptCorrelationId: command.traceId,
      });
      if (visible.code === 'CLOUD_RESTORE_ATTEMPT_NOT_FOUND') {
        // A destructive call cannot start without a committed envelope row.
        throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED' }, 'server-response');
      }
      if (visible.code === 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED' || isCloudRestoreFailureCode(visible.code)) throw error;
      throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_PENDING' }, 'transport');
    }
  }

  private async reconcileDestructiveUncertainty(
    command: CloudRestoreAttemptCommand,
  ): Promise<CloudRestoreResult> {
    try {
      const outcome = await this.reconcileCloudRestoreAttempt(command);
      if (outcome.status === 'completed' && outcome.restoreResult) return outcome.restoreResult;
      if (outcome.status === 'not_committed') {
        throw createCloudRestoreSafeSubmitError({ code: outcome.failure?.code ?? 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED' }, 'server-response');
      }
    } catch (error) {
      const visible = normalizeCloudRestoreSubmitError(error, 'rpc', {
        source: 'post-dispatch', attemptCorrelationId: command.traceId,
      });
      if (visible.code === 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED' || isCloudRestoreFailureCode(visible.code)) throw error;
    }
    // Once the destructive RPC may have started, missing/failed reconciliation
    // is never evidence of rollback. Keep the attempt locked as UNKNOWN.
    throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_PENDING' }, 'transport');
  }

  async validateCloudRestoreTarget(command: CloudRestoreCommand): Promise<CloudRestoreTargetCompatibilityResult> {
    assertCloudWriteAllowed();
    if (!command.candidate.portability) {
      throw createCloudRestoreSafeSubmitError(
        { code: 'CLOUD_RESTORE_PORTABILITY_POLICY_INVALID' },
        'pre-dispatch',
      );
    }
    const effective = await assertCloudRestoreEffectiveCandidate(command.candidate);
    if (effective.mode !== 'cross-environment') {
      throw createCloudRestoreSafeSubmitError(
        { code: 'CLOUD_RESTORE_PORTABILITY_POLICY_INVALID' },
        'pre-dispatch',
      );
    }
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(CLOUD_RESTORE_PORTABILITY_PREFLIGHT_RPC, {
        p_snapshot: effective.effectiveData,
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

  async prepareCloudRestoreAttempt(command: CloudRestoreCommand): Promise<CloudRestoreAttemptOutcome> {
    assertCloudWriteAllowed();
    if (command.confirmation !== 'OVERWRITE CLOUD DATA') {
      throw createCloudRestoreSafeSubmitError(
        { code: 'CLOUD_RESTORE_EXPLICIT_CONFIRMATION_REQUIRED' },
        'pre-dispatch',
      );
    }
    await assertCloudRestoreEffectiveCandidate(command.candidate);
    const sourceFingerprint = command.candidate.portability?.sourceSnapshotFingerprint
      ?? command.candidate.manifest.snapshotFingerprint;
    const restorePolicy = command.candidate.portability?.policyVersion ?? 'strict';
    const targetEnvironment = command.candidate.portability?.targetProjectRef ?? supabaseEnvironment.projectRef;
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(CLOUD_RESTORE_ATTEMPT_PREPARE_RPC, {
        p_attempt_id: command.idempotencyKey,
        p_trace_id: command.attemptCorrelationId,
        p_source_fingerprint: sourceFingerprint,
        p_effective_fingerprint: command.candidate.manifest.snapshotFingerprint,
        p_restore_policy: restorePolicy,
        p_target_environment: targetEnvironment,
        p_timeout_budget_ms: CLOUD_RESTORE_TIMEOUT_BUDGET_MS,
        p_timeout_contract_version: CLOUD_RESTORE_TIMEOUT_CONTRACT_VERSION,
      }));
    } catch (caughtError) {
      try { markCloudRequestFailed(caughtError); } catch { /* Raw error inspection must not replace the safe failure. */ }
      return this.reconcileAttemptBoundaryUncertainty({
        attemptId: command.idempotencyKey, traceId: command.attemptCorrelationId,
      });
    }
    if (error) {
      try { markCloudRequestFailed(error); } catch { /* Raw error inspection must not replace the safe failure. */ }
      throw createCloudRestoreSafeSubmitError(error, 'server-response');
    }
    markCloudReachable();
    const outcome = this.assertAttemptIdentity(
      assertCloudRestoreAttemptOutcome(data),
      { attemptId: command.idempotencyKey, traceId: command.attemptCorrelationId },
      command.candidate.manifest.snapshotFingerprint,
    );
    if (outcome.status === 'completed') {
      return this.preserveCompletedAttempt(outcome, {
        attemptCorrelationId: command.attemptCorrelationId,
        idempotencyKey: command.idempotencyKey,
      });
    }
    if (outcome.status !== 'prepared' || !outcome.reconcileAfter) {
      throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_PENDING' }, 'server-response');
    }
    // 042 intentionally does not call the legacy BEGIN RPC. The client-created
    // execution id is committed together with the destructive transaction, so
    // an HTTP/PostgREST/whole-transaction cancel leaves this envelope prepared
    // instead of stranding a separately committed `executing` row.
    return outcome;
  }

  async reconcileCloudRestoreAttempt(command: CloudRestoreAttemptCommand): Promise<CloudRestoreAttemptOutcome> {
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(CLOUD_RESTORE_ATTEMPT_RECONCILE_RPC, {
        p_attempt_id: command.attemptId,
        p_trace_id: command.traceId,
      }));
    } catch (caughtError) {
      try { markCloudRequestFailed(caughtError); } catch { /* Keep safe error authoritative. */ }
      throw createCloudRestoreSafeSubmitError(caughtError, 'transport');
    }
    if (error) {
      try { markCloudRequestFailed(error); } catch { /* Keep safe error authoritative. */ }
      throw createCloudRestoreSafeSubmitError(error, 'server-response');
    }
    markCloudReachable();
    const outcome = this.assertAttemptIdentity(assertCloudRestoreAttemptOutcome(data), command);
    return this.preserveCompletedAttempt(outcome, {
      attemptCorrelationId: command.traceId,
      idempotencyKey: command.attemptId,
    });
  }

  async restoreCloudSnapshot(command: CloudRestoreExecutionCommand): Promise<CloudRestoreResult> {
    if (command.confirmation !== 'OVERWRITE CLOUD DATA') {
      throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_EXPLICIT_CONFIRMATION_REQUIRED' }, 'pre-dispatch');
    }
    const requestId = crypto.randomUUID();
    recordCloudRestoreRpcIntent({
      requestId,
      rpcName: CLOUD_RESTORE_RPC,
      traceId: command.attempt.traceId,
      attemptId: command.attempt.attemptId,
      executionId: command.attempt.executionId,
    });
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(CLOUD_RESTORE_RPC, {
        p_attempt_id: command.attempt.attemptId,
        p_trace_id: command.attempt.traceId,
        p_execution_id: command.attempt.executionId,
        p_proof_id: command.proofId,
        p_request_id: requestId,
      }));
    } catch (caughtError) {
      try { markCloudRequestFailed(caughtError); } catch { /* Keep safe error authoritative. */ }
      return this.reconcileDestructiveUncertainty(command.attempt);
    }
    if (error) {
      try { markCloudRequestFailed(error); } catch { /* Keep safe error authoritative. */ }
      try {
        const outcome = await this.reconcileCloudRestoreAttempt(command.attempt);
        if (outcome.status === 'completed' && outcome.restoreResult) return outcome.restoreResult;
        if (outcome.status === 'not_committed') {
          throw createCloudRestoreSafeSubmitError({ code: outcome.failure?.code ?? 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED' }, 'server-response');
        }
      } catch (reconcileError) {
        const visible = normalizeCloudRestoreSubmitError(reconcileError, 'rpc', {
          source: 'post-dispatch', attemptCorrelationId: command.attempt.traceId,
        });
        if (visible.code === 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED' || isCloudRestoreFailureCode(visible.code)) throw reconcileError;
      }
      // Preserve a known PostgreSQL/PostgREST category while the durable
      // envelope remains locked for explicit reconciliation after grace.
      throw createCloudRestoreSafeSubmitError(error, 'server-response');
    }
    markCloudReachable();
    if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
      const failure = this.assertAttemptIdentity(assertCloudRestoreAttemptOutcome(data), command.attempt,
        command.candidate.manifest.snapshotFingerprint);
      if (failure.status !== 'not_committed' || !failure.failure
        || failure.executionId !== command.attempt.executionId) {
        throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_RESULT_INVALID' }, 'server-response');
      }
      throw createCloudRestoreSafeSubmitError({ code: failure.failure.code }, 'server-response');
    }
    const result = assertCloudRestoreServerResult(data);
    recordCloudRestoreSubmitDiagnostic({
      event: 'rpc-response', phase: 'rpc', outcome: 'success',
      attemptCorrelationId: command.attemptCorrelationId, idempotencyKey: command.idempotencyKey,
    });
    return preserveCloudRestoreSuccessThroughRefresh(
      result,
      () => this.mutationCache.refresh({
        reason: 'reconnect',
        resources: ['products', 'purchases', 'privateOrders', 'inventory', 'bundles', 'japanPackages', 'outboundShipments', 'salesOrders'],
        changes: [], authoritativeEpoch: result.restoreEpoch,
      }),
      { attemptCorrelationId: command.attemptCorrelationId, idempotencyKey: command.idempotencyKey },
    );
  }

  private async applyCloudFieldMutations(
    entity: CloudMutableEntity,
    operations: CloudFieldMutationOperation[],
    options: { readback?: boolean } = {},
  ): Promise<void> {
    if (operations.length === 0) return;
    assertCloudMutationOperations(entity, operations);
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
      throw new CloudMutationBoundaryError('result-unknown', caughtError);
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
    if (options.readback === false) return;
    try {
      await this.refreshAcknowledgedCloudRows(entity, operations.map(operation => ({
        databaseId: operation.id,
        expectedFields: operation.kind === 'create' ? operation.values
          : operation.kind === 'delete' ? undefined : operation.changes,
      })));
    } catch (readbackError) {
      clearLocalCloudWrites(entity, ids);
      throw new CloudMutationBoundaryError('committed-readback-pending', readbackError);
    }
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
    identities: Array<{ databaseId: string; canonicalId?: string; expectedFields?: Record<string, unknown> }>,
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
        expectedFields: identity.expectedFields,
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
            weight_kg: r.weight_kg == null ? undefined : Number(r.weight_kg),
            shipping_cost: r.shipping_cost == null ? undefined : Number(r.shipping_cost),
            shipped_at: r.shipped_at || '', received_at: r.received_at || '',
            status_changed_at: r.status_changed_at || undefined,
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
            myacg_parent_code: r.myacg_parent_code || undefined,
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
          }), 'cloud-sync');
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

    const syncTimeoutError = new Error('Cloud sync timed out after 4000ms');
    const syncTimeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(syncTimeoutError), 4000);
    });

    this.pullPromise = Promise.race([syncPromise, syncTimeout]).catch(async err => {
      console.warn('[Sync Timeout Fallback] Sync failed or timed out. Falling back to local cache.', err);
      // A completed failure already published its final fail-closed state above.
      // Only the timer boundary means that an authoritative read is still pending.
      if (err !== syncTimeoutError) return;
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
      markCloudReadDeferred(cachedRows.some(rows => rows.length > 0));
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

  async getProductVariants(options?: { recalc?: boolean; raw?: boolean }): Promise<ProductVariant[]> {
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
    if(groups.some(g=>!isValidUuid(g.id))) throw new SaveabilityError('商品識別碼不完整，本次未儲存；請重新讀取資料。');
    if(!groups.length)return; // This API saves rows, it is not a delete-all command.
    await this.applyCloudCollection('product_groups',await db.getProductGroups(),groups,{deleteMissing:false});
  }

  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    await this.requireCloudWritePermission();
    if(categories.some(c=>!isValidUuid(c.id)||!isValidUuid(c.product_group_id)))
      throw new SaveabilityError('商品分類識別碼或父商品不完整，本次未儲存。');
    await this.applyCloudCollection('product_categories',await db.getProductCategories(),categories);
  }

  /**
   * WARNING: Do NOT use this method for single-field UI updates.
   * This is reserved for bulk import or full synchronization.
   * For single-field or local updates, use updateProductVariantPatch instead.
   */
  async saveProductVariants(variants: ProductVariant[]): Promise<void> {
    await this.requireCloudWritePermission();
    if(variants.some(v=>!isValidUuid(v.id)||!isValidUuid(v.product_group_id)
      || (v.product_category_id!=null&&!isValidUuid(v.product_category_id))))
      throw new SaveabilityError('商品規格識別碼或關聯不完整，本次未儲存。');
    if(!variants.length)return; // Explicit delete has its own guarded atomic contract.
    await this.applyCloudCollection('product_variants',await db.getProductVariants({raw:true}),variants,{deleteMissing:false});
  }

  async updateProductVariantPatch(id: string, patch: Partial<ProductVariant>): Promise<void> {
    await this.requireCloudWritePermission();
    const localVariant = (await db.getProductVariants()).find(variant => variant.id === id);
    if (!localVariant) throw new Error(`Product variant not found: ${id}`);
    try {
      console.log(`[Cloud Patch] product_variants target id: ${id}, patch keys: ${Object.keys(patch).join(', ')}`);
      const base = toCloudFieldRow('product_variants', localVariant);
      const operation = buildCloudPatchOperation('product_variants', base, sanitizeCloudBusinessPatch('product_variants', patch));
      if (operation) await this.applyCloudFieldMutations('product_variants', [operation]);

      console.log(`[Sync Patch] product_variants update success for id: ${id}`);
    } catch (err: any) {
      console.error(`[Cloud Patch ERROR] Supabase error message: ${err.message || err}`);
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
          sanitizeCloudBusinessPatch('product_variants', item.patch),
        );
      }).filter((operation): operation is CloudPatchOperation => Boolean(operation));
      await this.applyCloudFieldMutations('product_variants', operations);

      console.log(`[Sync Patch Bulk] product_variants bulk update success for count: ${patches.length}`);
    } catch (err: any) {
      console.error(`[Cloud Patch Bulk ERROR] Supabase error message: ${err.message || err}`);
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
      throw err;
    }
  }


  // === 4 張非 Synced 核心表與本地輔助表 (完全委託本地 db) ===
  async getInventory(): Promise<InventoryItem[]> {
    return db.getInventory();
  }

  async upsertInventory(items: InventoryItem[]): Promise<ImportStats> {
    await this.requireCloudWritePermission();
    let plan: ReturnType<typeof planCloudInventoryImport>;
    try {
      // Identity authority is the server, including tombstones that still hold
      // inventory_key. Cached active rows cannot prove a key is genuinely new.
      const rows = await fetchAll<InventoryItem & { deleted_at?: string | null }>(async (from, to) =>
        supabase.from('inventory_items').select('*').order('id').range(from, to));
      markCloudReachable();
      plan = planCloudInventoryImport(rows, items);
    } catch (cause) {
      throw classifyMyAcgImportError(cause, 'staging');
    }
    try {
      await this.applyCloudFieldMutations('inventory_items', plan.operations);
    } catch (cause) {
      throw classifyMyAcgImportError(cause, 'commit');
    }
    return plan.stats;
  }

  private readonly buyAnimePipeline = new BuyAnimeImportPipeline({
    load: readBuyAnimeJournal,
    save: async (record, version) => {
      await this.requireCloudWritePermission();
      assertCloudWriteAllowed();
      return saveBuyAnimeJournal(record, version);
    },
    prepareInventory: async items => {
      const rows = await fetchAll<InventoryItem & { deleted_at?: string | null }>(async (from, to) =>
        supabase.from('inventory_items').select('*').order('id').range(from, to));
      return planCloudInventoryImport(rows, items);
    },
    commitInventory: plan => this.applyCloudFieldMutations('inventory_items', plan.operations, { readback: false }),
    readInventory: record => this.readBuyAnimeCommittedRows(record),
    planCatalog: async imported => {
      const [inventory, groups, categories, variants] = await Promise.all([
        this.readActiveCatalogTable<InventoryItem>('inventory_items'),
        this.readActiveCatalogTable<ProductGroup>('product_groups'),
        this.readActiveCatalogTable<ProductCategory>('product_categories'),
        this.readActiveCatalogTable<ProductVariant>('product_variants'),
      ]);
      const titles = new Set(imported.map(row => row.normalized_product_title || normalizeProductTitle(row.product_title)));
      if (!groups.some(group => titles.has(group.normalized_title || normalizeProductTitle(group.title)))) return null;
      return planCatalogTransaction({ inventory, groups, categories, variants }, 'sync');
    },
    commitCatalog: async catalog => {
      if (!catalog.plan) return;
      await this.requireCloudWritePermission();
      assertCloudWriteAllowed();
      let response;
      try { response = await supabase.rpc(CATALOG_RPC, { p_idempotency_key: catalog.key, p_request: catalog.plan.request }); }
      catch (cause) { markCloudRequestFailed(cause); throw new CloudMutationBoundaryError('result-unknown', cause); }
      if (response.error) {
        markCloudRequestFailed(response.error);
        if (!response.error.code || response.status >= 500 || /^5/u.test(response.error.code))
          throw new CloudMutationBoundaryError('result-unknown', response.error);
        throw new BuyAnimeResumeError('BUYANIME_CATALOG_ROLLED_BACK', undefined, response.error);
      }
      if (response.data?.ok !== true) {
        if (response.data?.code === 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH')
          throw new BuyAnimeResumeError('BUYANIME_CATALOG_INTENT_CONFLICT');
        if (response.data?.ok === false && ['FIELD_CONFLICT','TRANSACTION_REJECTED'].includes(response.data.code))
          throw new BuyAnimeResumeError('BUYANIME_CATALOG_ROLLED_BACK', undefined, { code: response.data.code });
        throw new CloudMutationBoundaryError('result-unknown', new Error('BUYANIME_CATALOG_RESPONSE_INVALID'));
      }
      if (response.data.idempotencyKey !== catalog.key)
        throw new CloudMutationBoundaryError('result-unknown', new Error('BUYANIME_CATALOG_RESPONSE_IDENTITY_MISMATCH'));
      markCloudReachable();
    },
    verifyCatalog: async catalog => {
      if (!catalog.plan) return;
      for (const [table, ops] of Object.entries(catalog.plan.request.operations)) {
        if (!ops.length) continue;
        const expected = new Map(ops.map(op => [op.id, op.kind === 'create' ? op.values : op.kind === 'delete'
          ? {} : op.changes]));
        await this.readCloudIds(table, ops.map(op => op.id), expected);
      }
    },
    ensureWacaEvidence: async (record, imported) => {
      const variants = await this.getAuthoritativeWacaVariants();
      const evidence = linksFromMyAcgInventory(imported, variants, record.fileName, record.observedAt);
      if (!evidence.links.length) return;
      const snapshot = await this.getWacaSnapshot();
      const masterLinks = mergeMyAcgMasterLinks(snapshot.masterLinks, evidence.links);
      const canonical = (links: typeof masterLinks) => JSON.stringify([...links].sort((a, b) => a.childCode.localeCompare(b.childCode)));
      // Read-after-response-loss sees the same durable evidence and does NOT commit again.
      if (canonical(masterLinks) !== canonical(snapshot.masterLinks))
        await this.commitWacaSnapshot({ ...snapshot, masterLinks }, snapshot.revision, false);
    },
  });
  private async readActiveCatalogTable<T>(table: string): Promise<T[]> {
    return fetchAll<T>(async (from, to) => supabase.from(table).select('*').is('deleted_at', null).order('id').range(from, to));
  }
  private async readCloudIds(
    table: string, ids: string[], expected?: ReadonlyMap<string, Record<string, unknown>>,
  ): Promise<Record<string, unknown>[]> {
    try {
      const rows = await readCloudRowsByIds({
        table, ids, expected,
        load: async (chunk, signal) => {
          const result = await supabase.from(table).select('*').in('id', chunk).abortSignal(signal!);
          if (result.error) throw { ...result.error, status: result.status };
          return result.data || [];
        },
      });
      markCloudReachable();
      return rows;
    } catch (cause) { markCloudRequestFailed(cause); throw cause; }
  }
  private async readBuyAnimeCommittedRows(record: BuyAnimeImportRecord): Promise<InventoryItem[]> {
    const rows = await this.readCloudIds('inventory_items', record.expected.map(proof => proof.id));
    if (rows.some(row => row.deleted_at)) throw new BuyAnimeResumeError('BUYANIME_COMMITTED_ROW_DELETED', record);
    return rows as unknown as InventoryItem[];
  }
  async getBuyAnimeImportRecovery(): Promise<BuyAnimeImportRecord | null> {
    const pending = await readPendingBuyAnimeJournal();
    if (pending) return pending;
    // Pre-journal runtimes already persisted the import identity on Inventory.
    // Unknown downstream completion is shown explicitly, never inferred from global sync.
    const latest = await supabase.from('inventory_items').select('latest_catalog_import_id,catalog_last_seen_at')
      .is('deleted_at', null).not('latest_catalog_import_id', 'is', null)
      .order('catalog_last_seen_at', { ascending: false, nullsFirst: false }).limit(1);
    if (latest.error) throw latest.error;
    const batchId = latest.data?.[0]?.latest_catalog_import_id;
    if (!batchId) return null;
    const journal = await readBuyAnimeJournal(batchId);
    if (journal) return journal.stage === 'COMPLETE' ? null : journal;
    const rows = await fetchAll<InventoryItem>(async (from, to) => supabase.from('inventory_items').select('*')
      .eq('latest_catalog_import_id', batchId).order('id').range(from, to));
    const observedAt = rows[0]?.catalog_last_seen_at;
    if (!rows.length || !observedAt || rows.some(row => new Date(row.catalog_last_seen_at || '').getTime() !== new Date(observedAt).getTime()))
      throw new BuyAnimeResumeError('BUYANIME_LEGACY_BATCH_EVIDENCE_INVALID');
    const record: BuyAnimeImportRecord = {
      format: 'BUYANIME_IMPORT_RESUME_V1', batchId, observedAt, fileName: 'committed-catalog:' + batchId,
      stage: 'INVENTORY_COMMITTED', version: 0, legacy: true,
      expected: await Promise.all(rows.map(inventoryProof)),
      stats: { total: rows.length, newCount: 0, updatedCount: 0, unchangedCount: rows.length, groupCount: new Set(rows.map(row => row.normalized_product_title || row.product_title)).size },
    };
    assertImportRecord(record);
    return record;
  }
  async verifyBuyAnimeImportRecovery(record: BuyAnimeImportRecord): Promise<void> {
    await this.buyAnimePipeline.verify(record);
  }
  async importBuyAnimeInventory(items: InventoryItem[], fileName: string): Promise<BuyAnimeImportRecord> {
    await this.requireCloudWritePermission();
    assertCloudWriteAllowed();
    const pending = await this.getBuyAnimeImportRecovery();
    if (pending) throw new BuyAnimeResumeError('BUYANIME_EXISTING_BATCH_PENDING', pending);
    return this.buyAnimePipeline.start(items, fileName);
  }
  async resumeBuyAnimeImport(record: BuyAnimeImportRecord): Promise<BuyAnimeImportRecord> {
    await this.requireCloudWritePermission();
    assertCloudWriteAllowed();
    return this.buyAnimePipeline.resume(record);
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
        myacg_parent_code: r.myacg_parent_code || undefined,
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
        // An unchanged survivor does not mean there are no mutations: a
        // delete-only diff must reach field CAS before acknowledging/cache refresh.
        if (removedOrders.length > 0) await this.applyCloudCollection('private_orders', currentLocal, orders);
        return;
      }

      console.log(`[Private Order Sync] upsert orders count: ${activeOrders.length}`);
      await this.applyCloudCollection('private_orders', currentLocal, orders);
    } catch (err: any) {
      console.error('[Cloud Push ERROR] Supabase error message:', err.message || err);
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
      const existingParentOrders = await readCloudRowsByIds({
        table: 'private_orders', ids: parentOrderIds, select: 'id',
        load: async (ids, signal) => {
          const result = await supabase.from('private_orders').select('id').in('id', ids).abortSignal(signal!);
          if (result.error) { markCloudRequestFailed(result.error); throw result.error; }
          return result.data || [];
        },
      });
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
      () => buildJapanPackageTransactionRequest(currentPackage, scopedItems, command, supabaseEnvironment.projectRef),
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
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
      if (!isCloudFieldMutationError(err)) alert(cloudMutationFailureMessage(err));
      throw err;
    }
  }

  async deleteOutboundShipmentTransaction(command: OutboundShipmentDeleteCommand): Promise<OutboundShipmentDeleteSuccess> {
    await this.requireCloudWritePermission();
    const [currentShipments, currentItems] = await Promise.all([
      db.getOutboundShipments(),
      db.getOutboundShipmentItems(),
    ]);
    const shipment = currentShipments.find(entry => entry.id === command.shipmentId);
    if (!shipment) throw new OutboundShipmentDeleteBoundaryError('server-rejected');
    const scopedItems = currentItems.filter(item => item.outbound_shipment_id === command.shipmentId);
    const request = readOrCreatePendingOutboundDeleteRequest(
      command,
      () => buildOutboundShipmentDeleteRequest(shipment, scopedItems, supabaseEnvironment.projectRef),
    );
    const shipmentIds = [command.shipmentId];
    const itemIds = request.itemOperations.map(operation => operation.id);
    markLocalCloudWrite('outbound_shipments', shipmentIds);
    markLocalCloudWrite('outbound_shipment_items', itemIds);

    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await supabase.rpc(OUTBOUND_SHIPMENT_TRANSACTION_RPC, {
        p_idempotency_key: command.idempotencyKey,
        p_request: request,
      }));
    } catch (caughtError) {
      clearLocalCloudWrites('outbound_shipments', shipmentIds);
      clearLocalCloudWrites('outbound_shipment_items', itemIds);
      markCloudRequestFailed(caughtError);
      throw new OutboundShipmentDeleteBoundaryError('result-unknown');
    }
    if (error) {
      clearLocalCloudWrites('outbound_shipments', shipmentIds);
      clearLocalCloudWrites('outbound_shipment_items', itemIds);
      markCloudRequestFailed(error);
      throw new OutboundShipmentDeleteBoundaryError('server-rejected');
    }
    markCloudReachable();
    let result: OutboundShipmentDeleteSuccess;
    try {
      result = assertOutboundShipmentDeleteSucceeded(data);
    } catch {
      clearLocalCloudWrites('outbound_shipments', shipmentIds);
      clearLocalCloudWrites('outbound_shipment_items', itemIds);
      throw new OutboundShipmentDeleteBoundaryError('server-rejected');
    }
    const nextShipments = currentShipments.filter(entry => entry.id !== command.shipmentId);
    const nextItems = currentItems.filter(item => item.outbound_shipment_id !== command.shipmentId);
    try {
      await db.saveOutboundShipmentTransaction(nextShipments, nextItems);
      clearPendingOutboundDeleteRequest(command.idempotencyKey);
    } catch {
      clearLocalCloudWrites('outbound_shipments', shipmentIds);
      clearLocalCloudWrites('outbound_shipment_items', itemIds);
      return { ...result, syncPending: true };
    }
    return result;
  }

  async getImportBatches(): Promise<ImportBatch[]> {
    return db.getImportBatches();
  }

  async saveImportBatches(batches: ImportBatch[]): Promise<void> {
    void batches;
    throw new Error('雲端匯入批次必須由 Server 完成；本機快取不接受獨立寫入。');
  }

  async savePrivateOrderTransaction(command: PrivateOrderTransactionCommand): Promise<void> {
    await this.requireCloudWritePermission();
    const request=buildPrivateOrderRequest(command);
    const touchedItems=[...new Set([...command.baseItems,...command.items].map(i=>String(toCloudFieldRow('private_order_items',i).id)))];
    markLocalCloudWrite('private_orders',[request.orderId]);
    markLocalCloudWrite('private_order_items',touchedItems);
    const clearEcho=()=>{clearLocalCloudWrites('private_orders',[request.orderId]);clearLocalCloudWrites('private_order_items',touchedItems);};
    let response;
    try { response=await supabase.rpc(PRIVATE_ORDER_RPC,{p_idempotency_key:command.idempotencyKey,p_request:request}); }
    catch(error) { clearEcho(); markCloudRequestFailed(error); throw new CloudMutationBoundaryError('result-unknown',error); }
    if(response.error) {
      clearEcho();
      markCloudRequestFailed(response.error);
      // A SQL rejection is definitive; transport/server failures may have committed.
      if(!response.error.code || /^5/.test(response.error.code)) throw new CloudMutationBoundaryError('result-unknown',response.error);
      throw new SaveabilityError('私下登記未儲存，請確認帳號與資料；草稿已保留。');
    }
    const result=response.data;
    if(!result || result.ok!==true) { clearEcho(); throw new SaveabilityError(result?.code==='FIELD_CONFLICT'
      ? '私下登記已由其他裝置更新，本次完全未儲存；請保留草稿並重新確認。' : '私下登記未儲存，請確認資料；舊資料未變更。'); }
    markCloudReachable();
    try {
      // Do not trust an old replay result as the latest state. Read both resources
      // authoritatively; CloudTargetedCache commits them in one cache transaction.
      const itemIds=[...new Set([...touchedItems,...(Array.isArray(result.items)?result.items:[]).map((i:PrivateOrderItem)=>i.id)])];
      await this.mutationCache.refresh({reason:'realtime',resources:['privateOrders'],changes:[
        {table:'private_orders',databaseId:request.orderId,canonicalId:request.orderId,localId:null,resource:'privateOrders',kind:'UPDATE',origin:'local'},
        ...itemIds.map(id=>({table:'private_order_items',databaseId:id,canonicalId:id,localId:null,resource:'privateOrders' as const,kind:'UPDATE' as const,origin:'local' as const})),
      ]});
    } catch(error) { clearEcho(); throw new CloudMutationBoundaryError('committed-readback-pending',error); }
  }

  async reconcilePrivateOrderTransaction(command:PrivateOrderTransactionCommand):Promise<boolean> {
    const request=buildPrivateOrderRequest(command);
    try {
      // This is a SELECT-only result probe, not a new write. The RPC still
      // enforces current auth/editor scope; Cloud readiness stays guarded.
      if(!['owner','staff','helper'].includes((await this.getRole())??''))throw new Error('PRIVATE_RECONCILE_AUTH_REQUIRED');
      const response=await supabase.rpc('erp_reconcile_private_order_transaction',{
        p_idempotency_key:command.idempotencyKey,p_request:request,
      });
      if(response.error || response.data?.ok!==true)throw response.error??new Error('PRIVATE_RECONCILE_INVALID');
      if(response.data.committed!==true)return false;
      const ids=[...new Set([...command.baseItems,...command.items].map(i=>String(toCloudFieldRow('private_order_items',i).id)))];
      await this.mutationCache.refresh({reason:'realtime',resources:['privateOrders'],changes:[
        {table:'private_orders',databaseId:request.orderId,canonicalId:request.orderId,localId:null,resource:'privateOrders',kind:'UPDATE',origin:'local'},
        ...ids.map(id=>({table:'private_order_items',databaseId:id,canonicalId:id,localId:null,resource:'privateOrders' as const,kind:'UPDATE' as const,origin:'local' as const})),
      ]});
      return true;
    } catch(error){throw new CloudMutationBoundaryError('result-unknown',error);}
  }

  async getCloudDashboardCategoryImageRows(): Promise<Record<string, unknown>[]> {
    await this.requireCloudWritePermission();
    const rows = await fetchAll<Record<string, unknown>>(async (from, to) => supabase
      .from('dashboard_category_images').select('*').order('id').range(from, to));
    return rows;
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
      deadlineSidecar: await readDeadlineDurableBackup('cloud'),
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

  private async commitCatalog(mode:CatalogMode,itemCodes:string[]=[]) {
    await this.requireCloudWritePermission();
    const scope=`catalog:${mode}:${[...itemCodes].sort().join('|')}`;
    type Pending={idempotencyKey:string;plan:Awaited<ReturnType<typeof planCatalogTransaction>>};
    let pending=readFormIntent<Pending>(scope);
    if(!pending) {
      const [inventory,groups,categories,variants]=await Promise.all([db.getInventory(),db.getProductGroups(),db.getProductCategories(),db.getProductVariants({raw:true})]);
      const plan=await planCatalogTransaction({inventory,groups,categories,variants},mode,itemCodes);
      pending=stableFormIntent(scope,{},key=>({idempotencyKey:key,plan}));
    }
    const {idempotencyKey,plan}=pending;
    const echoEntries=Object.entries(plan.request.operations).map(([table,ops])=>({table,ids:ops.map(op=>op.id)}));
    echoEntries.forEach(({table,ids})=>markLocalCloudWrite(table,ids));
    const clearEcho=()=>echoEntries.forEach(({table,ids})=>clearLocalCloudWrites(table,ids));
    let response;
    try { response=await supabase.rpc(CATALOG_RPC,{p_idempotency_key:idempotencyKey,p_request:plan.request}); }
    catch(error){ clearEcho(); markCloudRequestFailed(error); throw new CloudMutationBoundaryError('result-unknown',error); }
    if(response.error) {
      clearEcho();
      markCloudRequestFailed(response.error);
      if(!response.error.code || /^5/.test(response.error.code)) throw new CloudMutationBoundaryError('result-unknown',response.error);
      clearFormIntent(scope);
      throw new SaveabilityError('商品操作未儲存，請確認帳號與資料後再試。');
    }
    if(response.data?.ok!==true){
      clearEcho();
      clearFormIntent(scope);
      throw new SaveabilityError(response.data?.code==='FIELD_CONFLICT' ? '商品資料已更新，本次完全未儲存；請重新整理後再試。' : '商品操作未儲存，舊資料未變更。');
    }
    markCloudReachable();
    try {
      const changes=Object.entries(plan.request.operations).flatMap(([table,ops])=>ops.map(op=>({
        table,databaseId:op.id,canonicalId:op.id,localId:null,resource:'products' as const,kind:'UPDATE' as const,origin:'local' as const,
      })));
      if(changes.length) await this.mutationCache.refresh({reason:'realtime',resources:['products'],changes});
      clearFormIntent(scope);
    } catch(error){ clearEcho(); throw new CloudMutationBoundaryError('committed-readback-pending',error); }
    return plan.summary;
  }
  async applyRelatedTransaction(command:RelatedTransactionCommand):Promise<void> {
    await this.requireCloudWritePermission();
    const request=buildRelatedRequest(command); let response;
    const echoEntries=Object.entries(request.expectedRecords).map(([table,rows])=>({table,ids:rows.map(row=>String(row.id))}));
    echoEntries.forEach(({table,ids})=>markLocalCloudWrite(table,ids));
    const clearEcho=()=>echoEntries.forEach(({table,ids})=>clearLocalCloudWrites(table,ids));
    try{response=await supabase.rpc(RELATED_RPC,{p_idempotency_key:command.idempotencyKey,p_request:request});}
    catch(error){clearEcho();markCloudRequestFailed(error);throw new CloudMutationBoundaryError('result-unknown',error);}
    if(response.error){
      clearEcho();
      markCloudRequestFailed(response.error);
      if(!response.error.code||/^5/.test(response.error.code))throw new CloudMutationBoundaryError('result-unknown',response.error);
      throw new SaveabilityError('本次操作未儲存，請確認帳號與資料。');
    }
    if(response.data?.ok!==true){clearEcho();throw new SaveabilityError(response.data?.code==='DEPENDENT_RECORDS_EXIST'
      ?'資料仍有包裹或出庫關聯，請先處理關聯；本次完全未刪除。'
      :response.data?.code==='FIELD_CONFLICT'?'資料已更新，本次完全未儲存；請重新整理確認。':'本次操作未儲存，舊資料未變更。');}
    markCloudReachable();
    try{
      const changes=Object.entries(request.expectedRecords).flatMap(([table,rows])=>rows.map(row=>({
        table,databaseId:String(row.id),canonicalId:String(row.id),localId:null,resource:CLOUD_TABLE_RESOURCE[table],kind:'UPDATE' as const,origin:'local' as const,
      })));
      const parent=response.data.parentId;
      if(parent)changes.push({table:'japan_packages',databaseId:parent,canonicalId:parent,localId:null,resource:'japanPackages',kind:'UPDATE',origin:'local'});
      await this.mutationCache.refresh({reason:'realtime',resources:[...new Set(changes.map(c=>c.resource))],changes});
    }catch(error){clearEcho();throw new CloudMutationBoundaryError('committed-readback-pending',error);}
  }
  async createPurchaseRecordFromInventory(itemCodes:string[]):Promise<void> { await this.commitCatalog('create',itemCodes); }
  async reparseProductVariants():Promise<void> { await this.commitCatalog('reparse'); }
  async reparseProductTitles():Promise<void> {
    throw new Error('商品標題清理僅適用本機歷史資料；雲端請使用商品名稱顯示規則，不改原始名稱。');
  }
  async syncProductGroupsWithInventory():Promise<{filledVariantsCount:number;affectedGroupsCount:number;upgradedSkusCount?:number}> {
    return this.commitCatalog('sync');
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

    const current = await db.getProductVariants({raw:true});
    const target=current.find(variant=>variant.id===id);if(!target)throw new SaveabilityError('找不到規格，請重新整理確認。');
    await submitRelatedIntent({family:'variant-delete',rootId:id,collections:[
      {entity:'product_variants',base:[target],next:[]},
    ]},command=>this.applyRelatedTransaction(command));
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
