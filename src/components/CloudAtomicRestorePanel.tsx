import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { isCloudRestoreFailureCode } from '../providers/cloud/cloudRestoreFailure';
import { CloudRestoreReconcileSchedule } from '../providers/cloud/cloudRestoreReconcileSchedule';
import CloudRestoreIntegrityAudit from './CloudRestoreIntegrityAudit';
import type { CloudRestoreRecoveryAttempt } from '../providers/cloud/cloudRestoreRecovery';
import { AlertTriangle, FileCheck2, RotateCcw } from 'lucide-react';
import { useAuth } from '../auth/authContext';
import { useRole } from '../auth/useRole';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';
import {
  getCloudConnectivitySnapshot,
  subscribeCloudConnectivity,
} from '../providers/cloud/cloudConnectivity';
import { useCloudResourceSync } from '../contexts/CloudRealtimeSyncContext';
import type { CloudResource } from '../providers/cloud/cloudSyncDomain';
import {
  CLOUD_RESTORE_TABLES,
  prepareCloudRestoreSnapshot,
  sha256BytesHex,
  type CloudRestoreAttemptCommand,
  type CloudRestoreAttemptOutcome,
  type CloudRestoreCandidate,
  type CloudRestoreExecutionCommand,
  type CloudRestoreResult,
} from '../providers/cloud/cloudAtomicRestore';
import {
  CLOUD_RESTORE_PORTABILITY_POLICY_VERSION,
  assertCloudRestoreEffectiveCandidate,
  prepareCrossEnvironmentCloudRestoreCandidate,
  type CloudRestoreTargetCompatibilityResult,
} from '../providers/cloud/cloudRestorePortability';
import { supabaseEnvironment } from '../providers/cloud/supabaseClient';
import {
  bindCloudRestoreCandidateProof,
  isCloudRestoreCandidateProofCurrent,
  type CloudRestoreCandidateProofRecord,
  type CloudRestoreCandidateProofResult,
} from '../providers/cloud/cloudRestoreCandidateProof';
import {
  CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE,
  clearCloudRestoreUnresolvedAttempt,
  createCloudRestoreSafeSubmitError,
  formatCloudRestoreSubmitError,
  inspectCurrentCloudRestoreReadiness,
  normalizeCloudRestoreSubmitError,
  persistCloudRestoreUnresolvedAttempt,
  readCloudRestoreUnresolvedAttempt,
  readOrCreateCloudRestoreIntentIdentity,
  recordCloudRestoreSubmitDiagnostic,
  retireCloudRestoreIntentIdentity,
  type CloudRestoreIntentIdentity,
} from '../providers/cloud/cloudRestoreSubmit';

const CONFIRMATION_TEXT = 'OVERWRITE CLOUD DATA';
const CLOUD_RESTORE_READINESS_RESOURCES: CloudResource[] = [
  'products',
  'purchases',
  'privateOrders',
  'inventory',
  'bundles',
  'japanPackages',
  'outboundShipments',
  'salesOrders',
];
const ignoreCloudResourceRefresh = () => {};

interface CloudAtomicRestorePanelProps {
  proveRestoreCandidate?: (candidate: CloudRestoreCandidate) => Promise<CloudRestoreCandidateProofResult>;
  prepareRestoreAttempt?: (command: Parameters<typeof dataProvider.prepareCloudRestoreAttempt>[0]) => ReturnType<typeof dataProvider.prepareCloudRestoreAttempt>;
  checkRestoreOutcome?: (command: CloudRestoreAttemptCommand) => Promise<CloudRestoreAttemptOutcome>;
  executeRestore?: (command: CloudRestoreExecutionCommand) => Promise<CloudRestoreResult>;
  validateRestoreTarget?: (command: Parameters<typeof dataProvider.validateCloudRestoreTarget>[0]) => Promise<CloudRestoreTargetCompatibilityResult>;
  onAuthoritativeRefreshComplete?: (restoreEpoch: number) => void | Promise<void>;
}

interface PendingRestoreAttempt {
  correlationId: string;
  idempotencyKey: string;
  fingerprint: string;
}

type RestorePortabilityMode = 'strict' | 'cross-environment';

export default function CloudAtomicRestorePanel({
  proveRestoreCandidate,
  prepareRestoreAttempt,
  checkRestoreOutcome,
  executeRestore,
  validateRestoreTarget,
  onAuthoritativeRefreshComplete,
}: CloudAtomicRestorePanelProps = {}) {
  const { user } = useAuth();
  const { role } = useRole();
  const fileRef = useRef<HTMLInputElement>(null);
  const retryKeys = useRef(new Map<string, CloudRestoreIntentIdentity>());
  const pendingAttemptRef = useRef<PendingRestoreAttempt | null>(null);
  const inFlightRef = useRef(false);
  const proofInFlightRef = useRef(false);
  const proofRequestTokenRef = useRef(0);
  const proofRecordRef = useRef<CloudRestoreCandidateProofRecord | null>(null);
  const proofUserIdRef = useRef(user?.id ?? '');
  const [unresolvedAttempt, setUnresolvedAttempt] = useState<CloudRestoreAttemptCommand | null>(
    readCloudRestoreUnresolvedAttempt,
  );
  const submissionLockedRef = useRef(Boolean(unresolvedAttempt));
  const candidateGenerationRef = useRef(0);
  const [candidateGeneration, setCandidateGeneration] = useState(0);
  const [sourceCandidate, setSourceCandidate] = useState<CloudRestoreCandidate | null>(null);
  const [candidate, setCandidate] = useState<CloudRestoreCandidate | null>(null);
  const [proofRecord, setProofRecord] = useState<CloudRestoreCandidateProofRecord | null>(null);
  const [proofStatus, setProofStatus] = useState<'idle' | 'loading' | 'pass' | 'error'>('idle');
  const [proofMessage, setProofMessage] = useState('尚未完成伺服器候選驗證');
  const [portabilityMode, setPortabilityMode] = useState<RestorePortabilityMode>('strict');
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<'idle' | 'preflighting' | 'ready' | 'confirming' | 'restoring' | 'checking' | 'success' | 'error' | 'unknown'>(
    unresolvedAttempt ? 'unknown' : 'idle',
  );
  const [message, setMessage] = useState(unresolvedAttempt
    ? '伺服器執行結果仍待確認；請勿重複送出，可再次查證結果。'
    : '');
  const [result, setResult] = useState<CloudRestoreResult | null>(null);
  const [attemptClosed, setAttemptClosed] = useState(false);
  const [reconcileAfter, setReconcileAfter] = useState<string | null>(null);
  const reconcileSchedule = useRef(new CloudRestoreReconcileSchedule());
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [recovery, setRecovery] = useState<{ userId: string; ready: boolean; error: boolean }>({ userId: '', ready: false, error: false });
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [recoveredAttempt, setRecoveredAttempt] = useState<CloudRestoreRecoveryAttempt | null>(null);
  const cloudMode = getProviderMode() === 'cloud';
  const owner = role === 'owner';
  const connectivity = useSyncExternalStore(
    subscribeCloudConnectivity,
    getCloudConnectivitySnapshot,
    getCloudConnectivitySnapshot,
  );
  const browserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
  const online = browserOnline && connectivity.status === 'online';
  const fresh = connectivity.readStatus === 'fresh-online' || connectivity.readStatus === 'fresh-empty';
  const recoveryReady = recovery.ready && recovery.userId === user?.id;
  const canPreflight = cloudMode && Boolean(user) && owner && online && recoveryReady;
  const allowed = canPreflight && fresh;
  const proofCurrent = isCloudRestoreCandidateProofCurrent(proofRecord, candidate, {
    candidateGeneration,
    userId: user?.id ?? '',
    targetProjectRef: supabaseEnvironment.projectRef,
  });

  const invalidateProof = useCallback((message = '尚未完成伺服器候選驗證') => {
    proofRequestTokenRef.current += 1;
    proofInFlightRef.current = false;
    proofRecordRef.current = null;
    setProofRecord(null);
    setProofStatus('idle');
    setProofMessage(message);
  }, [setProofMessage, setProofRecord, setProofStatus]);

  useEffect(() => {
    const currentUserId = user?.id ?? '';
    if (proofUserIdRef.current === currentUserId) return;
    proofUserIdRef.current = currentUserId;
    invalidateProof('登入身分已變更，請重新進行伺服器候選驗證。');
  }, [invalidateProof, user?.id]);
  useCloudResourceSync(
    'cloud-restore-authoritative-readiness',
    CLOUD_RESTORE_READINESS_RESOURCES,
    false,
    ignoreCloudResourceRefresh,
  );

  useEffect(() => {
    if (!cloudMode || !owner || !user?.id || !online) return;
    let active = true;
    const userId = user.id;
    // A failed lookup is not proof of absence. New intents stay blocked.
    void dataProvider.getPendingCloudRestoreAttempts().then(attempts => {
      if (!active) return;
      const pending = attempts[0];
      if (pending) {
        candidateGenerationRef.current += 1;
        setCandidateGeneration(candidateGenerationRef.current);
        invalidateProof('已有未決還原，伺服器候選驗證已失效。');
        pendingAttemptRef.current = null;
        setConfirmationOpen(false);
        setRecoveredAttempt(pending);
        setUnresolvedAttempt(pending);
        persistCloudRestoreUnresolvedAttempt(pending);
        submissionLockedRef.current = true;
        setStatus('unknown');
        setMessage('找到屬於目前帳號的未決還原；請先查證伺服器結果，勿重複送出。');
      }
      setRecovery({ userId, ready: true, error: false });
    }).catch(() => {
      if (active) setRecovery({ userId, ready: false, error: true });
    });
    return () => { active = false; };
  }, [cloudMode, owner, user?.id, online, recoveryVersion, invalidateProof]);

  const refreshRecovery = () => {
    setRecovery({ userId: '', ready: false, error: false });
    setRecoveryVersion(version => version + 1);
  };

  const startNewIntent = () => {
    if (unresolvedAttempt || inFlightRef.current || !recoveryReady) return;
    // Explicit user action; no identity, PREPARE or EXECUTE is created here.
    candidateGenerationRef.current += 1;
    setCandidateGeneration(candidateGenerationRef.current);
    invalidateProof();
    setCandidate(null);
    setSourceCandidate(null);
    setConfirmation('');
    setConfirmationOpen(false);
    setRecoveredAttempt(null);
    setAttemptClosed(false);
    submissionLockedRef.current = false;
    pendingAttemptRef.current = null;
    setStatus('idle');
    setMessage('請重新選擇備份並確認新的還原意圖。前次結果保留供查證。');
    refreshRecovery();
  };

  const selectFile = async (file: File | undefined) => {
    if (!file || unresolvedAttempt || !canPreflight) return;
    const generation = candidateGenerationRef.current + 1;
    candidateGenerationRef.current = generation;
    setCandidateGeneration(generation);
    invalidateProof();
    setStatus('preflighting');
    setMessage('正在本機解析並檢查 JSON；尚未寫入雲端。');
    setCandidate(null);
    setSourceCandidate(null);
    setPortabilityMode('strict');
    setResult(null);
    setUnresolvedAttempt(null);
    setAttemptClosed(false);
    submissionLockedRef.current = false;
    pendingAttemptRef.current = null;
    setConfirmationOpen(false);
    try {
      const rawBytes = await file.arrayBuffer();
      const sourceFileSha256 = await sha256BytesHex(rawBytes);
      const prepared = await prepareCloudRestoreSnapshot(new TextDecoder().decode(rawBytes), {
        fileName: file.name,
        sourceEnvironment: window.location.origin,
        sourceFileSha256,
      });
      if (candidateGenerationRef.current !== generation) return;
      setSourceCandidate(prepared);
      setCandidate(prepared);
      setStatus('ready');
      setMessage('Preflight 通過。請核對 15 個資源與 fingerprint，再完成第二次明確確認。');
    } catch (error) {
      if (candidateGenerationRef.current !== generation) return;
      setStatus('error');
      setMessage(formatCloudRestoreSubmitError(normalizeCloudRestoreSubmitError(error, 'submit', {
        source: 'local',
      })));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const selectPortabilityMode = async (mode: RestorePortabilityMode) => {
    if (!sourceCandidate || attemptClosed || unresolvedAttempt || status === 'restoring' || status === 'unknown') return;
    const generation = candidateGenerationRef.current + 1;
    candidateGenerationRef.current = generation;
    setCandidateGeneration(generation);
    invalidateProof('Restore 模式已變更，請重新進行伺服器候選驗證。');
    setPortabilityMode(mode);
    setCandidate(null);
    setResult(null);
    setUnresolvedAttempt(null);
    setAttemptClosed(false);
    setConfirmation('');
    setConfirmationOpen(false);
    pendingAttemptRef.current = null;
    submissionLockedRef.current = false;
    setStatus('preflighting');
    setMessage(mode === 'strict'
      ? '正在恢復嚴格 Restore candidate。'
      : '正在建立獨立的跨環境 candidate；原始 JSON 不會被修改。');
    try {
      const prepared = mode === 'strict'
        ? sourceCandidate
        : await prepareCrossEnvironmentCloudRestoreCandidate(sourceCandidate, supabaseEnvironment.projectRef);
      if (candidateGenerationRef.current !== generation) return;
      setCandidate(prepared);
      setStatus('ready');
      setMessage(mode === 'strict'
        ? '嚴格模式：不轉換任何欄位。'
        : '跨環境 candidate 已建立；Server 會在任何 business DELETE 前重驗目標 schema／外部參照。');
    } catch (error) {
      if (candidateGenerationRef.current !== generation) return;
      setStatus('error');
      setMessage(formatCloudRestoreSubmitError(normalizeCloudRestoreSubmitError(error, 'submit', { source: 'local' })));
    }
  };

  const proveCandidate = async () => {
    if (!candidate || !allowed || proofInFlightRef.current || unresolvedAttempt || attemptClosed) return;
    const requestToken = proofRequestTokenRef.current + 1;
    proofRequestTokenRef.current = requestToken;
    proofInFlightRef.current = true;
    proofRecordRef.current = null;
    setProofRecord(null);
    setProofStatus('loading');
    setProofMessage('伺服器驗證中…');
    const candidateGeneration = candidateGenerationRef.current;
    const userId = user?.id ?? '';
    const targetProjectRef = supabaseEnvironment.projectRef;
    try {
      const proof = await (proveRestoreCandidate ?? (value => dataProvider.proveCloudRestoreCandidate(value)))(candidate);
      if (proofRequestTokenRef.current !== requestToken
        || candidateGenerationRef.current !== candidateGeneration
        || proofUserIdRef.current !== userId) return;
      const record = bindCloudRestoreCandidateProof(candidate, proof, {
        candidateGeneration,
        userId,
        targetProjectRef,
      });
      proofRecordRef.current = record;
      setProofRecord(record);
      setProofStatus('pass');
      setProofMessage('伺服器驗證通過，可進行原子還原');
    } catch (error) {
      if (proofRequestTokenRef.current !== requestToken
        || candidateGenerationRef.current !== candidateGeneration
        || proofUserIdRef.current !== userId) return;
      const visible = normalizeCloudRestoreSubmitError(error, 'readiness', { source: 'pre-dispatch' });
      proofRecordRef.current = null;
      setProofRecord(null);
      setProofStatus('error');
      setProofMessage(`伺服器驗證失敗，已阻止還原（${visible.code}）`);
    } finally {
      if (proofRequestTokenRef.current === requestToken) proofInFlightRef.current = false;
    }
  };

  const beginConfirmation = () => {
    if (!candidate || !allowed || confirmation !== CONFIRMATION_TEXT) return;
    if (inFlightRef.current || pendingAttemptRef.current || submissionLockedRef.current) return;
    if (!isCloudRestoreCandidateProofCurrent(proofRecordRef.current, candidate, {
      candidateGeneration: candidateGenerationRef.current,
      userId: proofUserIdRef.current,
      targetProjectRef: supabaseEnvironment.projectRef,
    })) {
      setProofStatus('error');
      setProofMessage('伺服器候選驗證尚未完成或已失效，已阻止還原。');
      return;
    }
    const fingerprint = candidate.executionFingerprint;
    const identity = readOrCreateCloudRestoreIntentIdentity(fingerprint, retryKeys.current);
    const pending = {
      correlationId: identity.traceId,
      idempotencyKey: identity.attemptId,
      fingerprint,
    };
    pendingAttemptRef.current = pending;
    recordCloudRestoreSubmitDiagnostic({
      event: 'submit-start',
      phase: 'confirmation',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
      readStatus: getCloudConnectivitySnapshot().readStatus,
    });
    setStatus('confirming');
    setMessage('請在最終確認對話框再次核對目前雲端狀態。');
    setConfirmationOpen(true);
  };

  const cancelConfirmation = () => {
    const pending = pendingAttemptRef.current;
    if (!pending || inFlightRef.current) return;
    recordCloudRestoreSubmitDiagnostic({
      event: 'confirmation-complete',
      phase: 'confirmation',
      outcome: 'cancelled',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
      readStatus: getCloudConnectivitySnapshot().readStatus,
    });
    recordCloudRestoreSubmitDiagnostic({
      event: 'submit-finish',
      phase: 'submit',
      outcome: 'cancelled',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
    });
    pendingAttemptRef.current = null;
    setConfirmationOpen(false);
    setStatus('ready');
    setMessage('已取消；本次尚未送出。');
  };

  const completeRestore = async (restored: CloudRestoreResult, pending: PendingRestoreAttempt) => {
    let displayedResult = restored;
    let syncPending = restored.authoritativeRefresh?.status === 'pending';
    if (!syncPending && onAuthoritativeRefreshComplete) {
      try {
        await onAuthoritativeRefreshComplete(restored.restoreEpoch);
      } catch {
        syncPending = true;
        displayedResult = {
          ...restored,
          authoritativeRefresh: {
            status: 'pending',
            errorCode: 'UI_CONVERGENCE_PENDING',
            errorMessage: 'Authoritative cache is current, but this view has not converged yet.',
          },
        };
        recordCloudRestoreSubmitDiagnostic({
          event: 'authoritative-refresh', phase: 'authoritative-refresh', outcome: 'sync-pending',
          attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
        });
      }
    }
    setResult(displayedResult);
    setRecoveredAttempt(null);
    setUnresolvedAttempt(null);
    clearCloudRestoreUnresolvedAttempt();
    refreshRecovery();
    setStatus('success');
    submissionLockedRef.current = true;
    setMessage(syncPending
      ? `還原已完成，畫面同步待完成；請勿再次還原。Rollback snapshot：${restored.rollbackSnapshotId}`
      : `Cloud Restore 完成；authoritative refresh 已完成。Rollback snapshot：${restored.rollbackSnapshotId}`);
    if (!syncPending) {
      window.dispatchEvent(new CustomEvent('cloud-restore-completed', { detail: { restoreEpoch: restored.restoreEpoch } }));
    }
    recordCloudRestoreSubmitDiagnostic({
      event: 'submit-finish', phase: 'submit', outcome: syncPending ? 'sync-pending' : 'success',
      attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
    });
  };

  const checkOutcome = async () => {
    if (!unresolvedAttempt || inFlightRef.current || !cloudMode || !user || !owner || !online || !recoveryReady) return;
    inFlightRef.current = true;
    setStatus('checking');
    setMessage(previous => previous.includes('追蹤：') ? previous : '正在查證伺服器結果；不會重新執行 Restore。');
    try {
      const outcome = await (checkRestoreOutcome ?? (command => dataProvider.reconcileCloudRestoreAttempt(command)))(unresolvedAttempt);
      if (outcome.status === 'completed' && outcome.restoreResult) {
        await completeRestore(outcome.restoreResult, {
          correlationId: unresolvedAttempt.traceId,
          idempotencyKey: unresolvedAttempt.attemptId,
          fingerprint: outcome.effectiveFingerprint,
        });
      } else if (outcome.status === 'not_committed') {
        setUnresolvedAttempt(null);
        setRecoveredAttempt(null);
        clearCloudRestoreUnresolvedAttempt();
        retireCloudRestoreIntentIdentity(unresolvedAttempt, retryKeys.current);
        setAttemptClosed(true);
        setStatus('error');
        submissionLockedRef.current = true;
        const detail = outcome.failure ? formatCloudRestoreSubmitError(normalizeCloudRestoreSubmitError(
          createCloudRestoreSafeSubmitError({ code: outcome.failure.code }, 'server-response'), 'rpc',
          { source: 'server-response', attemptCorrelationId: unresolvedAttempt.traceId },
        )) : '伺服器已確認本次未提交。';
        setMessage(previous => `${!outcome.failure && previous.includes('追蹤：') ? `${previous} ` : ''}${detail} 如需再次還原，必須重新取得人工授權。`);
        refreshRecovery();
      } else {
        setReconcileAfter(outcome.reconcileAfter ?? null);
        setStatus('unknown');
        submissionLockedRef.current = true;
        setMessage(previous => previous.includes('追蹤：') ? previous
          : '伺服器執行結果仍待確認；請勿重複送出，可稍後再次查證結果。');
      }
    } catch (error) {
      const visible = normalizeCloudRestoreSubmitError(error, 'rpc', {
        source: 'post-dispatch', attemptCorrelationId: unresolvedAttempt.traceId,
      });
      setStatus('unknown');
      submissionLockedRef.current = true;
      setMessage(formatCloudRestoreSubmitError(visible));
    } finally {
      inFlightRef.current = false;
    }
  };

  const runScheduledReconcile = useEffectEvent(() => {
    if (inFlightRef.current || !unresolvedAttempt) return;
    reconcileSchedule.current.mark(unresolvedAttempt.traceId);
    void checkOutcome();
  });
  useEffect(() => {
    if (!unresolvedAttempt || !cloudMode || !owner || !user?.id || !online || !recoveryReady
      || status === 'restoring' || status === 'checking') return;
    const delay = reconcileSchedule.current.delay(unresolvedAttempt.traceId, reconcileAfter, Date.now());
    if (delay === null) return;
    const timer = window.setTimeout(runScheduledReconcile, delay);
    return () => window.clearTimeout(timer);
  }, [unresolvedAttempt, cloudMode, owner, user?.id, online, recoveryReady, status, reconcileAfter]);

  const execute = async () => {
    const pending = pendingAttemptRef.current;
    if (!candidate || !pending || inFlightRef.current || submissionLockedRef.current) return;
    if (pending.fingerprint !== candidate.executionFingerprint || confirmation !== CONFIRMATION_TEXT) return;
    const hasCurrentProof = () => isCloudRestoreCandidateProofCurrent(proofRecordRef.current, candidate, {
      candidateGeneration: candidateGenerationRef.current,
      userId: proofUserIdRef.current,
      targetProjectRef: supabaseEnvironment.projectRef,
    });
    const blockForMissingProof = () => {
      pendingAttemptRef.current = null;
      setConfirmationOpen(false);
      setConfirmation('');
      setProofStatus('error');
      setProofMessage('伺服器候選驗證尚未完成或已失效，已阻止還原。');
      setStatus('error');
      setMessage('尚未送出：必須先完成與目前候選一致的伺服器驗證。');
    };
    if (!hasCurrentProof()) {
      blockForMissingProof();
      return;
    }
    recordCloudRestoreSubmitDiagnostic({
      event: 'confirmation-complete',
      phase: 'confirmation',
      outcome: 'success',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
      readStatus: getCloudConnectivitySnapshot().readStatus,
    });
    const readiness = inspectCurrentCloudRestoreReadiness({
      cloudMode: getProviderMode() === 'cloud',
      authenticated: Boolean(user),
      owner: role === 'owner',
    });
    if (!readiness.allowed) {
      const visible = normalizeCloudRestoreSubmitError({ code: readiness.code }, 'readiness', {
        source: 'pre-dispatch',
        attemptCorrelationId: pending.correlationId,
      });
      recordCloudRestoreSubmitDiagnostic({
        event: 'readiness-check-blocked',
        phase: 'readiness',
        outcome: 'not-submitted',
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        readStatus: readiness.connectivity.readStatus,
        error: visible,
      });
      recordCloudRestoreSubmitDiagnostic({
        event: 'submit-finish',
        phase: 'submit',
        outcome: 'not-submitted',
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
      });
      pendingAttemptRef.current = null;
      setConfirmationOpen(false);
      setConfirmation('');
      setStatus('error');
      setMessage(CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE);
      return;
    }
    recordCloudRestoreSubmitDiagnostic({
      event: 'readiness-check-pass',
      phase: 'readiness',
      attemptCorrelationId: pending.correlationId,
      idempotencyKey: pending.idempotencyKey,
      readStatus: readiness.connectivity.readStatus,
    });
    inFlightRef.current = true;
    setConfirmationOpen(false);
    setStatus('restoring');
    setMessage('Server 正在鎖定寫入、建立 rollback snapshot、驗證並執行原子還原…');
    let restoreDispatched = false;
    let durableAttempt: CloudRestoreAttemptOutcome | null = null;
    let attemptPrepareStarted = false;
    try {
      if (candidate.portability) {
        const targetResult = await (validateRestoreTarget ?? (command => dataProvider.validateCloudRestoreTarget(command)))({
          attemptCorrelationId: pending.correlationId,
          idempotencyKey: pending.idempotencyKey,
          candidate,
          confirmation: CONFIRMATION_TEXT,
        });
        recordCloudRestoreSubmitDiagnostic({
          event: 'target-compatibility',
          phase: 'readiness',
          outcome: targetResult.ok ? 'success' : 'failed',
          attemptCorrelationId: pending.correlationId,
          idempotencyKey: pending.idempotencyKey,
          readStatus: getCloudConnectivitySnapshot().readStatus,
        });
        const postValidationReadiness = inspectCurrentCloudRestoreReadiness({
          cloudMode: getProviderMode() === 'cloud',
          authenticated: Boolean(user),
          owner: role === 'owner',
        });
        if (!postValidationReadiness.allowed) {
          pendingAttemptRef.current = null;
          setConfirmation('');
          setStatus('error');
          setMessage(CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE);
          recordCloudRestoreSubmitDiagnostic({
            event: 'readiness-check-blocked', phase: 'readiness', outcome: 'not-submitted',
            attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
            readStatus: postValidationReadiness.connectivity.readStatus,
          });
          recordCloudRestoreSubmitDiagnostic({
            event: 'submit-finish', phase: 'submit', outcome: 'not-submitted',
            attemptCorrelationId: pending.correlationId, idempotencyKey: pending.idempotencyKey,
          });
          return;
        }
      }
      if (!hasCurrentProof()) {
        blockForMissingProof();
        return;
      }
      await assertCloudRestoreEffectiveCandidate(candidate);
      attemptPrepareStarted = true;
      persistCloudRestoreUnresolvedAttempt({
        attemptId: pending.idempotencyKey,
        traceId: pending.correlationId,
      });
      durableAttempt = await (prepareRestoreAttempt ?? (command => dataProvider.prepareCloudRestoreAttempt(command)))({
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        candidate,
        confirmation: CONFIRMATION_TEXT,
      });
      if (durableAttempt.status === 'completed' && durableAttempt.restoreResult) {
        await completeRestore(durableAttempt.restoreResult, pending);
        return;
      }
      if (durableAttempt.status !== 'executing' || !durableAttempt.executionId || !durableAttempt.reconcileAfter) {
        throw createCloudRestoreSafeSubmitError({ code: 'CLOUD_RESTORE_ATTEMPT_RESULT_INVALID' }, 'server-response');
      }
      recordCloudRestoreSubmitDiagnostic({
        event: 'rpc-invocation',
        phase: 'rpc',
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        readStatus: readiness.connectivity.readStatus,
      });
      restoreDispatched = true;
      const restored = await (executeRestore ?? (command => dataProvider.restoreCloudSnapshot(command)))({
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        candidate,
        confirmation: CONFIRMATION_TEXT,
        attempt: {
          status: 'executing',
          attemptId: durableAttempt.attemptId,
          traceId: durableAttempt.traceId,
          executionId: durableAttempt.executionId,
          expectedEpoch: durableAttempt.expectedEpoch,
          effectiveFingerprint: durableAttempt.effectiveFingerprint,
          reconcileAfter: durableAttempt.reconcileAfter,
        },
      });
      await completeRestore(restored, pending);
    } catch (error) {
      const visible = normalizeCloudRestoreSubmitError(error, restoreDispatched ? 'rpc' : 'readiness', {
        source: restoreDispatched ? 'post-dispatch' : 'pre-dispatch',
        attemptCorrelationId: pending.correlationId,
      });
      const unknown = visible.outcome === 'unknown';
      const durableFailure = isCloudRestoreFailureCode(visible.code);
      const requiresOutcomeCheck = !durableFailure && attemptPrepareStarted && (unknown || restoreDispatched);
      if (requiresOutcomeCheck) {
        const unresolved = {
          attemptId: durableAttempt?.attemptId ?? pending.idempotencyKey,
          traceId: durableAttempt?.traceId ?? pending.correlationId,
        };
        setUnresolvedAttempt(unresolved);
        persistCloudRestoreUnresolvedAttempt(unresolved);
      } else if (attemptPrepareStarted) {
        setUnresolvedAttempt(null);
        clearCloudRestoreUnresolvedAttempt();
      }
      if (!restoreDispatched && candidate.portability) {
        recordCloudRestoreSubmitDiagnostic({
          event: 'target-compatibility',
          phase: 'readiness',
          outcome: visible.outcome,
          attemptCorrelationId: pending.correlationId,
          idempotencyKey: pending.idempotencyKey,
          readStatus: getCloudConnectivitySnapshot().readStatus,
          error: visible,
        });
      }
      if (visible.outcome === 'not-submitted') {
        recordCloudRestoreSubmitDiagnostic({
          event: 'readiness-check-blocked',
          phase: 'readiness',
          outcome: 'not-submitted',
          attemptCorrelationId: pending.correlationId,
          idempotencyKey: pending.idempotencyKey,
          readStatus: getCloudConnectivitySnapshot().readStatus,
          error: visible,
        });
      }
      submissionLockedRef.current = requiresOutcomeCheck || visible.code === 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED';
      if (durableFailure || visible.code === 'CLOUD_RESTORE_ATTEMPT_NOT_COMMITTED') {
        submissionLockedRef.current = true;
        retireCloudRestoreIntentIdentity({
          attemptId: pending.idempotencyKey,
          traceId: pending.correlationId,
        }, retryKeys.current);
        setAttemptClosed(true);
      }
      setStatus(unknown ? 'unknown' : 'error');
      setMessage(formatCloudRestoreSubmitError(visible));
      recordCloudRestoreSubmitDiagnostic({
        event: 'submit-finish',
        phase: 'submit',
        outcome: visible.outcome,
        attemptCorrelationId: pending.correlationId,
        idempotencyKey: pending.idempotencyKey,
        error: visible,
      });
    } finally {
      inFlightRef.current = false;
      pendingAttemptRef.current = null;
    }
  };

  return (
    <section data-testid="cloud-atomic-restore" style={{ padding: 16, border: '2px solid #dc2626', borderRadius: 8, background: '#fff7ed' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <AlertTriangle color="#b91c1c" size={20} />
        <div>
          <div className="font-medium" style={{ color: '#991b1b' }}>Cloud JSON 原子還原</div>
          <div className="text-xs text-muted">Cloud DB 是唯一 authoritative source。快取不會被當成 restore source。</div>
        </div>
      </div>
      <p data-testid="cloud-restore-access" style={{ margin: '12px 0' }}>
        {!cloudMode
          ? '僅 Cloud Mode 可用。'
          : !user
            ? '請先登入。'
            : !owner
              ? '僅 owner 可執行。'
              : !online
                ? '目前離線；Cloud Restore 已拒絕。'
                : !fresh
                  ? '等待重新讀取雲端最新資料，完成後才能還原'
                  : 'Owner / authoritative fresh：可進行本機 preflight 與還原確認。'}
      </p>
      {!recoveryReady && cloudMode && owner && user && (
        <p data-testid="cloud-restore-recovery-gate" role={recovery.error ? 'alert' : 'status'}>
          {recovery.error ? '未決還原查詢失敗；新還原已暫停。' : '正在查詢目前帳號的未決還原…'}
          {recovery.error && <button type="button" onClick={refreshRecovery}>重新查詢未決還原（唯讀）</button>}
        </p>
      )}
      {recoveredAttempt && (
        <div data-testid="cloud-restore-recovered-attempt">
          <div>既有 Attempt：<code>{recoveredAttempt.attemptId}</code></div>
          <div>Trace：<code>{recoveredAttempt.traceId}</code></div>
          <div>狀態：{recoveredAttempt.status}；送出時間：{recoveredAttempt.submittedAt}</div>
          <div>Expected epoch：{recoveredAttempt.expectedEpoch}；Fingerprint：{recoveredAttempt.effectiveFingerprint.slice(0, 16)}…</div>
        </div>
      )}
      {(attemptClosed || status === 'success') && !unresolvedAttempt && (
        <button type="button" data-testid="cloud-restore-new-intent" disabled={!allowed} onClick={startNewIntent}>
          開始另一次還原（重新選檔與確認）
        </button>
      )}
      <button type="button" className="btn btn-outline" disabled={attemptClosed || Boolean(unresolvedAttempt) || !canPreflight || status === 'restoring' || status === 'checking' || status === 'unknown'} onClick={() => fileRef.current?.click()}>
        <FileCheck2 size={16} /> 選擇 JSON 並 Preflight
      </button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => void selectFile(event.target.files?.[0])} />

      {candidate && (
        <div data-testid="cloud-restore-preflight" style={{ marginTop: 14 }}>
          <div><strong>檔案：</strong>{candidate.fileName}</div>
          <div><strong>Schema：</strong>{candidate.schemaVersion}</div>
          <div><strong>資源：</strong>{candidate.manifest.resourceCount}／{CLOUD_RESTORE_TABLES.length}</div>
          <div><strong>總筆數：</strong>{candidate.manifest.totalRows}</div>
          <div><strong>Snapshot fingerprint：</strong><code>{candidate.manifest.snapshotFingerprint}</code></div>
          <div><strong>Relationship hash：</strong><code>{candidate.manifest.relationshipHash}</code></div>
          <div><strong>完整性：</strong>blocking orphan {candidate.manifest.orphanCount}；metadata missing {candidate.manifest.optionalMetadataMissingReferenceCount}；canonical anomalies {candidate.manifest.canonicalIdentityAnomalyCount}；duplicate IDs {candidate.manifest.duplicateCanonicalIdCount}；rollback snapshot 將由 Server 在 transaction 內建立。</div>
          <div data-testid="cloud-restore-source-integrity"><strong>原始快照：</strong>SHA-256 <code>{candidate.sourceFileSha256}</code>；source fingerprint <code>{sourceCandidate?.manifest.snapshotFingerprint}</code></div>
          <label htmlFor="cloud-restore-portability-mode" style={{ display: 'block', marginTop: 10 }}><strong>Restore 模式：</strong></label>
          <select
            id="cloud-restore-portability-mode"
            data-testid="cloud-restore-portability-mode"
            value={portabilityMode}
            onChange={event => void selectPortabilityMode(event.target.value as RestorePortabilityMode)}
            disabled={attemptClosed || Boolean(unresolvedAttempt) || status === 'restoring' || status === 'success' || status === 'unknown'}
          >
            <option value="strict">嚴格模式（不轉換）</option>
            <option value="cross-environment">跨環境搬移（僅清除白名單 updated_by）</option>
          </select>
          {candidate.portability && (
            <div data-testid="cloud-restore-portability-summary" style={{ marginTop: 8 }}>
              <div><strong>跨環境政策：</strong>{CLOUD_RESTORE_PORTABILITY_POLICY_VERSION}</div>
              <div><strong>明確 Target：</strong>{candidate.portability.targetProjectRef}</div>
              <div><strong>轉換：</strong>僅 15 表 nullable audit updated_by；共 {candidate.portability.totalTransformedRows} rows。</div>
              <div><strong>Effective candidate fingerprint：</strong><code>{candidate.manifest.snapshotFingerprint}</code></div>
              <div><strong>目標相容性：</strong>送出前由 read-only RPC 檢查，並由 Restore transaction 在 DELETE 前再次驗證。</div>
            </div>
          )}
          <details style={{ marginTop: 8 }}>
            <summary>各資源筆數</summary>
            <ul>{CLOUD_RESTORE_TABLES.map(([, table]) => <li key={table}>{table}: {candidate.manifest.counts[table]}</li>)}</ul>
          </details>
          <div data-testid="cloud-restore-owner-proof" style={{ marginTop: 12, padding: 12, border: '1px solid #b45309', borderRadius: 6, background: '#fffbeb' }}>
            <div><strong>OWNER 伺服器候選驗證</strong></div>
            <p
              data-testid="cloud-restore-proof-status"
              role={proofStatus === 'error' ? 'alert' : 'status'}
              style={{ margin: '6px 0' }}
            >
              {proofMessage}
            </p>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="cloud-restore-proof-button"
              disabled={attemptClosed || Boolean(unresolvedAttempt) || !allowed || proofStatus === 'loading' || proofCurrent || status === 'restoring' || status === 'unknown'}
              onClick={() => void proveCandidate()}
            >
              {proofStatus === 'loading' ? '伺服器驗證中…' : proofCurrent ? '伺服器驗證已通過' : '驗證還原候選'}
            </button>
            {proofCurrent && proofRecord && (
              <div data-testid="cloud-restore-proof-summary" style={{ marginTop: 8 }}>
                <div>資源：{proofRecord.result.resourceCount}；總筆數：{proofRecord.result.totalRows}</div>
                <div>跨環境 audit 轉換：{proofRecord.result.transformedUpdatedByCount}</div>
                <div>Effective fingerprint：<code>{proofRecord.result.effectiveFingerprint.slice(0, 16)}…</code></div>
                <div>Relationship / integrity：PASS</div>
              </div>
            )}
          </div>
          <label htmlFor="cloud-restore-confirmation" style={{ display: 'block', marginTop: 12 }}>
            請輸入 <code>{CONFIRMATION_TEXT}</code>
          </label>
          <input
            id="cloud-restore-confirmation"
            data-testid="cloud-restore-confirmation"
            value={confirmation}
            onChange={event => setConfirmation(event.target.value)}
            autoComplete="off"
            disabled={attemptClosed || Boolean(unresolvedAttempt) || !allowed || !proofCurrent || status === 'confirming' || status === 'restoring' || status === 'success' || status === 'unknown'}
          />
          <button
            type="button"
            className="btn btn-primary"
            data-testid="cloud-restore-submit"
            disabled={attemptClosed || Boolean(unresolvedAttempt) || !allowed || !proofCurrent || status === 'confirming' || status === 'restoring' || status === 'success' || status === 'unknown' || confirmation !== CONFIRMATION_TEXT}
            onClick={beginConfirmation}
            style={{ marginLeft: 10 }}
          >
            <RotateCcw size={16} /> {status === 'restoring' ? 'Server 原子還原中…' : '確認覆蓋 Cloud'}
          </button>
        </div>
      )}
      {confirmationOpen && candidate && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cloud-restore-final-confirmation-title"
          data-testid="cloud-restore-final-confirmation"
          style={{ marginTop: 14, padding: 14, border: '2px solid #991b1b', borderRadius: 8, background: '#fff' }}
        >
          <div id="cloud-restore-final-confirmation-title" className="font-medium">最後確認：完整覆蓋 Cloud authoritative data</div>
          <p>Server 會先建立 rollback snapshot。確認文字必須維持 <code>{CONFIRMATION_TEXT}</code>。</p>
          {!allowed && <p role="alert">{CLOUD_RESTORE_NOT_SUBMITTED_MESSAGE}</p>}
          {!proofCurrent && <p role="alert">伺服器候選驗證尚未完成或已失效；本次不會送出。</p>}
          <form onSubmit={event => { event.preventDefault(); void execute(); }}>
            <button type="button" className="btn btn-outline" onClick={cancelConfirmation} disabled={status === 'restoring'}>取消</button>
            <button
              type="submit"
              className="btn btn-primary"
              data-testid="cloud-restore-final-submit"
              disabled={!allowed || !proofCurrent || status === 'restoring'}
              style={{ marginLeft: 10 }}
            >
              最終確認並送出
            </button>
          </form>
        </div>
      )}
      <p role={status === 'error' || status === 'unknown' ? 'alert' : 'status'} data-testid="cloud-restore-status" style={{ marginBottom: 0 }}>{message}</p>
      {unresolvedAttempt && (
        <button
          type="button"
          className="btn btn-outline"
          data-testid="cloud-restore-check-outcome"
          disabled={status === 'checking' || !recoveryReady || !cloudMode || !user || !owner || !online}
          onClick={() => void checkOutcome()}
          style={{ marginTop: 10 }}
        >
          {status === 'checking' ? '查證中…' : '查證伺服器結果（不會重跑 Restore）'}
        </button>
      )}
      {result && (
        <div data-testid="cloud-restore-result">
          replayed={String(result.replayed)}；epoch={result.restoreEpoch}
          {result.timingsMs && (
            <details data-testid="cloud-restore-timings" style={{ marginTop: 8 }}>
              <summary>Server phase timings（ms）</summary>
              <pre>{JSON.stringify(result.timingsMs, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
      {cloudMode && owner && user && <CloudRestoreIntegrityAudit key={user.id} />}
    </section>
  );
}
