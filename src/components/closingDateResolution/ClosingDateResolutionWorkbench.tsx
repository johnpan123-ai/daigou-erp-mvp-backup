import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Clock3, ExternalLink, RefreshCw, X } from 'lucide-react';
import type { ProductGroup } from '../../lib/db';
import type {
  RankedResolutionCandidate,
  ResolutionBatch,
  ResolutionResult,
} from '../../lib/closingDateResolutionDomain';
import { createVerifiedMapping } from '../../lib/closingDateResolutionDomain';
import type {
  ClosingDateBatchGatewayMetrics,
  ClosingDateBatchPollResponse,
} from '../../lib/closingDateBatchGateway';
import {
  getClosingDateWorkbenchRuntime,
  reconcileInterruptedClosingDateJobs,
} from '../../lib/closingDateWorkbenchRuntime';
import { applyClosingDateResolutionBatch } from '../../lib/closingDateWorkbenchAtomicApply';

interface ClosingDateResolutionWorkbenchProps {
  selectedGroups: readonly ProductGroup[];
  allGroups: readonly ProductGroup[];
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}

type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null;

const terminalStatuses = new Set<ResolutionBatch['status']>([
  'CANCELLED',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
]);

const classificationLabel = {
  GREEN: '綠色｜可驗證來源',
  YELLOW: '黃色｜需要人工確認',
  RED: '紅色｜不可套用',
} as const;

const classificationColors = {
  GREEN: { border: '#86efac', bg: '#f0fdf4', text: '#166534' },
  YELLOW: { border: '#fde68a', bg: '#fffbeb', text: '#92400e' },
  RED: { border: '#fecaca', bg: '#fef2f2', text: '#991b1b' },
} as const;

const statusLabel = (status: ResolutionBatch['status']): string => ({
  QUEUED: '等待執行',
  RUNNING: '分析中',
  CANCELLING: '取消中',
  CANCELLED: '已取消',
  COMPLETED: '分析完成',
  FAILED: '分析失敗',
  EXPIRED: '已過期',
}[status]);

const uuid = (prefix: string): string => `${prefix}:${crypto.randomUUID()}`;

const stableInputHash = (groups: readonly ProductGroup[]): string => {
  const serialized = JSON.stringify(groups.map(group => ({
    id: group.id,
    title: group.title,
    updatedAt: group.updated_at ?? null,
    closingDate: group.closing_date ?? null,
  })));
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const metricSummary = (metrics: ClosingDateBatchGatewayMetrics | null): string => {
  if (!metrics) return '尚無效能資料';
  return [
    `${Math.round(metrics.totalTimeMs)}ms`,
    `upstream ${metrics.upstreamRequestCount}`,
    `cache ${Math.round(metrics.cacheHitRatio * 100)}%`,
    `dedupe ${Math.round(metrics.dedupeRatio * 100)}%`,
  ].join('・');
};

const candidateDate = (candidate: RankedResolutionCandidate): string => (
  `${candidate.rawDeadline || '無 Raw Deadline'} → ${candidate.suggestedClosingDate || '不可套用'}`
);

const ResultCard = ({
  result,
  selectedCandidateId,
  rememberedMappingId,
  onSelect,
  onRemember,
  remembering,
}: {
  result: ResolutionResult;
  selectedCandidateId: string | null;
  rememberedMappingId: string | null;
  onSelect: (candidate: RankedResolutionCandidate) => void;
  onRemember: (candidate: RankedResolutionCandidate) => void;
  remembering: boolean;
}) => {
  const colors = classificationColors[result.classification];
  return (
    <article
      data-testid={`closing-date-result-${result.erpProductGroupId}`}
      style={{ border: `1px solid ${colors.border}`, background: colors.bg, borderRadius: 10, padding: 12 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong style={{ color: '#111827' }}>{result.erpTitleAtAnalysis}</strong>
          <div style={{ color: colors.text, fontSize: 12, fontWeight: 700, marginTop: 4 }}>
            {classificationLabel[result.classification]}・{result.classificationReason}
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#475569' }}>
          信心 {Math.round(result.confidence * 100)}%
        </div>
      </div>

      {result.serviceError && (
        <div style={{ marginTop: 8, color: '#991b1b', fontSize: 12 }}>
          {result.serviceError.message}（{result.serviceError.retryable ? '可重試' : '不可重試'}）
        </div>
      )}

      {result.candidates.length === 0 ? (
        <div style={{ marginTop: 10, color: '#64748b', fontSize: 13 }}>沒有可供確認的 Catalog Candidate。</div>
      ) : (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          {result.candidates.map(candidate => {
            const selected = selectedCandidateId === candidate.id;
            const canChoose = result.classification !== 'RED';
            return (
              <div
                key={candidate.id}
                data-testid={`closing-date-candidate-${candidate.id}`}
                style={{
                  border: selected ? '2px solid #2563eb' : '1px solid #cbd5e1',
                  borderRadius: 8,
                  background: '#fff',
                  padding: 10,
                  opacity: canChoose ? 1 : 0.72,
                }}
              >
                <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: canChoose ? 'pointer' : 'not-allowed' }}>
                  <input
                    type="radio"
                    name={`candidate-${result.id}`}
                    checked={selected}
                    disabled={!canChoose}
                    onChange={() => onSelect(candidate)}
                  />
                  <span style={{ flex: 1 }}>
                    <span style={{ fontWeight: 700 }}>{candidate.rank}. {candidate.catalogTitle}</span>
                    <span style={{ display: 'block', color: '#475569', fontSize: 12, marginTop: 3 }}>
                      {candidate.source.sourceSupplier}・{candidateDate(candidate)}・{candidate.matchMethod}・{Math.round(candidate.confidence * 100)}%
                    </span>
                    <span style={{ display: 'block', color: '#64748b', fontSize: 11, marginTop: 2 }}>
                      Source ID: {candidate.source.sourceProductId}
                    </span>
                  </span>
                  {candidate.catalogUrl && (
                    <a
                      href={candidate.catalogUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={event => event.stopPropagation()}
                      aria-label="開啟 Catalog 商品"
                    >
                      <ExternalLink size={15} />
                    </a>
                  )}
                </label>
                {result.classification === 'YELLOW' && selected && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                    <button
                      type="button"
                      data-testid={`closing-date-remember-${result.id}`}
                      disabled={remembering || Boolean(rememberedMappingId)}
                      onClick={() => onRemember(candidate)}
                      style={{
                        border: '1px solid #7c3aed',
                        color: rememberedMappingId ? '#166534' : '#6d28d9',
                        background: '#fff',
                        borderRadius: 7,
                        padding: '6px 10px',
                        fontWeight: 700,
                        cursor: remembering ? 'wait' : 'pointer',
                      }}
                    >
                      {rememberedMappingId ? '✓ 已選擇並記住' : remembering ? '儲存中…' : '選擇並記住'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
};

export default function ClosingDateResolutionWorkbench({
  selectedGroups,
  allGroups,
  onClose,
  onApplied,
}: ClosingDateResolutionWorkbenchProps) {
  const [initializing, setInitializing] = useState(true);
  const [recentBatches, setRecentBatches] = useState<readonly ResolutionBatch[]>([]);
  const [currentBatch, setCurrentBatch] = useState<ResolutionBatch | null>(null);
  const [results, setResults] = useState<readonly ResolutionResult[]>([]);
  const [metrics, setMetrics] = useState<ClosingDateBatchGatewayMetrics | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Record<string, string>>({});
  const [rememberedMappings, setRememberedMappings] = useState<Record<string, string>>({});
  const [rememberingResultId, setRememberingResultId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const mountedRef = useRef(true);
  const pollingRef = useRef(false);

  const refreshHistory = useCallback(async () => {
    const runtime = getClosingDateWorkbenchRuntime();
    const batches = await runtime.repository.listResolutionBatches(20);
    if (mountedRef.current) setRecentBatches(batches);
    return batches;
  }, []);

  const displayPoll = useCallback((poll: ClosingDateBatchPollResponse) => {
    setCurrentBatch(poll.batch);
    setResults(poll.results);
    setMetrics(poll.metrics);
    setSelectedCandidates(previous => {
      const next = { ...previous };
      poll.results.forEach(result => {
        if (!next[result.id] && result.selectedCandidateId) next[result.id] = result.selectedCandidateId;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const runtime = getClosingDateWorkbenchRuntime();
        await runtime.repository.initialize();
        const batches = await reconcileInterruptedClosingDateJobs(runtime);
        if (mountedRef.current) setRecentBatches(batches);
      } catch (error) {
        if (mountedRef.current) {
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (mountedRef.current) setInitializing(false);
      }
    })();
    return () => {
      mountedRef.current = false;
      pollingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!activeJobId) return undefined;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async (): Promise<void> => {
      if (cancelled || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const response = await getClosingDateWorkbenchRuntime().gateway.pollJob(activeJobId);
        if (cancelled) return;
        displayPoll(response);
        if (terminalStatuses.has(response.batch.status)) {
          setActiveJobId(null);
          await refreshHistory();
          return;
        }
      } catch (error) {
        if (!cancelled) setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
      } finally {
        pollingRef.current = false;
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 450);
    };
    void poll();
    return () => {
      cancelled = true;
      pollingRef.current = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeJobId, displayPoll, refreshHistory]);

  const startAnalysis = async (groupsToAnalyze: readonly ProductGroup[]) => {
    if (groupsToAnalyze.length === 0) {
      setNotice({ kind: 'error', text: '沒有可分析的商品。' });
      return;
    }
    setNotice({ kind: 'info', text: `正在建立 ${groupsToAnalyze.length} 筆商品的唯讀分析 Batch…` });
    setSelectedCandidates({});
    setRememberedMappings({});
    setResults([]);
    setMetrics(null);
    try {
      const runtime = getClosingDateWorkbenchRuntime();
      const clientBatchId = uuid('closing-date-batch');
      const response = await runtime.gateway.createJob({
        clientBatchId,
        idempotencyKey: uuid('closing-date-analysis'),
        inputHash: stableInputHash(groupsToAnalyze),
        snapshotVersionPreference: 'LATEST',
        ruleVersion: 'closing-date-minus-two-v1',
        items: groupsToAnalyze.map(group => ({
          clientItemId: group.id,
          erpProductGroupId: group.id,
          title: group.title,
          updatedAt: group.updated_at ?? null,
          currentClosingDate: group.closing_date || null,
          sourceType: group.source_type ?? group.listing_type ?? null,
          proxyAgent: group.proxy_agent ?? null,
          jan: null,
          modelCode: null,
          verifiedMappings: [],
        })),
      });
      const initial = await runtime.gateway.pollJob(response.jobId);
      displayPoll(initial);
      setActiveJobId(response.jobId);
      setNotice({ kind: 'info', text: '分析已開始；此階段不會修改任何 ProductGroup。' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  };

  const openBatch = async (batch: ResolutionBatch) => {
    try {
      const poll = await getClosingDateWorkbenchRuntime().gateway.pollJob(batch.id);
      displayPoll(poll);
      setActiveJobId(terminalStatuses.has(poll.batch.status) ? null : poll.batch.id);
      setNotice({ kind: 'info', text: `已開啟 ${statusLabel(poll.batch.status)}的既有 Batch。` });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  };

  const cancel = async () => {
    if (!activeJobId) return;
    try {
      await getClosingDateWorkbenchRuntime().gateway.cancelJob(activeJobId);
      setNotice({ kind: 'info', text: '已送出取消要求。' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  };

  const retry = async () => {
    if (!currentBatch) return;
    const retryIds = new Set(
      results.filter(result => result.serviceError?.retryable).map(result => result.erpProductGroupId),
    );
    const ids = retryIds.size > 0 ? retryIds : new Set(currentBatch.productGroupIds);
    const retryGroups = allGroups.filter(group => ids.has(group.id));
    if (retryGroups.length !== ids.size) {
      setNotice({ kind: 'error', text: '部分商品已不存在，無法安全重試；請回訂購紀錄重新選取。' });
      return;
    }
    await startAnalysis(retryGroups);
  };

  const rememberCandidate = async (
    result: ResolutionResult,
    candidate: RankedResolutionCandidate,
  ) => {
    setRememberingResultId(result.id);
    try {
      const mapping = createVerifiedMapping({
        id: uuid('verified-mapping'),
        erpProductGroupId: result.erpProductGroupId,
        source: candidate.source,
        resolutionIdentityId: candidate.resolutionIdentityId ?? null,
        verificationMethod: 'MANUAL_TOP3_SELECTION',
        verificationEvidence: {
          resolutionBatchId: result.batchId,
          resolutionResultId: result.id,
          candidateId: candidate.id,
        },
        sourceTitleAtVerification: candidate.catalogTitle,
        erpTitleFingerprint: result.erpTitleAtAnalysis,
        verifiedAt: new Date().toISOString(),
        verifiedBy: 'next-owner',
      });
      const saved = await getClosingDateWorkbenchRuntime().repository.saveVerifiedMapping(mapping);
      setRememberedMappings(previous => ({ ...previous, [result.id]: saved.id }));
      setSelectedCandidates(previous => ({ ...previous, [result.id]: candidate.id }));
      setNotice({ kind: 'success', text: '已建立 Verified Mapping；尚未修改結單日。' });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setRememberingResultId(null);
    }
  };

  const applicableSelections = useMemo(() => results.flatMap(result => {
    if (result.classification === 'RED') return [];
    const candidateId = selectedCandidates[result.id]
      ?? (result.classification === 'GREEN' ? result.selectedCandidateId : null);
    if (!candidateId) return [];
    const candidate = result.candidates.find(item => item.id === candidateId);
    if (!candidate?.rawDeadline || !candidate.suggestedClosingDate) return [];
    return [{
      result: { ...result, selectedCandidateId: candidate.id },
      approval: result.classification === 'GREEN' ? 'GREEN_AUTO' as const : 'MANUAL_CONFIRMED' as const,
      mappingId: rememberedMappings[result.id] ?? result.selectedMappingId ?? null,
    }];
  }), [rememberedMappings, results, selectedCandidates]);

  const apply = async () => {
    if (!currentBatch || applicableSelections.length === 0 || applying) return;
    const skippedYellow = results.filter(result => (
      result.classification === 'YELLOW' && !selectedCandidates[result.id]
    )).length;
    const confirmed = window.confirm(
      `確定套用 ${applicableSelections.length} 筆結單日嗎？\n\n`
      + `紅色結果不會套用；未選擇的黃色結果 ${skippedYellow} 筆也會略過。\n`
      + '套用前會重新檢查商品與結單日；任一衝突將整批取消（0 write）。',
    );
    if (!confirmed) return;
    setApplying(true);
    try {
      const applyBatchId = uuid('closing-date-apply');
      const response = await applyClosingDateResolutionBatch({
        repository: getClosingDateWorkbenchRuntime().repository,
        resolutionBatch: currentBatch,
        selections: applicableSelections,
        applyBatchId,
        applyItemIds: applicableSelections.map(() => uuid('closing-date-apply-item')),
        idempotencyKey: uuid('closing-date-apply-idempotency'),
        appliedAt: new Date().toISOString(),
      });
      if (response.status === 'APPLIED') {
        setNotice({ kind: 'success', text: `已 atomic 套用 ${response.audit.batch.appliedCount} 筆結單日。` });
        await onApplied();
      } else if (response.status === 'CONFLICT') {
        const codes = [...new Set(response.audit.items.flatMap(item => (
          item.conflictInformation?.map(conflict => conflict.code) ?? []
        )))];
        setNotice({ kind: 'error', text: `偵測到資料衝突，整批 0 write：${codes.join('、') || 'UNKNOWN_CONFLICT'}` });
      } else {
        setNotice({ kind: 'error', text: `套用未完成（${response.status}），主資料 transaction 已回滾。` });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setApplying(false);
    }
  };

  const progress = currentBatch?.progress;
  const progressPercent = progress && progress.totalCount > 0
    ? Math.round((progress.completedCount / progress.totalCount) * 100)
    : 0;

  return (
    <div
      data-testid="closing-date-workbench"
      role="dialog"
      aria-modal="true"
      aria-label="Closing Date Resolution Workbench"
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(15,23,42,0.55)', display: 'flex', justifyContent: 'center', padding: 18 }}
    >
      <section style={{ width: 'min(1180px, 100%)', height: 'calc(100vh - 36px)', background: '#f8fafc', borderRadius: 16, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 80px rgba(15,23,42,0.3)' }}>
        <header style={{ padding: '16px 20px', background: '#fff', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>結單日分析工作台</h2>
            <div style={{ marginTop: 3, color: '#64748b', fontSize: 12 }}>NEXT FIELD TEST ONLY・分析階段 0 ProductGroup write</div>
          </div>
          <button type="button" aria-label="關閉結單日分析工作台" data-testid="closing-date-workbench-close" onClick={onClose} style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 6 }}>
            <X size={22} />
          </button>
        </header>

        <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
          {notice && (
            <div data-testid="closing-date-workbench-notice" style={{ marginBottom: 12, borderRadius: 8, padding: '10px 12px', background: notice.kind === 'error' ? '#fef2f2' : notice.kind === 'success' ? '#f0fdf4' : '#eff6ff', color: notice.kind === 'error' ? '#991b1b' : notice.kind === 'success' ? '#166534' : '#1e40af' }}>
              {notice.text}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 14 }}>
            <main style={{ minWidth: 0 }}>
              <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <strong>本次選取：{selectedGroups.length} 筆</strong>
                    <div style={{ color: '#64748b', fontSize: 12, marginTop: 3 }}>建立 Batch 後才初始化 Catalog snapshot；關閉工作台會停止 UI polling，Batch runner 可繼續完成。</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      data-testid="closing-date-workbench-analyze"
                      disabled={initializing || Boolean(activeJobId) || selectedGroups.length === 0}
                      onClick={() => void startAnalysis(selectedGroups)}
                      style={{ border: 0, borderRadius: 8, background: '#2563eb', color: '#fff', padding: '9px 14px', fontWeight: 700, cursor: activeJobId ? 'not-allowed' : 'pointer' }}
                    >
                      分析結單日
                    </button>
                    {activeJobId && (
                      <button type="button" data-testid="closing-date-workbench-cancel" onClick={() => void cancel()} style={{ border: '1px solid #dc2626', borderRadius: 8, color: '#b91c1c', background: '#fff', padding: '9px 12px', fontWeight: 700 }}>
                        取消
                      </button>
                    )}
                    {currentBatch && (currentBatch.status === 'FAILED' || currentBatch.status === 'CANCELLED' || currentBatch.progress.retryableServiceErrorCount > 0) && (
                      <button type="button" data-testid="closing-date-workbench-retry" onClick={() => void retry()} style={{ border: '1px solid #64748b', borderRadius: 8, background: '#fff', padding: '9px 12px', fontWeight: 700 }}>
                        <RefreshCw size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} />重試
                      </button>
                    )}
                  </div>
                </div>

                {currentBatch && (
                  <div style={{ marginTop: 13 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475569' }}>
                      <span>{statusLabel(currentBatch.status)}・{progress?.completedCount ?? 0}/{progress?.totalCount ?? 0}</span>
                      <span>{progressPercent}%</span>
                    </div>
                    <div style={{ height: 8, borderRadius: 999, background: '#e2e8f0', marginTop: 6, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${progressPercent}%`, background: '#2563eb', transition: 'width 180ms ease' }} />
                    </div>
                    <div style={{ color: '#64748b', fontSize: 11, marginTop: 6 }}>{metricSummary(metrics)}</div>
                    {currentBatch.failure && (
                      <div style={{ color: '#991b1b', fontSize: 12, marginTop: 6 }}>{currentBatch.failure.code}：{currentBatch.failure.message}</div>
                    )}
                  </div>
                )}
              </div>

              {(['GREEN', 'YELLOW', 'RED'] as const).map(classification => {
                const items = results.filter(result => result.classification === classification);
                if (items.length === 0) return null;
                return (
                  <section key={classification} style={{ marginBottom: 16 }}>
                    <h3 style={{ fontSize: 15, color: classificationColors[classification].text, margin: '0 0 8px' }}>
                      {classificationLabel[classification]}（{items.length}）
                    </h3>
                    <div style={{ display: 'grid', gap: 10 }}>
                      {items.map(result => (
                        <ResultCard
                          key={result.id}
                          result={result}
                          selectedCandidateId={selectedCandidates[result.id] ?? result.selectedCandidateId ?? null}
                          rememberedMappingId={rememberedMappings[result.id] ?? null}
                          remembering={rememberingResultId === result.id}
                          onSelect={candidate => setSelectedCandidates(previous => ({ ...previous, [result.id]: candidate.id }))}
                          onRemember={candidate => void rememberCandidate(result, candidate)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}

              {currentBatch?.status === 'COMPLETED' && (
                <div style={{ position: 'sticky', bottom: 0, background: 'rgba(248,250,252,0.96)', borderTop: '1px solid #cbd5e1', padding: '12px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <span style={{ color: '#475569', fontSize: 13 }}>
                    可套用 {applicableSelections.length} 筆；紅色與未確認黃色不會套用。
                  </span>
                  <button
                    type="button"
                    data-testid="closing-date-workbench-apply"
                    disabled={applicableSelections.length === 0 || applying}
                    onClick={() => void apply()}
                    style={{ border: 0, borderRadius: 8, background: applicableSelections.length ? '#059669' : '#94a3b8', color: '#fff', padding: '10px 16px', fontWeight: 800, cursor: applying ? 'wait' : 'pointer' }}
                  >
                    {applying ? 'Atomic 套用中…' : '最後確認並 Atomic 套用'}
                  </button>
                </div>
              )}
            </main>

            <aside style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 12, alignSelf: 'start', position: 'sticky', top: 0 }}>
              <strong style={{ fontSize: 14 }}><Clock3 size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} />最近 Batch</strong>
              <div style={{ display: 'grid', gap: 7, marginTop: 10 }}>
                {initializing && <span style={{ color: '#64748b', fontSize: 12 }}>讀取 Sidecar…</span>}
                {!initializing && recentBatches.length === 0 && <span style={{ color: '#64748b', fontSize: 12 }}>尚無分析紀錄</span>}
                {recentBatches.slice(0, 10).map(batch => (
                  <button
                    type="button"
                    key={batch.id}
                    data-testid={`closing-date-history-${batch.id}`}
                    onClick={() => void openBatch(batch)}
                    style={{ textAlign: 'left', border: currentBatch?.id === batch.id ? '2px solid #2563eb' : '1px solid #e2e8f0', background: '#fff', borderRadius: 7, padding: 8, cursor: 'pointer' }}
                  >
                    <span style={{ display: 'block', fontWeight: 700, fontSize: 12 }}>{statusLabel(batch.status)}・{batch.productGroupIds.length} 筆</span>
                    <span style={{ display: 'block', color: '#64748b', fontSize: 10, marginTop: 2 }}>{new Date(batch.createdAt).toLocaleString('zh-TW')}</span>
                    {batch.failure?.code === 'RUNNER_INTERRUPTED' && (
                      <span style={{ display: 'block', color: '#b45309', fontSize: 10, marginTop: 2 }}>已中斷，可重試</span>
                    )}
                  </button>
                ))}
              </div>
              <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 12, paddingTop: 10, color: '#64748b', fontSize: 11, lineHeight: 1.55 }}>
                <div><Check size={12} style={{ verticalAlign: 'middle' }} /> 綠色僅限已驗證／Exact ID 證據</div>
                <div><CircleAlert size={12} style={{ verticalAlign: 'middle' }} /> Parser／fuzzy 即使 100% 仍為黃色</div>
                <div>紅色永遠不可套用</div>
              </div>
            </aside>
          </div>
        </div>
      </section>
    </div>
  );
}
