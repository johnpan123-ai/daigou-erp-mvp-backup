import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, FileCheck2, RotateCcw } from 'lucide-react';
import { useAuth } from '../auth/authContext';
import { useRole } from '../auth/useRole';
import { useCloudResourceSync } from '../contexts/CloudRealtimeSyncContext';
import { dataProvider } from '../providers/dataProvider';
import {
  prepareCloudRestoreSnapshot,
  CloudRestoreValidationError,
  preserveLegacyCloudDashboardImages,
  sha256BytesHex, sha256Hex, stableCloudRestoreJson,
  type CloudRestoreAttemptCommand,
  type CloudRestoreAttemptOutcome,
  type CloudRestoreCandidate,
  type CloudRestoreExecutionCommand,
  type CloudRestoreResult,
} from '../providers/cloud/cloudAtomicRestore';
import { readDeadlineDurableBackup, restoreDeadlineDurableBackup } from '../lib/closingDateSidecarBackup';
import {
  clearCloudDeadlineRestoreStage, readCloudDeadlineRestoreStage, stageCloudDeadlineRestore,
} from '../lib/cloudDeadlineRestoreStage';
import {
  bindCloudRestoreCandidateProof,
  isCloudRestoreCandidateProofCurrent,
  type CloudRestoreCandidateProofRecord,
  type CloudRestoreCandidateProofResult,
} from '../providers/cloud/cloudRestoreCandidateProof';
import {
  getCloudConnectivitySnapshot,
  subscribeCloudConnectivity,
} from '../providers/cloud/cloudConnectivity';
import { isCloudRestoreFailureCode, type CloudRestoreFailure } from '../providers/cloud/cloudRestoreFailure';
import type { CloudRestoreIntegrityAudit } from '../providers/cloud/cloudRestoreIntegrityAudit';
import {
  assertCloudRestoreEffectiveCandidate,
  prepareCrossEnvironmentCloudRestoreCandidate,
  type CloudRestoreTargetCompatibilityResult,
} from '../providers/cloud/cloudRestorePortability';
import type { CloudRestoreRecoveryAttempt } from '../providers/cloud/cloudRestoreRecovery';
import { CloudRestoreReconcileSchedule } from '../providers/cloud/cloudRestoreReconcileSchedule';
import {
  CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE,
  clearCloudRestoreUnresolvedAttempt,
  createCloudRestoreSafeSubmitError,
  formatCloudRestoreSubmitError,
  inspectCurrentCloudRestoreReadiness,
  ensureCloudRestorePrepareReadiness,
  normalizeCloudRestoreSubmitError,
  persistCloudRestoreUnresolvedAttempt,
  readCloudRestoreUnresolvedAttempt,
  readOrCreateCloudRestoreIntentIdentity,
  recordCloudRestoreSubmitDiagnostic,
  retireCloudRestoreIntentIdentity,
  type CloudRestoreIntentIdentity,
  type CloudRestoreVisibleError,
} from '../providers/cloud/cloudRestoreSubmit';
import type { CloudResource } from '../providers/cloud/cloudSyncDomain';
import { getProviderMode } from '../providers/providerMode';
import { supabaseEnvironment } from '../providers/cloud/supabaseClient';
import CloudRestoreIntegrityAuditTool from './CloudRestoreIntegrityAudit';
import { verifyCommittedRestore, RestoreReadbackError, classifyRestoreReadbackError,
  type RestoreVerificationSummary, type RestoreVerificationIdentity } from '../providers/cloud/cloudRestorePostCommit';

const CONFIRMATION_TEXT = 'OVERWRITE CLOUD DATA';
const CLOUD_RESTORE_READINESS_RESOURCES: CloudResource[] = [
  'products', 'purchases', 'privateOrders', 'inventory', 'bundles',
  'japanPackages', 'outboundShipments', 'salesOrders',
];
const ignoreCloudResourceRefresh = () => {};

type RestoreStatus = 'idle' | 'preflighting' | 'ready' | 'restoring' | 'checking' | 'success' | 'error' | 'unknown';
type RestoreProgressStep = 'prepare' | 'restore' | 'validate' | 'refresh';

interface CloudAtomicRestorePanelProps {
  proveRestoreCandidate?: (candidate: CloudRestoreCandidate) => Promise<CloudRestoreCandidateProofResult>;
  prepareRestoreAttempt?: (command: Parameters<typeof dataProvider.prepareCloudRestoreAttempt>[0]) => ReturnType<typeof dataProvider.prepareCloudRestoreAttempt>;
  checkRestoreOutcome?: (command: CloudRestoreAttemptCommand) => Promise<CloudRestoreAttemptOutcome>;
  executeRestore?: (command: CloudRestoreExecutionCommand) => Promise<CloudRestoreResult>;
  validateRestoreTarget?: (command: Parameters<typeof dataProvider.validateCloudRestoreTarget>[0]) => Promise<CloudRestoreTargetCompatibilityResult>;
  readRestoreIntegrityAudit?: () => Promise<CloudRestoreIntegrityAudit>;
  readPostCommitVerification?: (identity: RestoreVerificationIdentity) => Promise<RestoreVerificationSummary>;
  onAuthoritativeRefreshComplete?: (restoreEpoch: number) => void | Promise<void>;
}

interface PendingRestoreAttempt {
  correlationId: string;
  idempotencyKey: string;
  fingerprint: string;
  executionId?: string;
  expectedEpoch?: number;
}

const progressLabels: Array<[RestoreProgressStep, string]> = [
  ['prepare', '準備資料'],
  ['restore', '安全還原'],
  ['validate', '驗證結果'],
  ['refresh', '更新畫面'],
];
const progressIndex = (step: RestoreProgressStep): number => progressLabels.findIndex(([value]) => value === step);

export default function CloudAtomicRestorePanel({
  proveRestoreCandidate,
  prepareRestoreAttempt,
  checkRestoreOutcome,
  executeRestore,
  readPostCommitVerification,
  onAuthoritativeRefreshComplete,
}: CloudAtomicRestorePanelProps = {}) {
  const { user } = useAuth();
  const { role } = useRole();
  const fileRef = useRef<HTMLInputElement>(null);
  const retryKeys = useRef(new Map<string, CloudRestoreIntentIdentity>());
  const freshIntentRef = useRef(false);
  const pendingAttemptRef = useRef<PendingRestoreAttempt | null>(null);
  const inFlightRef = useRef(false);
  const proofRequestTokenRef = useRef(0);
  const proofRecordRef = useRef<CloudRestoreCandidateProofRecord | null>(null);
  const proofUserIdRef = useRef(user?.id ?? '');
  const candidateGenerationRef = useRef(0);
  const reconcileSchedule = useRef(new CloudRestoreReconcileSchedule());
  const [initialUnresolvedAttempt] = useState(readCloudRestoreUnresolvedAttempt);
  const [candidateGeneration, setCandidateGeneration] = useState(0);
  const [sourceCandidate, setSourceCandidate] = useState<CloudRestoreCandidate | null>(null);
  const [candidate, setCandidate] = useState<CloudRestoreCandidate | null>(null);
  const [proofRecord, setProofRecord] = useState<CloudRestoreCandidateProofRecord | null>(null);
  const [proofMessage, setProofMessage] = useState('尚未完成安全檢查');
  const [prepareTimings, setPrepareTimings] = useState<Record<string, number> | null>(null);
  const [status, setStatus] = useState<RestoreStatus>(initialUnresolvedAttempt ? 'unknown' : 'idle');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<CloudRestoreResult | null>(null);
  const [verificationSummary, setVerificationSummary] = useState<RestoreVerificationSummary | null>(null);
  const [verificationError, setVerificationError] = useState<RestoreReadbackError | null>(null);
  const [latestCompletedAttempt, setLatestCompletedAttempt] = useState<RestoreVerificationIdentity | null>(null);
  const activeVerificationRef = useRef<string | null>(initialUnresolvedAttempt?.attemptId ?? null);
  const [visibleError, setVisibleError] = useState<CloudRestoreVisibleError | null>(null);
  const [failureEvidence, setFailureEvidence] = useState<CloudRestoreFailure | null>(null);
  const [lastAttempt, setLastAttempt] = useState<PendingRestoreAttempt | null>(null);
  const [progressStep, setProgressStep] = useState<RestoreProgressStep>('prepare');
  const [screenRefreshPending, setScreenRefreshPending] = useState(false);
  const [attemptClosed, setAttemptClosed] = useState(false);
  const [reconcileAfter, setReconcileAfter] = useState<string | null>(null);
  const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const [reconcileWakeVersion, setReconcileWakeVersion] = useState(0);
  const [recovery, setRecovery] = useState<{ userId: string; ready: boolean; error: boolean }>({ userId: '', ready: false, error: false });
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [recoveredAttempt, setRecoveredAttempt] = useState<CloudRestoreRecoveryAttempt | null>(null);
  const [unresolvedAttempt, setUnresolvedAttempt] = useState<CloudRestoreAttemptCommand | null>(initialUnresolvedAttempt);
  const submissionLockedRef = useRef(Boolean(initialUnresolvedAttempt));
  const cloudMode = getProviderMode() === 'cloud';
  const owner = role === 'owner';
  const connectivity = useSyncExternalStore(
    subscribeCloudConnectivity,
    getCloudConnectivitySnapshot,
    getCloudConnectivitySnapshot,
  );
  const online = browserOnline && connectivity.status === 'online';
  const fresh = connectivity.readStatus === 'fresh-online' || connectivity.readStatus === 'fresh-empty';
  const recoveryReady = recovery.ready && recovery.userId === user?.id;
  const canChooseFile = cloudMode && Boolean(user) && owner && online && recoveryReady;
  const allowed = canChooseFile && fresh;
  const proofCurrent = isCloudRestoreCandidateProofCurrent(proofRecord, candidate, {
    candidateGeneration,
    userId: user?.id ?? '',
    targetProjectRef: supabaseEnvironment.projectRef,
  });
  const { refreshAuthoritative } = useCloudResourceSync(
    'cloud-restore-authoritative-readiness',
    CLOUD_RESTORE_READINESS_RESOURCES,
    false,
    ignoreCloudResourceRefresh,
  );

  const invalidateProof = useCallback((nextMessage = '尚未完成安全檢查') => {
    proofRequestTokenRef.current += 1;
    proofRecordRef.current = null;
    setProofRecord(null);
    setProofMessage(nextMessage);
  }, []);

  useEffect(() => {
    const currentUserId = user?.id ?? '';
    if (proofUserIdRef.current === currentUserId) return;
    proofUserIdRef.current = currentUserId;
    activeVerificationRef.current = null;
    invalidateProof('登入身分已變更，請重新選擇備份。');
  }, [invalidateProof, user?.id]);

  useEffect(() => {
    if (!cloudMode || !unresolvedAttempt) return;
    activeVerificationRef.current = unresolvedAttempt.attemptId;
    // Reload/recovery must keep the same pending identity until its own
    // authoritative outcome is verified; a fresh unrelated read cannot close it.
    window.dispatchEvent(new CustomEvent('cloud-restore-authoritative-pending', {
      detail: { attemptId: unresolvedAttempt.attemptId },
    }));
  }, [cloudMode, unresolvedAttempt]);

  useEffect(() => {
    if (!cloudMode || !owner || !user?.id || !browserOnline) return;
    let active = true;
    const userId = user.id;
    void dataProvider.getPendingCloudRestoreAttempts().then(async attempts => {
      if (!active) return;
      const pending = attempts[0];
      if (pending) {
        candidateGenerationRef.current += 1;
        setCandidateGeneration(candidateGenerationRef.current);
        invalidateProof('找到未完成的還原，正在自動查證結果。');
        pendingAttemptRef.current = null;
        setRecoveredAttempt(pending);
        setUnresolvedAttempt(pending);
        persistCloudRestoreUnresolvedAttempt(pending);
        submissionLockedRef.current = true;
        setLastAttempt({
          correlationId: pending.traceId,
          idempotencyKey: pending.attemptId,
          fingerprint: pending.effectiveFingerprint,
          expectedEpoch: pending.expectedEpoch,
        });
        setStatus('unknown');
        setMessage('找到未完成的還原；系統只會查證既有結果，不會再次執行。');
      } else {
        const completed = await dataProvider.getLatestCompletedCloudRestoreAttempt();
        if (!active) return;
        setLatestCompletedAttempt(completed);
      }
      setRecovery({ userId, ready: true, error: false });
    }).catch(() => {
      if (active) setRecovery({ userId, ready: false, error: true });
    });
    return () => { active = false; };
  }, [cloudMode, owner, user?.id, browserOnline, recoveryVersion, invalidateProof]);

  useEffect(() => {
    const wake = () => {
      setBrowserOnline(navigator.onLine !== false);
      if (navigator.onLine !== false) setReconcileWakeVersion(version => version + 1);
    };
    const sleep = () => setBrowserOnline(false);
    const visible = () => { if (document.visibilityState === 'visible') wake(); };
    window.addEventListener('online', wake);
    window.addEventListener('offline', sleep);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', sleep);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  const refreshRecovery = () => {
    setRecovery({ userId: '', ready: false, error: false });
    setRecoveryVersion(version => version + 1);
  };

  const resetPreparedRestore = (nextMessage = '') => {
    freshIntentRef.current = false;
    candidateGenerationRef.current += 1;
    setCandidateGeneration(candidateGenerationRef.current);
    invalidateProof();
    pendingAttemptRef.current = null;
    submissionLockedRef.current = false;
    setCandidate(null);
    setSourceCandidate(null);
    setResult(null);
    setVerificationSummary(null);
    setVerificationError(null);
    activeVerificationRef.current = null;
    setVisibleError(null);
    setFailureEvidence(null);
    setLastAttempt(null);
    setAttemptClosed(false);
    setProgressStep('prepare');
    setScreenRefreshPending(false);
    setStatus('idle');
    setMessage(nextMessage);
  };

  const startNewIntent = () => {
    if (unresolvedAttempt || inFlightRef.current || !recoveryReady) return;
    setRecoveredAttempt(null);
    resetPreparedRestore('請選擇要還原的 JSON 備份。');
    refreshRecovery();
  };

  const selectFile = async (file: File | undefined) => {
    if (!file || unresolvedAttempt || !canChooseFile || inFlightRef.current) return;
    const generation = candidateGenerationRef.current + 1;
    const proofToken = proofRequestTokenRef.current + 1;
    candidateGenerationRef.current = generation;
    proofRequestTokenRef.current = proofToken;
    setCandidateGeneration(generation);
    proofRecordRef.current = null;
    setProofRecord(null);
    setProofMessage('正在完成安全檢查…');
    setPrepareTimings(null);
    setStatus('preflighting');
    setMessage('正在讀取備份檔案；尚未寫入任何資料。');
    setCandidate(null);
    setSourceCandidate(null);
    setResult(null);
    setVerificationSummary(null);
    setVerificationError(null);
    setVisibleError(null);
    setFailureEvidence(null);
    setAttemptClosed(false);
    submissionLockedRef.current = false;
    pendingAttemptRef.current = null;
    setProgressStep('prepare');
    setScreenRefreshPending(false);
    const selectionStarted = performance.now();
    const timings: Record<string, number> = {};
    let phaseStarted = selectionStarted;
    const finishPhase = (name: string) => {
      const now = performance.now();
      timings[name] = Math.round(now - phaseStarted);
      phaseStarted = now;
    };
    try {
      const rawBytes = await file.arrayBuffer();
      const sourceFileSha256 = await sha256BytesHex(rawBytes);
      finishPhase('fileReadAndHash');
      setMessage('正在驗證備份資料…');
      // Keep original byte SHA; object input follows the same canonical parser.
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder().decode(rawBytes)); }
      catch (error) { throw new CloudRestoreValidationError('MALFORMED_JSON', `JSON 解析失敗：${error instanceof Error ? error.message : String(error)}`); }
      finishPhase('clientJsonParse');
      let source = await prepareCloudRestoreSnapshot(parsed, {
        fileName: file.name,
        sourceEnvironment: window.location.origin,
        sourceFileSha256,
      });
      finishPhase('clientNormalizationAndValidation');
      if (candidateGenerationRef.current !== generation) return;
      const readiness = await ensureCloudRestorePrepareReadiness({
        cloudMode: getProviderMode() === 'cloud', authenticated: Boolean(user), owner: role === 'owner',
      }, refreshAuthoritative ? async () => (await refreshAuthoritative(CLOUD_RESTORE_READINESS_RESOURCES)) !== false : undefined);
      finishPhase('authoritativeReadiness');
      if (!readiness.allowed) throw createCloudRestoreSafeSubmitError({ code: readiness.code }, 'pre-dispatch');
      if (source.legacyWacaBackup) {
        const targetImages = await dataProvider.getCloudDashboardCategoryImageRows();
        if (candidateGenerationRef.current !== generation) return;
        source = await preserveLegacyCloudDashboardImages(source, targetImages);
      }
      setSourceCandidate(source);
      const preserveAuditIdentity = !source.legacyWacaBackup
        && await dataProvider.canPreserveCloudRestoreAuditIdentity(source);
      const portable = preserveAuditIdentity ? source
        : await prepareCrossEnvironmentCloudRestoreCandidate(source, supabaseEnvironment.projectRef);
      const prepared = portable.portability && portable.portability.totalTransformedRows > 0 ? portable : source;
      finishPhase('targetCompatibility');
      setMessage('正在上傳資料並驗證關聯…');
      const proof = await (proveRestoreCandidate ?? (value => dataProvider.proveCloudRestoreCandidate(value)))(prepared);
      finishPhase('uploadStageAndServerProof');
      for (const [phase, ms] of Object.entries(proof.prepareTransportTimingsMs ?? {})) timings[`transport.${phase}`] = ms;
      if (candidateGenerationRef.current !== generation || proofRequestTokenRef.current !== proofToken) return;
      const currentUserId = user?.id ?? '';
      proofUserIdRef.current = currentUserId;
      const record = bindCloudRestoreCandidateProof(prepared, proof, {
        candidateGeneration: generation,
        userId: currentUserId,
        targetProjectRef: supabaseEnvironment.projectRef,
      });
      proofRecordRef.current = record;
      setProofRecord(record);
      setCandidate(prepared);
      // A newly selected, proved file is a new explicit restore intent. A
      // response-loss retry/reconcile never reaches this file-selection path.
      freshIntentRef.current = true;
      setProofMessage('安全檢查已通過');
      setStatus('ready');
      setMessage('所有安全檢查已通過。');
      setPrepareTimings({ ...timings, total: Math.round(performance.now() - selectionStarted) });
    } catch (error) {
      if (candidateGenerationRef.current !== generation) return;
      const safe = normalizeCloudRestoreSubmitError(error, 'readiness', { source: 'pre-dispatch' });
      setVisibleError(safe);
      setProofMessage('安全檢查未通過');
      setStatus('error');
      setMessage(formatCloudRestoreSubmitError(safe));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const cancelPreparedRestore = () => {
    if (inFlightRef.current || unresolvedAttempt) return;
    resetPreparedRestore('已取消；沒有建立還原 attempt，也沒有修改資料。');
  };

  const completeRestore = async (restored: CloudRestoreResult, pending: PendingRestoreAttempt, readOnly = false) => {
    if (activeVerificationRef.current && activeVerificationRef.current !== pending.idempotencyKey) return;
    activeVerificationRef.current = pending.idempotencyKey;
    const verifyingUserId = user?.id;
    const matching = () => activeVerificationRef.current === pending.idempotencyKey
      && Boolean(verifyingUserId) && proofUserIdRef.current === verifyingUserId;
    // Keep recovery durable until BOTH verification and authoritative refresh pass.
    const command = { attemptId: pending.idempotencyKey, traceId: pending.correlationId };
    setUnresolvedAttempt(command);
    persistCloudRestoreUnresolvedAttempt(command);
    setResult(restored);
    setProgressStep('validate');
    setMessage('資料已提交，正在驗證完整性。');
    setRecoveredAttempt(null);
    refreshRecovery();
    submissionLockedRef.current = true;
    let verifiedGeneration: number;
    try {
      if (!pending.executionId) throw new RestoreReadbackError('RESTORE_READBACK_SERVER_ERROR');
      const identity = { ...command, executionId: pending.executionId };
      const summary = await verifyCommittedRestore(() =>
        (readPostCommitVerification ?? (id => dataProvider.verifyCommittedCloudRestore(id)))(identity), restored);
      if (!matching()) return;
      setVerificationSummary(summary);
      verifiedGeneration = summary.businessGeneration;
      setVerificationError(null);
      setVisibleError(null);
    } catch (error) {
      if (!matching()) return;
      setVerificationError(classifyRestoreReadbackError(error));
      setAttemptClosed(true);
      setStatus('error');
      setMessage('還原已成功提交，但系統暫時無法完成結果驗證。請重新驗證結果，請勿再次執行還原。');
      return;
    }
    let deadlineStage;
    try {
      deadlineStage = await readCloudDeadlineRestoreStage(pending.idempotencyKey);
    } catch {
      deadlineStage = null;
    }
    if (deadlineStage?.deadlineSidecar) {
      try {
        // Reconciliation is READ ONLY: never repair Deadline or replay Restore.
        if (!readOnly) await restoreDeadlineDurableBackup('cloud', deadlineStage.deadlineSidecar);
        const readBack = await readDeadlineDurableBackup('cloud');
        if (await sha256Hex(stableCloudRestoreJson(readBack)) !== deadlineStage.deadlineSidecarSha256) {
          throw new Error('DEADLINE_SIDECAR_READBACK_MISMATCH');
        }
      } catch {
        if (!matching()) return;
        setAttemptClosed(true);
        setStatus('error');
        setMessage('雲端 ERP 資料已還原，但期限對照資料尚未通過還原驗證。請勿再次執行雲端還原；請保留原備份檔並聯繫維護者完成期限對照修復。');
        return;
      }
    } else if (!deadlineStage?.legacyBackup) {
      if (!matching()) return;
      setAttemptClosed(true);
      setStatus('error');
      setMessage('雲端 ERP 資料已還原，但期限對照還原暫存無法讀取。請勿再次執行雲端還原；請保留原備份檔並聯繫維護者。');
      return;
    }
    if (!matching()) return;
    setProgressStep('refresh');
    let syncPending = false;
    try {
      if (!refreshAuthoritative || (await refreshAuthoritative(CLOUD_RESTORE_READINESS_RESOURCES)) === false) {
        throw new Error('RESTORE_AUTHORITATIVE_REFRESH_PENDING');
      }
    } catch { syncPending = true; }
    if (onAuthoritativeRefreshComplete) {
      try {
        await onAuthoritativeRefreshComplete(restored.restoreEpoch);
      } catch {
        syncPending = true;
      }
    }
    if (!matching()) return;
    if (!syncPending && pending.executionId) {
      try {
        const identity = { ...command, executionId: pending.executionId };
        const afterRefresh = await verifyCommittedRestore(() =>
          (readPostCommitVerification ?? (id => dataProvider.verifyCommittedCloudRestore(id)))(identity), restored);
        if (!matching()) return;
        if (afterRefresh.businessGeneration !== verifiedGeneration) {
          throw new RestoreReadbackError('RESTORE_COMMITTED_STATE_MISMATCH');
        }
        setVerificationSummary(afterRefresh);
      } catch (error) {
        if (!matching()) return;
        setVerificationError(classifyRestoreReadbackError(error));
        syncPending = true;
      }
    }
    if (syncPending) {
      setStatus('error');
      setMessage('還原結果已驗證，但畫面尚未完成雲端同步；寫入仍暫停，請重新驗證結果。');
      return;
    }
    // Keep the Deadline evidence available for later read-only re-verification.
    // It is environment-local hand-off state, not part of the Business Backup.
    setUnresolvedAttempt(null);
    clearCloudRestoreUnresolvedAttempt();
    setAttemptClosed(true);
    setScreenRefreshPending(syncPending);
    setStatus('success');
    setMessage(deadlineStage?.legacyBackup
      ? '舊版雲端備份已還原。WACA 數量保留為備份當時狀態，需匯入完整歷史訂單；目前首頁圖片已保留，舊備份不含期限對照資料，請重新確認對照。'
      : syncPending
      ? '還原已完成；畫面仍在同步最新資料，請勿再次還原。'
      : '還原完成，畫面已更新為最新資料。');
    if (!syncPending) {
      window.dispatchEvent(new CustomEvent('cloud-restore-completed', { detail: {
        restoreEpoch: restored.restoreEpoch, attemptId: pending.idempotencyKey,
      } }));
    }
    recordCloudRestoreSubmitDiagnostic({
      event: 'submit-finish', phase: 'submit', outcome: syncPending ? 'sync-pending' : 'success',
      attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
    });
  };

  const checkOutcome = async () => {
    if (!unresolvedAttempt || inFlightRef.current || !cloudMode || !user || !owner || !browserOnline || !recoveryReady) return;
    inFlightRef.current = true;
    setStatus('checking');
    setProgressStep('validate');
    setMessage('正在安全查證既有還原結果；不會再次執行。');
    try {
      const outcome = await (checkRestoreOutcome ?? (command => dataProvider.reconcileCloudRestoreAttempt(command)))(unresolvedAttempt);
      if (activeVerificationRef.current !== unresolvedAttempt.attemptId) return;
      setLastAttempt(previous => ({
        correlationId: outcome.traceId,
        idempotencyKey: outcome.attemptId,
        fingerprint: outcome.effectiveFingerprint,
        ...(outcome.executionId ? { executionId: outcome.executionId } : previous?.executionId ? { executionId: previous.executionId } : {}),
        expectedEpoch: outcome.expectedEpoch,
      }));
      if (outcome.status === 'completed' && outcome.restoreResult) {
        await completeRestore(outcome.restoreResult, {
          correlationId: outcome.traceId,
          idempotencyKey: outcome.attemptId,
          fingerprint: outcome.effectiveFingerprint,
          ...(outcome.executionId ? { executionId: outcome.executionId } : {}),
          expectedEpoch: outcome.expectedEpoch,
        }, true);
      } else if (outcome.status === 'not_committed') {
        window.dispatchEvent(new CustomEvent('cloud-restore-not-committed', { detail: { attemptId: outcome.attemptId } }));
        void clearCloudDeadlineRestoreStage(outcome.attemptId).catch(() => {});
        setFailureEvidence(outcome.failure ?? null);
        setUnresolvedAttempt(null);
        setRecoveredAttempt(null);
        clearCloudRestoreUnresolvedAttempt();
        retireCloudRestoreIntentIdentity(unresolvedAttempt, retryKeys.current);
        setAttemptClosed(true);
        setStatus('error');
        submissionLockedRef.current = true;
        const safe = normalizeCloudRestoreSubmitError(
          createCloudRestoreSafeSubmitError({ code: outcome.failure?.code ?? 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED' }, 'server-response'),
          'rpc',
          { source: 'server-response', attemptCorrelationId: outcome.traceId },
        );
        setVisibleError(safe);
        setMessage(formatCloudRestoreSubmitError(safe));
        refreshRecovery();
      } else {
        setReconcileAfter(outcome.reconcileAfter ?? null);
        setStatus('unknown');
        submissionLockedRef.current = true;
        setMessage('還原結果需要查證，資料不會自動再次還原。');
      }
    } catch (error) {
      const safe = normalizeCloudRestoreSubmitError(error, 'rpc', {
        source: 'post-dispatch', attemptCorrelationId: unresolvedAttempt.traceId,
      });
      setVisibleError(safe);
      setStatus('unknown');
      submissionLockedRef.current = true;
      setMessage('還原結果需要查證，資料不會自動再次還原。');
    } finally {
      inFlightRef.current = false;
    }
  };

  const runScheduledReconcile = useEffectEvent(() => {
    if (inFlightRef.current || !unresolvedAttempt || !browserOnline || !recoveryReady) return;
    reconcileSchedule.current.mark(unresolvedAttempt.traceId);
    void checkOutcome();
  });
  useEffect(() => {
    if (!unresolvedAttempt || !cloudMode || !owner || !user?.id || !browserOnline || !recoveryReady
      || (result && status === 'error')
      || status === 'restoring' || status === 'checking') return;
    const delay = reconcileSchedule.current.delay(unresolvedAttempt.traceId, reconcileAfter, Date.now());
    if (delay === null) return;
    const timer = window.setTimeout(runScheduledReconcile, delay);
    return () => window.clearTimeout(timer);
  }, [unresolvedAttempt, cloudMode, owner, user?.id, browserOnline, recoveryReady, status, reconcileAfter,
    reconcileWakeVersion, connectivity.lastFreshReadAt, result]);

  const execute = async (pending: PendingRestoreAttempt) => {
    const activeCandidate = candidate;
    if (!activeCandidate) return;
    const hasCurrentProof = () => isCloudRestoreCandidateProofCurrent(proofRecordRef.current, activeCandidate, {
      candidateGeneration: candidateGenerationRef.current,
      userId: proofUserIdRef.current,
      targetProjectRef: supabaseEnvironment.projectRef,
    });
    if (!hasCurrentProof()) {
      inFlightRef.current = false;
      submissionLockedRef.current = false;
      pendingAttemptRef.current = null;
      const safe = normalizeCloudRestoreSubmitError({ code: 'CLOUD_RESTORE_PROOF_REQUIRED' }, 'readiness', { source: 'pre-dispatch' });
      setVisibleError(safe);
      setStatus('error');
      setMessage('安全檢查已失效，請重新選擇備份。');
      return;
    }
    recordCloudRestoreSubmitDiagnostic({
      event: 'confirmation-complete', phase: 'confirmation', outcome: 'success',
      attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
      readStatus: getCloudConnectivitySnapshot().readStatus,
    });
    const readiness = inspectCurrentCloudRestoreReadiness({
      cloudMode: getProviderMode() === 'cloud', authenticated: Boolean(user), owner: role === 'owner',
    });
    if (!readiness.allowed) {
      const safe = normalizeCloudRestoreSubmitError({ code: readiness.code }, 'readiness', {
        source: 'pre-dispatch', attemptCorrelationId: pending.correlationId,
      });
      recordCloudRestoreSubmitDiagnostic({
        event: 'readiness-check-blocked', phase: 'readiness', outcome: 'not-submitted',
        attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
        readStatus: readiness.connectivity.readStatus, error: safe,
      });
      pendingAttemptRef.current = null;
      inFlightRef.current = false;
      submissionLockedRef.current = false;
      setVisibleError(safe);
      setStatus('error');
      setMessage(CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE);
      return;
    }
    recordCloudRestoreSubmitDiagnostic({
      event: 'readiness-check-pass', phase: 'readiness',
      attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
      readStatus: readiness.connectivity.readStatus,
    });
    setStatus('restoring');
    setProgressStep('prepare');
    setMessage('正在安全還原資料…');
    let restoreDispatched = false;
    let durableAttempt: CloudRestoreAttemptOutcome | null = null;
    let attemptPrepareStarted = false;
    try {
      if (!hasCurrentProof()) throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_PROOF_REQUIRED' }, 'pre-dispatch');
      const activeProof = proofRecordRef.current?.result;
      if (!activeProof) throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_PROOF_REQUIRED' }, 'pre-dispatch');
      await assertCloudRestoreEffectiveCandidate(activeCandidate);
      // This survives a page reload while the Cloud attempt is unresolved.
      // A completed Cloud restore can therefore finish the Deadline sidecar
      // without re-running the business restore or asking for the file again.
      await stageCloudDeadlineRestore({
        id: pending.idempotencyKey,
        sourceFingerprint: activeCandidate.executionFingerprint,
        legacyBackup: activeCandidate.legacyWacaBackup === true,
        deadlineSidecar: activeCandidate.deadlineSidecar,
        deadlineSidecarSha256: activeCandidate.deadlineSidecarSha256,
      });
      attemptPrepareStarted = true;
      persistCloudRestoreUnresolvedAttempt({ attemptId: pending.idempotencyKey, traceId: pending.correlationId });
      durableAttempt = await (prepareRestoreAttempt ?? (command => dataProvider.prepareCloudRestoreAttempt(command)))({
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        candidate: activeCandidate,
        confirmation: CONFIRMATION_TEXT,
      });
      setLastAttempt({
        ...pending,
        ...(durableAttempt.executionId ? { executionId: durableAttempt.executionId } : {}),
        expectedEpoch: durableAttempt.expectedEpoch,
      });
      if (durableAttempt.status === 'completed' && durableAttempt.restoreResult) {
        await completeRestore(durableAttempt.restoreResult, pending);
        return;
      }
      if ((durableAttempt.status !== 'prepared' && durableAttempt.status !== 'executing') || !durableAttempt.reconcileAfter) {
        throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_RESULT_INVALID' }, 'server-response');
      }
      const executionId = durableAttempt.executionId ?? crypto.randomUUID();
      setLastAttempt(previous => previous ? { ...previous, executionId } : previous);
      setProgressStep('restore');
      recordCloudRestoreSubmitDiagnostic({
        event: 'rpc-invocation', phase: 'rpc',
        attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
        readStatus: readiness.connectivity.readStatus,
      });
      restoreDispatched = true;
      window.dispatchEvent(new CustomEvent('cloud-restore-authoritative-pending', { detail: { attemptId: pending.idempotencyKey } }));
      const restored = await (executeRestore ?? (command => dataProvider.restoreCloudSnapshot(command)))({
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        candidate: activeCandidate,
        proofId: activeProof.proofId,
        confirmation: CONFIRMATION_TEXT,
        attempt: {
          status: durableAttempt.status,
          attemptId: durableAttempt.attemptId,
          traceId: durableAttempt.traceId,
          executionId,
          expectedEpoch: durableAttempt.expectedEpoch,
          effectiveFingerprint: durableAttempt.effectiveFingerprint,
          reconcileAfter: durableAttempt.reconcileAfter,
        },
      });
      await completeRestore(restored, pending);
    } catch (error) {
      const safe = normalizeCloudRestoreSubmitError(error, restoreDispatched ? 'rpc' : 'readiness', {
        source: restoreDispatched ? 'post-dispatch' : 'pre-dispatch', attemptCorrelationId: pending.correlationId,
      });
      const durableFailure = isCloudRestoreFailureCode(safe.code);
      const requiresOutcomeCheck = !durableFailure && attemptPrepareStarted && (safe.outcome === 'unknown' || restoreDispatched);
      if (durableFailure && attemptPrepareStarted) {
        try {
          const evidence = await (checkRestoreOutcome ?? (command => dataProvider.reconcileCloudRestoreAttempt(command)))({
            attemptId: durableAttempt?.attemptId ?? pending.idempotencyKey,
            traceId: durableAttempt?.traceId ?? pending.correlationId,
          });
          if (evidence.status === 'not_committed') {
            setFailureEvidence(evidence.failure ?? null);
            window.dispatchEvent(new CustomEvent('cloud-restore-not-committed', { detail: { attemptId: pending.idempotencyKey } }));
          }
        } catch {
          // The approved safe code remains authoritative; no raw failure is rendered.
        }
      }
      if (requiresOutcomeCheck) {
        const unresolved = {
          attemptId: durableAttempt?.attemptId ?? pending.idempotencyKey,
          traceId: durableAttempt?.traceId ?? pending.correlationId,
        };
        setUnresolvedAttempt(unresolved);
        persistCloudRestoreUnresolvedAttempt(unresolved);
        setReconcileAfter(durableAttempt?.reconcileAfter ?? null);
      } else if (attemptPrepareStarted) {
        setUnresolvedAttempt(null);
        clearCloudRestoreUnresolvedAttempt();
        void clearCloudDeadlineRestoreStage(pending.idempotencyKey).catch(() => {});
      } else {
        void clearCloudDeadlineRestoreStage(pending.idempotencyKey).catch(() => {});
      }
      setVisibleError(safe);
      submissionLockedRef.current = requiresOutcomeCheck || durableFailure;
      if (durableFailure) {
        retireCloudRestoreIntentIdentity({ attemptId: pending.idempotencyKey, traceId: pending.correlationId }, retryKeys.current);
        setAttemptClosed(true);
      }
      setStatus(requiresOutcomeCheck ? 'unknown' : 'error');
      setMessage(requiresOutcomeCheck
        ? '還原結果需要查證，資料不會自動再次還原。'
        : formatCloudRestoreSubmitError(safe));
      recordCloudRestoreSubmitDiagnostic({
        event: 'submit-finish', phase: 'submit', outcome: safe.outcome,
        attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey, error: safe,
      });
    } finally {
      inFlightRef.current = false;
      pendingAttemptRef.current = null;
    }
  };

  const confirmRestore = () => {
    if (!candidate || !allowed || !proofCurrent || inFlightRef.current || pendingAttemptRef.current || submissionLockedRef.current) return;
    const identity = readOrCreateCloudRestoreIntentIdentity(candidate.executionFingerprint, retryKeys.current,
      { newIntent: freshIntentRef.current });
    freshIntentRef.current = false;
    const pending: PendingRestoreAttempt = {
      correlationId: identity.traceId,
      idempotencyKey: identity.attemptId,
      fingerprint: candidate.executionFingerprint,
    };
    pendingAttemptRef.current = pending;
    submissionLockedRef.current = true;
    inFlightRef.current = true;
    setLastAttempt(pending);
    setVisibleError(null);
    setFailureEvidence(null);
    recordCloudRestoreSubmitDiagnostic({
      event: 'submit-start', phase: 'confirmation',
      attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
      readStatus: getCloudConnectivitySnapshot().readStatus,
    });
    void execute(pending);
  };

  const mainStatus = (() => {
    if (status === 'preflighting') return '正在檢查備份安全性…';
    if (status === 'restoring' || status === 'checking') return '正在安全還原資料…';
    if (status === 'success') return '還原完成';
    if (status === 'unknown') return '還原結果需要查證，資料不會自動再次還原。';
    if (status === 'error' && result) return verificationError?.message ?? message;
    if (status === 'error' && visibleError) return formatCloudRestoreSubmitError(visibleError);
    if (status === 'error' && failureEvidence) return '還原失敗\n資料沒有被部分寫入。';
    if (status === 'error') return '此備份目前無法安全還原。';
    return message;
  })();
  const traceId = lastAttempt?.correlationId ?? visibleError?.attemptCorrelationId;
  const activeProgressIndex = progressIndex(progressStep);

  return (
    <section data-testid="cloud-atomic-restore" style={{ padding: 18, border: '1px solid var(--color-border)', borderRadius: 10, background: 'var(--color-surface, #fff)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <RotateCcw color="#2563eb" size={20} />
        <div>
          <div className="font-medium">雲端資料還原</div>
          <div className="text-xs text-muted">從 JSON 備份恢復 ERP 資料。系統會在還原前自動完成安全檢查。</div>
        </div>
      </div>

      {!recoveryReady && cloudMode && owner && user && (
        <p data-testid="cloud-restore-recovery-gate" role={recovery.error ? 'alert' : 'status'}>
          {recovery.error ? '目前無法確認既有還原狀態，新還原已暫停。' : '正在確認還原狀態…'}
          {recovery.error && <button type="button" className="btn btn-outline" onClick={refreshRecovery}>重新確認</button>}
        </p>
      )}

      <div data-testid="cloud-restore-workflow-slot" style={{ overflowWrap: 'anywhere' }}>
      {status === 'idle' && !unresolvedAttempt && (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn btn-primary" data-testid="cloud-restore-file-button" disabled={!canChooseFile} onClick={() => fileRef.current?.click()}>
            <FileCheck2 size={16} /> 選擇備份並還原
          </button>
        </div>
      )}
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => void selectFile(event.target.files?.[0])} />

      {status === 'preflighting' && (
        <div data-testid="cloud-restore-preflight-progress" role="status" style={{ marginTop: 14 }}>
          <strong>正在準備備份</strong>
          <p style={{ margin: '6px 0' }}>系統正在自動完成安全檢查，尚未修改雲端資料。</p>
        </div>
      )}

      {status === 'ready' && candidate && proofCurrent && (
        <div role="dialog" aria-modal="false" aria-labelledby="cloud-restore-ready-title" data-testid="cloud-restore-preflight" style={{ marginTop: 14, padding: 14, border: '1px solid #86efac', borderRadius: 8, background: '#f0fdf4' }}>
          <div id="cloud-restore-ready-title" className="font-medium">準備還原</div>
          <p style={{ margin: '8px 0 4px' }}>備份資料：{candidate.manifest.totalRows.toLocaleString()} 筆</p>
          <p style={{ margin: '4px 0' }}>資料類別：{candidate.manifest.resourceCount} 個</p>
          {candidate.legacyWacaBackup && <p style={{ margin: '4px 0' }}>
            此備份建立於 WACA 訂單系統啟用前。還原後會保留當時的 WACA 數量，
            並標記需要匯入完整 WACA 歷史訂單；匯入後會由訂單重新計算並取代舊數量。
            舊備份也不含首頁圖片與期限對照，因此會保留目前的首頁圖片和期限對照，不會當成空資料清除。
          </p>}
          <p style={{ margin: '4px 0' }}>安全檢查：已通過</p>
          {candidate.portability && <p data-testid="cloud-restore-portability-summary" style={{ margin: '4px 0' }}>系統已自動處理跨環境欄位。</p>}
          <p style={{ margin: '10px 0' }}>目前測試環境的資料將由這份備份取代。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button type="button" className="btn btn-primary" data-testid="cloud-restore-confirm" onClick={confirmRestore}>確認還原</button>
            <button type="button" className="btn btn-outline" data-testid="cloud-restore-cancel" onClick={cancelPreparedRestore}>取消</button>
          </div>
        </div>
      )}
      {status === 'ready' && candidate && !proofCurrent && (
        <p role="alert">安全檢查已失效，請重新選擇備份。</p>
      )}

      {(status === 'restoring' || status === 'checking' || status === 'success' || (status === 'error' && Boolean(result))) && (
        <div data-testid="cloud-restore-progress" style={{ marginTop: 14 }}>
          <strong>{status === 'success' ? '還原完成' : '正在安全還原資料…'}</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, marginTop: 10 }}>
            {progressLabels.map(([step, label], index) => {
              const done = status === 'success' || index < activeProgressIndex;
              const current = index === activeProgressIndex && status !== 'success';
              return <div key={step} style={{ padding: '7px 4px', borderRadius: 6, textAlign: 'center', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', background: done ? '#dcfce7' : current ? '#dbeafe' : '#f1f5f9', color: '#334155' }}>
                {done && <CheckCircle2 size={14} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 3 }} />}
                {label}
              </div>;
            })}
          </div>
        </div>
      )}

      {mainStatus && status !== 'ready' && (
        <p data-testid="cloud-restore-status" role={status === 'error' || status === 'unknown' ? 'alert' : 'status'} style={{ whiteSpace: 'pre-line', marginBottom: 0 }}>
          {mainStatus}
          {traceId && (status === 'error' || status === 'unknown') && <><br />追蹤編號：<code>{traceId}</code></>}
        </p>
      )}

      {status === 'success' && result && (
        <div data-testid="cloud-restore-result" style={{ marginTop: 8 }}>
          <strong>{result.manifest.totalRows.toLocaleString()} 筆資料已恢復。</strong>
          <div>{screenRefreshPending ? '畫面正在同步最新資料，請勿再次還原。' : '畫面已更新為最新資料。'}</div>
        </div>
      )}

      {(attemptClosed || status === 'success' || status === 'error' || (status === 'ready' && !proofCurrent)) && !unresolvedAttempt && (
        <button type="button" className="btn btn-outline" data-testid="cloud-restore-new-intent" disabled={!canChooseFile} onClick={startNewIntent} style={{ marginTop: 12 }}>選擇其他備份</button>
      )}
      {unresolvedAttempt && <button type="button" className="btn btn-outline" data-testid="cloud-restore-reverify"
        disabled={status === 'checking' || status === 'restoring'} onClick={() => void checkOutcome()}
        style={{ marginTop: 12 }}>重新驗證結果（不會重新還原）</button>}
      {!unresolvedAttempt && latestCompletedAttempt && status === 'idle' && <button type="button"
        className="btn btn-outline" data-testid="cloud-restore-reverify-latest" disabled={!recoveryReady || !browserOnline}
        onClick={() => {
          activeVerificationRef.current = latestCompletedAttempt.attemptId;
          setUnresolvedAttempt(latestCompletedAttempt);
          persistCloudRestoreUnresolvedAttempt(latestCompletedAttempt);
          setStatus('unknown');
          setMessage('正在查證最近一次已提交還原；不會再次執行。');
        }} style={{ marginTop: 12 }}>重新驗證最近一次還原結果</button>}
      </div>

      <details data-testid="cloud-restore-technical-details" style={{ marginTop: 14 }}>
        <summary>查看技術資訊</summary>
        <div style={{ marginTop: 8, overflowWrap: 'anywhere', fontSize: 12 }}>
          <div>安全檢查：{proofMessage}</div>
          {prepareTimings && <div data-testid="cloud-restore-prepare-timings">
            Prepare timings (ms)：{Object.entries(prepareTimings).map(([phase, ms]) => `${phase}=${ms}`).join('；')}
          </div>}
          {proofRecord?.result.prepareCallTimings && <pre data-testid="cloud-restore-prepare-waterfall" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify({ requestId: proofRecord.result.requestId, calls: proofRecord.result.prepareCallTimings })}
          </pre>}
          {sourceCandidate && <div>來源 fingerprint：<code>{sourceCandidate.manifest.snapshotFingerprint}</code></div>}
          {candidate && <div>有效 fingerprint：<code>{candidate.executionFingerprint}</code></div>}
          {candidate?.portability && <div>跨環境轉換：{candidate.portability.totalTransformedRows}；policy：{candidate.portability.policyVersion}</div>}
          {lastAttempt && <>
            <div>trace：<code>{lastAttempt.correlationId}</code></div>
            <div>attempt：<code>{lastAttempt.idempotencyKey}</code></div>
            {lastAttempt.executionId && <div>execution：<code>{lastAttempt.executionId}</code></div>}
            {lastAttempt.expectedEpoch !== undefined && <div>epoch before：{lastAttempt.expectedEpoch}</div>}
          </>}
          {visibleError && <>
            <div>phase：{visibleError.phase}</div>
            <div>category：{visibleError.classification}</div>
            <div>safe code：{visibleError.code}</div>
            {visibleError.resource && <div>resource：<code>{visibleError.resource}</code></div>}
            {visibleError.rowIdentity && <div>row：<code>{visibleError.rowIdentity}</code></div>}
            {visibleError.reasonCode && <div>reason：<code>{visibleError.reasonCode}</code></div>}
            {visibleError.sqlstate && <div>SQLSTATE：<code>{visibleError.sqlstate}</code></div>}
            {visibleError.requestId && <div>request：<code>{visibleError.requestId}</code></div>}
          </>}
          {failureEvidence && <>
            <div>durable phase：{failureEvidence.phase}</div>
            <div>durable category：{failureEvidence.category}</div>
            <div>SQLSTATE：{failureEvidence.sqlstate ?? 'none'}</div>
            <div>timeout：{failureEvidence.timeoutClassification}</div>
          </>}
          {result && <>
            <div>epoch after：{result.restoreEpoch}</div>
            <div>來源復原證據：<code>{result.rollbackSnapshotId}</code></div>
            <div>canonical result：PASS</div>
          </>}
          {verificationSummary && <>
            <div>post-commit verification：{verificationSummary.status}</div>
            <div>audit epoch：{verificationSummary.restoreEpoch}</div>
            <div>business generation：{verificationSummary.businessGeneration}</div>
            <div>generation certified：{String(verificationSummary.generationCertified)}</div>
            <div>verification rows：{verificationSummary.totalRows}</div>
            <div>verification server ms：{verificationSummary.elapsedMs}</div>
          </>}
          {verificationError && <>
            <div>phase：{verificationError.phase}</div>
            <div>category：{verificationError.code}</div>
            <div>RPC：{verificationError.rpc}</div>
            {verificationError.sqlstate && <div>SQLSTATE：{verificationError.sqlstate}</div>}
            {verificationError.httpStatus !== undefined && <div>HTTP：{verificationError.httpStatus}</div>}
          </>}
          {recoveredAttempt && <div>Recovered status：{recoveredAttempt.status}</div>}
          {unresolvedAttempt && <button type="button" className="btn btn-outline" data-testid="cloud-restore-check-outcome" disabled={status === 'checking'} onClick={() => void checkOutcome()}>再次查證結果（不會重新還原）</button>}
        </div>
      </details>

      {cloudMode && owner && user && (
        <details data-testid="cloud-restore-advanced-tools" style={{ marginTop: 10 }}>
          <summary>進階／技術工具</summary>
          <CloudRestoreIntegrityAuditTool key={user.id} />
        </details>
      )}

      {!cloudMode && <p role="alert">此功能僅能在雲端環境使用。</p>}
      {cloudMode && !user && <p role="alert">請先登入。</p>}
      {cloudMode && user && !owner && <p role="alert">只有 OWNER 可以還原資料。</p>}
      {cloudMode && owner && user && !online && <p role="alert">目前離線，無法還原資料。</p>}
      {status === 'error' && failureEvidence && <AlertTriangle aria-hidden="true" size={16} color="#b91c1c" />}
    </section>
  );
}
