import { lazy, Suspense, useState, useEffect, useLayoutEffect, useMemo, useRef, useDeferredValue, useCallback } from 'react';
import { calculateFinalMyacgDemand, getBaseSku, calculateVariantDemandAndPurchased, normalizeDateInput, cloudCacheDb, localDb } from '../lib/db';
import { dataProvider, StaleDataError } from '../providers/dataProvider';
import { useCloudResourceSync } from '../contexts/CloudRealtimeSyncContext';
import { CloudRefreshButton } from '../components/CloudRefreshButton';
import { mapPrivateOrderItemsByGroup, mapPurchaseBatchItemsByGroup } from '../lib/purchaseBatchScope';
import { buildPurchaseRecordSearchDocuments, buildVariantsByGroup, purchaseRecordMatchesSearch } from '../lib/growthSafeSelectors';

import type { ProductGroup, ProductVariant, ProductCategory, PurchaseBatch, PurchaseBatchItem, PrivateOrder, PrivateOrderItem, InventoryItem, SalesOrderItem } from '../lib/db';
import { Receipt, Search, Trash2, Calendar, Copy, Check, ExternalLink, AlertTriangle, CircleDollarSign } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { useNavigate, useLocation } from 'react-router-dom';
import { useViewport } from '../contexts/ViewportContext';
import { useResizableColumns } from '../hooks/useResizableColumns';
import {
  buildProxyCatalogQueries,
  normalizeProxyProductIdentity,
  scoreProxyCatalogCandidate,
  selectProxyCatalogCandidate,
} from '../lib/proxyProductIdentity';
import type { ProxyCatalogCandidate } from '../lib/proxyProductIdentity';
import {
  canUseProxyIdentityShadow,
  compareProxyIdentityShadows,
  createProxyIdentityShadowDiagnostic,
  type ProxyIdentityShadowComparison,
  type ProxyIdentityShadowDiagnostic,
} from '../lib/proxyProductIdentityShadow';
import {
  resolveProxyCatalogDecision,
  canUseProxyIdentityPilot,
  scoreProxyCatalogCandidateV2Pilot,
  type ProxyIdentityPilotEvidence,
  type ProxyIdentitySafetyVetoReason,
} from '../lib/proxyProductIdentityPilot';
import { buildProxyCatalogQueriesV2 } from '../lib/proxyProductIdentityQueryV2';
import {
  CATALOG_SERVICE_UNAVAILABLE_MESSAGE,
  CatalogServiceError,
  fetchReadonlyCatalogJson,
  fetchReadonlyCatalogText,
} from '../lib/readonlyCatalogApi';
import { getProviderMode } from '../providers/providerMode';
import { readNextRawCollections } from '../lib/nextRawDbIntegrityProbe';
import {
  assertNextFieldTestProductGroupsReadback,
  canUseNextFieldTestClosingDateClear,
  createNextFieldTestClosingDateClearPlan,
} from '../lib/nextFieldTestClosingDate';
import {
  canUseClosingDateWorkbenchUi,
  getClosingDateWorkbenchMode,
} from '../lib/closingDateWorkbenchAccess';
import { capturePurchaseRecordsEditView, resolvePurchaseRecordsEditView } from '../lib/purchaseRecordsEditView';
import type { ClosingDateWorkbenchApplyRequest } from '../components/closingDateResolution/ClosingDateResolutionWorkbench';

const ClosingDateResolutionWorkbench = lazy(
  () => import('../components/closingDateResolution/ClosingDateResolutionWorkbench'),
);

const DEFAULT_COL_WIDTHS = {
  title: 350,
  myacg: 80,
  waca: 80,
  privateOrder: 90,
  totalDemand: 90,
  purchased: 80,
  gap: 80,
  closingDate: 120,
  releaseMonth: 100,
  productUrl: 120
};

const DELETE_COLUMN_WIDTH = 64;

type LookupDecision = 'MATCH' | 'AMBIGUOUS' | 'NOT_FOUND' | 'SERVICE_ERROR';

type LookupIdentitySummary = {
  productType: string | null;
  productLine: string | null;
  identity: string[];
  identityCandidates: string[];
  aliases: string[];
  series: string[];
  qualifiers: string[];
  size: string | null;
  scale: string | null;
  manufacturer: string | null;
};

type LookupCandidateSummary = LookupIdentitySummary & {
  title: string;
  supplier: string | null;
  rawDeadline: string | null;
  score: number | null;
  identityShadow?: ProxyIdentityShadowDiagnostic;
  shadowComparison?: ProxyIdentityShadowComparison[];
  pilotEvidence?: ProxyIdentityPilotEvidence[];
};

type LookupDiagnostic = {
  groupId: string;
  source: 'proxy' | 'hololive' | 'vspo';
  originalTitle: string;
  decision: LookupDecision;
  decisionSource?: 'V1' | 'V2_PILOT' | 'NO_MATCH_V1_ONLY' | 'NO_MATCH_AFTER_V2';
  score: number;
  reason?: string;
  sourceIdentity?: LookupIdentitySummary;
  sourceIdentityShadow?: ProxyIdentityShadowDiagnostic;
  selected?: LookupCandidateSummary;
  candidates?: LookupCandidateSummary[];
  pilotEvidence?: ProxyIdentityPilotEvidence[];
  finalClosingDate?: string;
  v1Queries?: string[];
  v2Queries?: string[];
  executedQueries?: string[];
  v2Attempted?: boolean;
  v2RejectReason?: string;
  v2SafetyVetoReason?: ProxyIdentitySafetyVetoReason;
};

const summarizeIdentity = (identity: ReturnType<typeof normalizeProxyProductIdentity>): LookupIdentitySummary => ({
  productType: identity.productType,
  productLine: identity.productLine,
  identity: identity.identityTokens,
  identityCandidates: identity.identityCandidates,
  aliases: identity.identityAliases,
  series: identity.seriesTokens,
  qualifiers: identity.versionTokens,
  size: identity.size,
  scale: identity.scale,
  manufacturer: identity.manufacturer,
});

const summarizeCandidate = (
  candidate: ProxyCatalogCandidate,
  score: number | null = null,
  sourceIdentityShadow?: ProxyIdentityShadowDiagnostic,
  pilotEvidence?: ProxyIdentityPilotEvidence[],
): LookupCandidateSummary => {
  const identity = normalizeProxyProductIdentity(
    candidate.name || '',
    candidate.manufacturer || candidate.brand?.name || '',
  );
  const identityShadow = sourceIdentityShadow
    ? createProxyIdentityShadowDiagnostic(
      candidate.name || '',
      identity,
      candidate.manufacturer || candidate.brand?.name || '',
    )
    : undefined;
  return {
    ...summarizeIdentity(identity),
    title: candidate.name || '(未提供商品名稱)',
    supplier: candidate.catalog?.supplier?.code || null,
    rawDeadline: candidate.catalog?.deadlineAt || null,
    score,
    identityShadow,
    shadowComparison: identityShadow && sourceIdentityShadow
      ? compareProxyIdentityShadows(sourceIdentityShadow, identityShadow)
      : undefined,
    pilotEvidence,
  };
};

const formatShadowValues = (values: string[]): string => values.join('、') || '—';

const formatCompoundSubjects = (
  compounds: ProxyIdentityShadowDiagnostic['v2']['compoundSubjects'],
): string => compounds
  .map(compound => compound.members.join(' + '))
  .join('；') || '—';

const IdentityShadowBlock = ({
  shadow,
  comparison,
}: {
  shadow: ProxyIdentityShadowDiagnostic;
  comparison?: ProxyIdentityShadowComparison[];
}) => (
  <div
    data-testid="identity-parser-v2-shadow"
    style={{ marginTop: '6px', padding: '7px 9px', borderRadius: '6px', backgroundColor: '#eef2ff', color: '#3730a3' }}
  >
    <div style={{ fontWeight: 700 }}>Parser v2 Shadow（NEXT ONLY・不參與 Matching）</div>
    <div>
      Manufacturer {formatShadowValues(shadow.v2.manufacturers)} ・
      Product Type {formatShadowValues(shadow.v2.productTypes)} ・
      Product Line {formatShadowValues(shadow.v2.productLines)}
    </div>
    <div>
      Subject {formatShadowValues(shadow.v2.subjects)} ・
      Compound Subject {formatCompoundSubjects(shadow.v2.compoundSubjects)} ・
      Series {formatShadowValues(shadow.v2.series)}
    </div>
    <div>
      Version {formatShadowValues(shadow.v2.versions)} ・
      Form {formatShadowValues(shadow.v2.forms)} ・
      Scale {formatShadowValues(shadow.v2.scales)} ・
      Dimension {formatShadowValues(shadow.v2.dimensions)}
    </div>
    <div>
      Model Code {formatShadowValues(shadow.v2.modelCodes)} ・
      Qualifier {formatShadowValues(shadow.v2.qualifiers)}
    </div>
    <div style={{ marginTop: '3px', fontWeight: 700 }}>
      Parser disagreement：{shadow.disagreements.length > 0 ? 'YES' : 'NO'}
      {shadow.disagreements.length > 0 ? ` — ${shadow.disagreements.join('、')}` : ''}
    </div>
    <div style={{ marginTop: '7px', paddingTop: '7px', borderTop: '1px solid #c7d2fe' }}>
      <div style={{ fontWeight: 700 }}>Parser v2.1 Subject Rewrite（NEXT ONLY・SHADOW ONLY）</div>
      <div>
        Resolution {shadow.v21.subjectResolution} ・
        Evidence {formatShadowValues(shadow.v21.subjectEvidence)}
      </div>
      <div>
        Subject {formatShadowValues(shadow.v21.subjects)} ・
        Compound Subject {formatCompoundSubjects(shadow.v21.compoundSubjects)} ・
        Series {formatShadowValues(shadow.v21.series)}
      </div>
      <div>
        Version {formatShadowValues(shadow.v21.versions)} ・
        Form {formatShadowValues(shadow.v21.forms)} ・
        Dimension {formatShadowValues(shadow.v21.dimensions)}
      </div>
      <div>
        Unresolved {formatShadowValues(shadow.v21.unresolvedSubjectTokens)}
      </div>
      <div style={{ marginTop: '3px', fontWeight: 700 }}>
        v2.1 observations：{shadow.v21Observations.length > 0
          ? shadow.v21Observations.join('、')
          : 'NONE'}
      </div>
    </div>
    {comparison && comparison.length > 0 && (
      <div style={{ marginTop: '3px', fontWeight: 700 }}>
        Shadow identity comparison：{comparison.join('、')}
      </div>
    )}
  </div>
);


const ScrollWrapper = ({ children }: { children: React.ReactNode; isMobile: boolean }) => {
  return (
    <div
      className="mobile-scroll-wrapper"
      style={{
        width: '100%',
        overflowX: 'auto',
        overflowY: 'auto',
        maxHeight: 'calc(100vh - 320px)',
        WebkitOverflowScrolling: 'touch'
      }}
    >
      {children}
    </div>
  );
};

const logCrash = (context: string, err: unknown) => {
  const entry = { time: new Date().toISOString(), error: String(err), stack: (err as any)?.stack, context };
  window.__erpCrashLog = window.__erpCrashLog || [];
  window.__erpCrashLog.push(entry);
  try {
    const existing = JSON.parse(localStorage.getItem('erp_crash_log') || '[]');
    existing.push(entry);
    if (existing.length > 20) existing.splice(0, existing.length - 20);
    localStorage.setItem('erp_crash_log', JSON.stringify(existing));
  } catch { /* ignore */ }
};

const WACA_META_ID = '00000000-0000-4000-a000-000000000000';

const formatWacaDate = (dateStr: string) => {
  if (!dateStr) return '尚未更新';
  if (dateStr.includes('T') && !isNaN(Date.parse(dateStr))) {
    const d = new Date(dateStr);
    const YYYY = d.getFullYear();
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const HH = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${YYYY}/${MM}/${DD} ${HH}:${mm}:${ss}`;
  }
  return dateStr.replace(/-/g, '/');
};

// release_month 為人工輸入的自由文字，僅在排序時解析成年月，不寫回資料。
// tier 0: 在庫/現貨/即納；tier 1: 可辨識出「年+月」(上旬/下旬/底等後綴一律視為同月)；tier 2: 未定/空白/無法辨識
const parseReleaseYm = (raw: string | undefined | null): { tier: 0 | 1 | 2; ym: number } => {
  const v = (raw || '')
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .trim();
  if (/在庫|現貨|即納/.test(v)) return { tier: 0, ym: 0 };
  const m = v.match(/(\d{4})\s*[/\-年.]\s*(\d{1,2})/);
  if (m) {
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return { tier: 1, ym: Number(m[1]) * 12 + mo };
  }
  return { tier: 2, ym: 0 };
};

export default function PurchaseRecords() {
  const { isMobile } = useViewport();
  const providerMode = getProviderMode();
  const isNextIdentityShadowMode = canUseProxyIdentityShadow(providerMode);
  const isClosingDateWorkbenchAvailable = canUseClosingDateWorkbenchUi(providerMode);
  const closingDateWorkbenchMode = getClosingDateWorkbenchMode(providerMode);

  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [batches, setBatches] = useState<PurchaseBatch[]>([]);
  const [batchItems, setBatchItems] = useState<PurchaseBatchItem[]>([]);
  const [privateOrders, setPrivateOrders] = useState<PrivateOrder[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [salesOrderItems, setSalesOrderItems] = useState<SalesOrderItem[]>([]);
  const batchItemsByGroupId = useMemo(
    () => mapPurchaseBatchItemsByGroup(batches, batchItems),
    [batches, batchItems]
  );
  const privateOrderItemsByGroupId = useMemo(
    () => mapPrivateOrderItemsByGroup(privateOrders, privateOrderItems),
    [privateOrders, privateOrderItems]
  );

  // isInitialLoading: true until we have SOMETHING to show (either local cache or the fresh
  // cloud fetch) — blocks the table so we never render a misleading "0 筆" while data is still
  // in flight. isSyncing: true only while showing stale local cache and waiting for the real
  // cloud sync to confirm/replace it — shows a small non-blocking indicator instead.
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  const [editMode, setEditMode] = useState<boolean>(false);

  const [wacaMeta, setWacaMeta] = useState<ProductGroup | null>(null);
  const [showWacaDialog, setShowWacaDialog] = useState<boolean>(false);
  const [animateWacaDialog, setAnimateWacaDialog] = useState<boolean>(false);

  const openWacaDialog = () => {
    setShowWacaDialog(true);
  };

  const closeWacaDialog = () => {
    setAnimateWacaDialog(false);
    setTimeout(() => setShowWacaDialog(false), 220);
  };

  useEffect(() => {
    if (showWacaDialog) {
      let rAFId = requestAnimationFrame(() => {
        rAFId = requestAnimationFrame(() => {
          setAnimateWacaDialog(true);
        });
      });
      return () => cancelAnimationFrame(rAFId);
    } else {
      setAnimateWacaDialog(false);
    }
  }, [showWacaDialog]);
  const [selectedWacaUpdater, setSelectedWacaUpdater] = useState<'小河馬' | 'Flanlove' | '許願' | '江尚恩'>('小河馬');

  const handleUpdateAgent = async (groupId: string, agent: string) => {
    if (guardAgainstStaleWrite()) return;

    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return { ...g, proxy_agent: agent || undefined } as ProductGroup;
      }
      return g;
    });

    setGroups(updatedGroups);

    try {
      await dataProvider.saveProductGroups(updatedGroups);
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      throw err;
    }
  };

  const [draftDemands, setDraftDemands] = useState<Record<string, string>>({});
  const [pendingDemandCommits, setPendingDemandCommits] = useState<Set<string>>(() => new Set());
  const pendingDemandCommitKeysRef = useRef<Set<string>>(new Set());
  const cancelledDemandCommitKeysRef = useRef<Set<string>>(new Set());

  const [draftClosingDates, setDraftClosingDates] = useState<Record<string, string>>({});
  const [closingDateSaveErrors, setClosingDateSaveErrors] = useState<Record<string, string>>({});

  const getClosingDateInputVal = (g: ProductGroup): string => {
    if (draftClosingDates[g.id] !== undefined) {
      return draftClosingDates[g.id];
    }
    return g.closing_date || '';
  };

  const handleCommitClosingDate = async (groupId: string, rawVal: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    const currentVal = group.closing_date || '';
    if (rawVal.trim() === currentVal.trim()) {
      setClosingDateSaveErrors(prev => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
      setDraftClosingDates(prev => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
      return;
    }

    const normalized = rawVal.trim() === '' ? '' : normalizeDateInput(rawVal);
    if (normalized === null) {
      // Keep in draft for incomplete inputs, do not sync, do not alert
      console.log(`[Date Input] incomplete/invalid input ignored: ${rawVal}`);
      return;
    }

    setClosingDateSaveErrors(prev => {
      const next = { ...prev };
      delete next[groupId];
      return next;
    });
    try {
      const saved = await handleUpdateGroupField(groupId, 'closing_date', normalized);
      if (!saved) {
        setClosingDateSaveErrors(prev => ({ ...prev, [groupId]: '儲存未完成，請重新載入後再試' }));
      }
    } catch (error) {
      console.error('[PurchaseRecords] Failed to save closing date:', error);
      setClosingDateSaveErrors(prev => ({ ...prev, [groupId]: '儲存失敗，請重試' }));
    }
  };

  const handleCancelClosingDateDraft = (groupId: string) => {
    setDraftClosingDates(prev => {
      const next = { ...prev };
      delete next[groupId];
      return next;
    });
  };

  const handleUpdateDraft = (groupId: string, platform: 'myacg' | 'waca' | 'purchased', value: string) => {
    setDraftDemands(prev => ({
      ...prev,
      [`${groupId}_${platform}`]: value
    }));
  };

  const handleCommitDraft = async (groupId: string, platform: 'myacg' | 'waca' | 'purchased') => {
    const key = `${groupId}_${platform}`;
    if (cancelledDemandCommitKeysRef.current.delete(key)) return;
    if (pendingDemandCommitKeysRef.current.has(key)) return;
    const valStr = draftDemands[key];
    if (valStr !== undefined) {
      const val = parseInt(valStr, 10) || 0;
      pendingDemandCommitKeysRef.current.add(key);
      setPendingDemandCommits(new Set(pendingDemandCommitKeysRef.current));
      try {
        const saved = await handleUpdateGroupPlatformDemand(groupId, platform, val);
        if (saved) {
          setDraftDemands(prev => {
            // Keep a newer edit if the user changed this field while the save was pending.
            if (prev[key] !== valStr) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
      } finally {
        pendingDemandCommitKeysRef.current.delete(key);
        setPendingDemandCommits(new Set(pendingDemandCommitKeysRef.current));
      }
    }
  };

  const handleCancelDraft = (groupId: string, platform: 'myacg' | 'waca' | 'purchased') => {
    const key = `${groupId}_${platform}`;
    cancelledDemandCommitKeysRef.current.add(key);
    setDraftDemands(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // getDynamicGap() used to re-filter categories/variants (O(variants) work) on every single
  // call, and it's called once per visible row per render. The only part that genuinely needs
  // to be live on every render is the small arithmetic override from `draftDemands` (which
  // changes on every keystroke while inline-editing a demand field) — the underlying "first
  // variant of the group" baseline numbers (myacg/waca/private/purchased/original gap) don't
  // depend on draftDemands at all, so they're precomputed once per group here and only
  // recomputed when the underlying data actually changes.
  const groupV0BaseMap = useMemo(() => {
    try {
      const catGroupMap = new Map(categories.map(c => [c.id, c.product_group_id]));
      const map = new Map<string, { v0: ProductVariant; v0Myacg: number; v0Waca: number; v0Private: number; v0Purchased: number; v0OriginalGap: number }>();

      for (const v of variants) {
        const groupId = v.product_group_id || (v.product_category_id ? catGroupMap.get(v.product_category_id) : undefined);
        if (!groupId || map.has(groupId)) continue;

        const rawMyacgQty = calculateFinalMyacgDemand(v.myacg_item_code || '', inventory, salesOrderItems);
        const localMyacg = (rawMyacgQty >= 0 ? rawMyacgQty : 0) + (v.myacg_manual_adjustment ?? 0);
        const autoMyacg = (v.myacg_auto_quantity !== null && v.myacg_auto_quantity !== undefined && v.myacg_auto_quantity >= 0)
          ? v.myacg_auto_quantity + (v.myacg_manual_adjustment ?? 0)
          : null;
        const rawMyacg = (v.effective_myacg_quantity !== null && v.effective_myacg_quantity !== undefined && v.effective_myacg_quantity >= 0)
          ? v.effective_myacg_quantity + (v.myacg_manual_adjustment ?? 0)
          : (autoMyacg ?? (v as any).myacg_quantity ?? localMyacg);
        const v0Myacg = rawMyacg >= 0 ? rawMyacg : 0;

        const localWaca = (v.waca_auto_quantity ?? 0) + (v.waca_manual_adjustment ?? 0);
        const autoWaca = (v.waca_auto_quantity !== null && v.waca_auto_quantity !== undefined && v.waca_auto_quantity >= 0)
          ? v.waca_auto_quantity + (v.waca_manual_adjustment ?? 0)
          : null;
        const rawWaca = autoWaca ?? (v as any).waca_quantity ?? localWaca;
        const v0Waca = rawWaca >= 0 ? rawWaca : 0;

        const groupPrivateOrderItems = privateOrderItemsByGroupId.get(groupId) ?? [];
        const localPrivate = groupPrivateOrderItems.filter(poi => poi && poi.product_variant_id === v.id).reduce((sum, item) => sum + (item.quantity || 0), 0);
        const v0Private = localPrivate >= 0 ? localPrivate : 0;

        const groupBatchItems = batchItemsByGroupId.get(groupId) ?? [];
        const localPurchased = groupBatchItems.filter(pbi => pbi && pbi.product_variant_id === v.id).reduce((sum, item) => sum + (item.quantity || 0), 0);
        const manualPurchased = v.purchased_manual_adjustment;
        const legacyPurchased = (v as any).ordered_quantity ?? (v as any).ordered_qty;
        let rawPurchased = 0;
        if (typeof manualPurchased === 'number' && manualPurchased > 0) {
          rawPurchased = manualPurchased;
        } else if (localPurchased > 0) {
          rawPurchased = localPurchased;
        } else if (typeof legacyPurchased === 'number' && legacyPurchased > 0) {
          rawPurchased = legacyPurchased;
        }
        const v0Purchased = rawPurchased;

        const v0OriginalDemand = v0Myacg + v0Waca + v0Private;
        const v0OriginalGap = Math.max(v0OriginalDemand - v0Purchased, 0);

        map.set(groupId, { v0: v, v0Myacg, v0Waca, v0Private, v0Purchased, v0OriginalGap });
      }

      return map;
    } catch (err) {
      console.error('[PurchaseRecords] groupV0BaseMap failed:', err);
      logCrash('groupV0BaseMap useMemo', err);
      return new Map<string, { v0: ProductVariant; v0Myacg: number; v0Waca: number; v0Private: number; v0Purchased: number; v0OriginalGap: number }>();
    }
  }, [categories, variants, inventory, salesOrderItems, privateOrderItemsByGroupId, batchItemsByGroupId]);

  const getDynamicGap = (groupId: string, originalGap: number) => {
    const base = groupV0BaseMap.get(groupId);
    if (!base) return originalGap;
    const { v0, v0Myacg, v0Waca, v0Private, v0Purchased, v0OriginalGap } = base;

    // Apply draft overrides to v0 (the only part that needs to be live per-render)
    const draftMyacgKey = `${groupId}_myacg`;
    const draftWacaKey = `${groupId}_waca`;
    const draftPurchasedKey = `${groupId}_purchased`;

    let new_v0_Myacg = v0Myacg;
    if (draftDemands[draftMyacgKey] !== undefined) {
      const draftMyacgVal = parseInt(draftDemands[draftMyacgKey], 10) || 0;
      const myacgWithoutManual = v0Myacg - (v0.myacg_manual_adjustment ?? 0);
      new_v0_Myacg = Math.max(myacgWithoutManual + draftMyacgVal, 0);
    }

    let new_v0_Waca = v0Waca;
    if (draftDemands[draftWacaKey] !== undefined) {
      const draftWacaManual = parseInt(draftDemands[draftWacaKey], 10) || 0;
      const wacaWithoutManual = v0Waca - (v0.waca_manual_adjustment ?? 0);
      new_v0_Waca = Math.max(wacaWithoutManual + draftWacaManual, 0);
    }

    let new_v0_Purchased = v0Purchased;
    if (draftDemands[draftPurchasedKey] !== undefined) {
      new_v0_Purchased = parseInt(draftDemands[draftPurchasedKey], 10) || 0;
    }

    const new_v0_Demand = new_v0_Myacg + new_v0_Waca + v0Private;
    const new_v0_Gap = Math.max(new_v0_Demand - new_v0_Purchased, 0);

    return Math.max(originalGap - v0OriginalGap + new_v0_Gap, 0);
  };

  const [isStale, setIsStale] = useState<boolean>(false);

  console.log(`[UI Render] UI groups count: ${groups.length}`);
  console.log(`[UI Render] UI variants count: ${variants.length}`);

  const { colWidths, handleMouseDown, resetWidths } = useResizableColumns(
    'erp_purchase_records_col_widths',
    DEFAULT_COL_WIDTHS
  );

  const navigate = useNavigate();
  const location = useLocation();

  // Batch edit states and datepicker refs
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [isClearingClosingDates, setIsClearingClosingDates] = useState(false);
  const [showClosingDateWorkbench, setShowClosingDateWorkbench] = useState(false);
  const [closingDateApplyNotice, setClosingDateApplyNotice] = useState<string | null>(null);
  const [batchClosingDate, setBatchClosingDate] = useState('');
  const [batchReleaseMonth, setBatchReleaseMonth] = useState('');

  const closingDateWorkbenchSelection = useMemo(
    () => groups.filter(group => selectedGroupIds.has(group.id)),
    [groups, selectedGroupIds],
  );

  const datePickerRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    if (!closingDateApplyNotice) return undefined;
    const timeoutId = window.setTimeout(() => setClosingDateApplyNotice(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [closingDateApplyNotice]);


  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem('erp_search_term') || '');
  // The heavy group filtering reads this deferred copy instead of searchTerm itself, so the
  // keystroke's own render (which repaints the input) stays cheap and the table catches up in
  // a lower-priority render right after.
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [filterSource, setFilterSource] = useState(() => localStorage.getItem('erp_filter_source') || 'all');
  const [filterType, setFilterType] = useState(() => localStorage.getItem('erp_filter_type') || 'all');
  const [sortMode, setSortMode] = useState(() => localStorage.getItem('erp_sort_mode') || 'closing_urgent');
  const [activeTab, setActiveTab] = useState<'all' | 'c108' | 'hololive' | 'vspo' | 'proxy' | 'other'>(() => {
    const saved = localStorage.getItem('erp_active_tab');
    if (saved === 'all' || saved === 'c108' || saved === 'hololive' || saved === 'vspo' || saved === 'proxy' || saved === 'other') return saved;
    return 'all';
  });

  const [secondaryTab, setSecondaryTab] = useState<'progress' | 'closed' | 'no_closing_date' | 'no_jpy_cost' | 'to_purchase' | 'all'>(() => {
    const saved = localStorage.getItem('erp_active_secondary_tab');
    if (saved === 'progress' || saved === 'closed' || saved === 'no_closing_date' || saved === 'no_jpy_cost' || saved === 'to_purchase' || saved === 'all') return saved;
    return 'progress';
  });
  const [needsPurchaseOnly, setNeedsPurchaseOnly] = useState<boolean>(() => (
    localStorage.getItem('erp_needs_purchase_only') === 'true'
  ));
  const [completedExpanded, setCompletedExpanded] = useState<boolean>(false);

  const normalizeDate = (dateStr: string | undefined | null): string | null => {
    if (!dateStr) return null;
    const clean = dateStr.trim().replace(/\//g, '-');
    const match = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return null;
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const getNormalizedTitle = (title: string): string => {
    if (!title) return '';
    let res = title;
    res = res.replace(/^代理版\s*/, '');
    res = res.replace(/\s+/g, ' ').trim().toLowerCase();
    return res;
  };

  const checkIsGroupClosed = (g: ProductGroup): boolean => {
    const closing = normalizeDate(g.closing_date);
    if (!closing) return false;
    const todayStr = getTodayStr();
    return todayStr > closing;
  };

  const getTodayStr = (): string => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const checkIsGroupOverdue = (g: ProductGroup): boolean => {
    const closing = normalizeDate(g.closing_date);
    if (!closing) return false;
    const todayStr = getTodayStr();
    return closing < todayStr;
  };

  const checkHasNoClosingDate = (g: ProductGroup): boolean => {
    return !g.closing_date || g.closing_date.trim() === '';
  };

  const checkIsToPurchase = (g: ProductGroup): boolean => {
    const closing = normalizeDate(g.closing_date);
    if (!closing) return false;
    const todayStr = getTodayStr();
    if (closing > todayStr) return false;

    // Must match the same per-variant-clamped-then-summed gap logic the UI's own "缺口"
    // column uses (details.gap / details.proxyGap), NOT a sum-then-compare of raw totals --
    // comparing raw totals lets one variant's surplus silently cancel another variant's
    // shortage within the same group, hiding items that still genuinely need purchasing.
    const details = getGroupPlatformDetails(g.id);
    const isProxy = isProxyProduct(g);
    const gap = isProxy ? details.proxyGap : details.gap;

    return gap > 0;
  };

  useEffect(() => {
    localStorage.setItem('erp_search_term', searchTerm);
    localStorage.setItem('erp_filter_source', filterSource);
    localStorage.setItem('erp_filter_type', filterType);
    localStorage.setItem('erp_sort_mode', sortMode);
  }, [searchTerm, filterSource, filterType, sortMode]);

  useEffect(() => {
    localStorage.setItem('erp_active_tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem('erp_active_secondary_tab', secondaryTab);
  }, [secondaryTab]);

  useEffect(() => {
    localStorage.setItem('erp_needs_purchase_only', String(needsPurchaseOnly));
  }, [needsPurchaseOnly]);

  // Restore scroll position saved by navigateToDetail() when returning via the browser Back
  // button. Waits for groups to actually be loaded (and one more frame for the list to paint)
  // before scrolling, and only runs once per mount so later data refreshes don't re-trigger it.
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    if (scrollRestoredRef.current) return;
    if (groups.length === 0) return;

    const saved = sessionStorage.getItem('erp_purchase_records_scroll');
    sessionStorage.removeItem('erp_purchase_records_scroll');
    scrollRestoredRef.current = true;

    if (saved) {
      const y = parseInt(saved, 10);
      if (!isNaN(y)) {
        requestAnimationFrame(() => {
          const scrollEl = document.querySelector('.main-area');
          if (scrollEl) scrollEl.scrollTop = y;
        });
      }
    }
  }, [groups]);

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const tabParam = searchParams.get('tab');
    if (tabParam) {
      if (tabParam === 'all') setActiveTab('all');
      else if (tabParam === 'c108') setActiveTab('c108');
      else if (tabParam === 'hololive') setActiveTab('hololive');
      else if (tabParam === 'vspo') setActiveTab('vspo');
      else if (tabParam === 'agency') setActiveTab('proxy');
      else if (tabParam === 'other') setActiveTab('other');
    }
    const searchParam = searchParams.get('search');
    if (searchParam) {
      setSearchTerm(searchParam);
    }
  }, [location.search, setActiveTab]);

  useEffect(() => {
    const state = location.state as { resetSearch?: number } | null;
    if (state?.resetSearch) {
      setSearchTerm('');
      setFilterSource('all');
      setFilterType('all');
      setActiveTab('all');
      setSecondaryTab('progress');
      setNeedsPurchaseOnly(false);

      // Clear localStorage so the reset persists
      localStorage.setItem('erp_search_term', '');
      localStorage.setItem('erp_filter_source', 'all');
      localStorage.setItem('erp_filter_type', 'all');
      localStorage.setItem('erp_active_tab', 'all');
      localStorage.setItem('erp_active_secondary_tab', 'progress');

      // Replace history to clear state
      navigate(location.pathname + location.search, { replace: true, state: null });
    }
  }, [location.state, location.pathname, location.search, navigate]);


  const [copiedGroupId, setCopiedGroupId] = useState<string | null>(null);
  const handleCopyTitle = async (groupId: string, title: string) => {
    try {
      await navigator.clipboard.writeText(title);
      setCopiedGroupId(groupId);
      setTimeout(() => {
        setCopiedGroupId(current => current === groupId ? null : current);
      }, 1000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const getGroupStatus = (g: ProductGroup) => {
    const isClosed = checkIsGroupClosed(g);
    if (isClosed) {
      return { text: '⚫ 已結單', active: false };
    }
    return { text: '🟢 開單中', active: true };
  };

  // Same story as groupPlatformDetailsMap below: checkIsProxyProduct() used to re-scan the
  // full variants array plus do linear inventory.find()s on every single call, and it's called
  // one-to-several times per group inside baseGroups filtering and the tab counts — i.e.
  // O(groups x variants x inventory) on every search keystroke. The verdict only depends on
  // groups/variants/inventory, so precompute it for every group in one pass (identical logic)
  // and make the check an O(1) map lookup.
  const computeIsProxyProduct = (
    g: ProductGroup,
    groupVars: ProductVariant[],
    findInventoryItem: (code: ProductVariant['myacg_item_code']) => InventoryItem | undefined
  ) => {
    // 1. 優先讀 ProductGroup.listing_type
    if (g.listing_type === '代理版') return true;
    if (g.source_type === '代理版') return true;

    // 2. 如果沒有，從該 ProductGroup 底下的 ProductVariant 對應 InventoryItem 讀 InventoryItem.listing_type
    const hasProxySku = groupVars.some(v => {
      const invItem = findInventoryItem(v.myacg_item_code);
      return invItem?.listing_type === '代理版';
    });
    if (hasProxySku) return true;

    // 3. 商品名稱/規格名稱/InventoryItem名稱是否包含關鍵字
    const keywords = [
      '代理版',
      '代理',
      'gsc',
      'good smile',
      'max factory',
      'furyu',
      '景品',
      'sega',
      'bandai',
      'kotobukiya'
    ];

    const matchText = (text: string | undefined | null) => {
      if (!text) return false;
      const lower = text.toLowerCase();
      return keywords.some(kw => lower.includes(kw));
    };

    if (matchText(g.title) || matchText(g.normalized_title)) return true;

    const matchVar = groupVars.some(v => 
      matchText(v.variant_name) || 
      matchText(v.raw_variant_name) || 
      matchText(v.product_title)
    );
    if (matchVar) return true;

    const matchInv = groupVars.some(v => {
      const invItem = findInventoryItem(v.myacg_item_code);
      return matchText(invItem?.product_title) || matchText(invItem?.raw_variant_name);
    });
    if (matchInv) return true;

  };

  const isProxyProductMap = useMemo(() => {
    // groupVars here intentionally uses product_group_id only (no category mapping), matching
    // the original variants.filter() inside checkIsProxyProduct. Inventory is indexed by item
    // code keeping the FIRST item per code, mirroring inventory.find()'s first-match semantics.
    const varsByGroup = new Map<string, ProductVariant[]>();
    for (const v of variants) {
      if (!v.product_group_id) continue;
      const arr = varsByGroup.get(v.product_group_id);
      if (arr) arr.push(v); else varsByGroup.set(v.product_group_id, [v]);
    }
    const invByCode = new Map<InventoryItem['myacg_item_code'], InventoryItem>();
    for (const item of inventory) {
      if (!invByCode.has(item.myacg_item_code)) invByCode.set(item.myacg_item_code, item);
    }
    const map = new Map<string, boolean>();
    for (const g of groups) {
      map.set(g.id, !!computeIsProxyProduct(g, varsByGroup.get(g.id) ?? [], code => invByCode.get(code)));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, variants, inventory]);

  const checkIsProxyProduct = (g: ProductGroup) => {
    const cached = isProxyProductMap.get(g.id);
    if (cached !== undefined) return cached;
    // Group not in the memoized list (e.g. freshly created and not yet in `groups`) — fall
    // back to the original direct scan so behavior is identical.
    return !!computeIsProxyProduct(
      g,
      variants.filter(v => v.product_group_id === g.id),
      code => inventory.find(i => i.myacg_item_code === code)
    );
  };

  const normalizeForMatch = (text: string | undefined | null): string => {
    if (!text) return '';
    return text
      .toLowerCase()
      .replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
  };

  const isProxyProduct = (g: ProductGroup) => {
    return !!checkIsProxyProduct(g);
  };

  const isC108Product = (g: ProductGroup) => {
    const titleNorm = normalizeForMatch(g.title?.normalize('NFKC'));
    const normTitleNorm = normalizeForMatch(g.normalized_title?.normalize('NFKC'));
    return titleNorm.includes('c108') || normTitleNorm.includes('c108');
  };

  // C108 is the highest-priority display category. A C108 group must not also
  // appear under Hololive, VSPO, proxy, or other category tabs.
  const isProxyCategoryProduct = (g: ProductGroup) => {
    return !isC108Product(g) && isProxyProduct(g);
  };

  const isHololiveProduct = (g: ProductGroup) => {
    if (isC108Product(g) || isProxyProduct(g)) return false;
    const titleNorm = normalizeForMatch(g.title);
    const normTitleNorm = normalizeForMatch(g.normalized_title);
    return titleNorm.includes('hololive') || normTitleNorm.includes('hololive');
  };

  const isVspoProduct = (g: ProductGroup) => {
    if (isC108Product(g) || isProxyProduct(g)) return false;
    const titleNorm = normalizeForMatch(g.title);
    const normTitleNorm = normalizeForMatch(g.normalized_title);
    return titleNorm.includes('vspo') || titleNorm.includes('ぶいすぽ') || 
           normTitleNorm.includes('vspo') || normTitleNorm.includes('ぶいすぽ');
  };

  const isOtherProduct = (g: ProductGroup) => {
    return !isC108Product(g) && !isProxyProduct(g) && !isHololiveProduct(g) && !isVspoProduct(g);
  };

  // Both getGroupPlatformDetails() and getGroupDemandAndPurchased() used to re-filter/re-sum
  // the full variants array from scratch on every single call (once per group in filtering
  // logic, once per row per render in every table). With hundreds of groups/variants and
  // several call sites per render, this was O(groups x variants) work repeated on every
  // re-render (including the ~60/sec re-renders a column-resize drag used to trigger).
  // Precompute all groups' aggregates in a single O(variants) pass here, memoized on the
  // underlying data, so both helpers below become plain O(1) map lookups.
  const groupPlatformDetailsMap = useMemo(() => {
    try {
      const catGroupMap = new Map(categories.map(c => [c.id, c.product_group_id]));
      type Agg = { myacg: number; waca: number; privateOrder: number; purchased: number; gap: number; proxyGap: number; myacgManual: number; wacaManual: number; hasCatalogMissing: boolean };
      const acc = new Map<string, Agg>();

      for (const v of variants) {
        const groupId = v.product_group_id || (v.product_category_id ? catGroupMap.get(v.product_category_id) : undefined);
        if (!groupId) continue;

        let entry = acc.get(groupId);
        if (!entry) {
          entry = { myacg: 0, waca: 0, privateOrder: 0, purchased: 0, gap: 0, proxyGap: 0, myacgManual: 0, wacaManual: 0, hasCatalogMissing: false };
          acc.set(groupId, entry);
        }

        const groupBatchItems = batchItemsByGroupId.get(groupId) ?? [];
        const groupPrivateOrderItems = privateOrderItemsByGroupId.get(groupId) ?? [];
        const res = calculateVariantDemandAndPurchased(v, groupPrivateOrderItems, groupBatchItems, inventory, salesOrderItems);
        entry.myacg += res.myacg;
        entry.waca += res.waca;
        entry.privateOrder += res.privateOrder;
        entry.purchased += res.purchased;
        entry.myacgManual += (v.myacg_manual_adjustment ?? 0);
        entry.wacaManual += (v.waca_manual_adjustment ?? 0);
        entry.gap += res.gap;

        const proxyDemand = res.myacg + (v.waca_manual_adjustment ?? 0) + res.privateOrder;
        entry.proxyGap += Math.max(proxyDemand - res.purchased, 0);

        if (v.catalog_missing === true) entry.hasCatalogMissing = true;
      }

      return acc;
    } catch (err) {
      console.error('[PurchaseRecords] groupPlatformDetailsMap build failed:', err);
      logCrash('groupPlatformDetailsMap useMemo', err);
      return new Map<string, { myacg: number; waca: number; privateOrder: number; purchased: number; gap: number; proxyGap: number; myacgManual: number; wacaManual: number; hasCatalogMissing: boolean }>();
    }
  }, [categories, variants, privateOrderItemsByGroupId, batchItemsByGroupId, inventory, salesOrderItems]);

  const EMPTY_GROUP_DETAILS = { myacg: 0, waca: 0, privateOrder: 0, purchased: 0, gap: 0, proxyGap: 0, myacgManual: 0, wacaManual: 0, hasCatalogMissing: false };

  const getGroupPlatformDetails = (groupId: string) => {
    return groupPlatformDetailsMap.get(groupId) || EMPTY_GROUP_DETAILS;
  };

  const getGroupDemandAndPurchased = (groupId: string) => {
    const d = getGroupPlatformDetails(groupId);
    return { demand: d.myacg + d.waca + d.privateOrder, purchased: d.purchased, gap: d.gap, hasCatalogMissing: d.hasCatalogMissing };
  };

  // Same story as above: this used to re-filter categories/variants/inventory from scratch
  // on every call. Precompute per group once; inventory is bucketed by SKU up front so the
  // price lookup is O(matches) instead of O(inventory) per group.
  const groupSkuAndPriceRangeMap = useMemo(() => {
    const catGroupMap = new Map(categories.map(c => [c.id, c.product_group_id]));
    const groupVarsMap = new Map<string, ProductVariant[]>();
    for (const v of variants) {
      const groupId = v.product_group_id || (v.product_category_id ? catGroupMap.get(v.product_category_id) : undefined);
      if (!groupId) continue;
      const arr = groupVarsMap.get(groupId);
      if (arr) arr.push(v); else groupVarsMap.set(groupId, [v]);
    }

    const inventoryByCode = new Map<string, InventoryItem[]>();
    for (const item of inventory) {
      const arr = inventoryByCode.get(item.myacg_item_code);
      if (arr) arr.push(item); else inventoryByCode.set(item.myacg_item_code, [item]);
    }

    const map = new Map<string, { skuDisplay: string; priceDisplay: string; count: number }>();
    for (const [groupId, groupVars] of groupVarsMap.entries()) {
      const skus = Array.from(new Set(groupVars.map(v => v.myacg_item_code).filter(Boolean)));
      const baseSkus = Array.from(new Set(skus.map(code => getBaseSku(code))));
      const skuDisplay = baseSkus.length > 0 ? baseSkus.slice(0, 2).join(', ') + (baseSkus.length > 2 ? '...' : '') : '無SKU';

      // Matches the original's unfiltered/undeduped itemCodes.includes(...) semantics.
      const codesToCheck = Array.from(new Set(groupVars.map(v => v.myacg_item_code)));
      const prices: number[] = [];
      for (const code of codesToCheck) {
        const items = inventoryByCode.get(code);
        if (!items) continue;
        for (const item of items) {
          if (item.final_price !== undefined && item.final_price !== null) prices.push(item.final_price);
        }
      }
      let priceDisplay = '';
      if (prices.length > 0) {
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        priceDisplay = minPrice === maxPrice ? `¥${minPrice.toLocaleString()}` : `¥${minPrice.toLocaleString()} - ¥${maxPrice.toLocaleString()}`;
      } else {
        priceDisplay = '無價格';
      }

      map.set(groupId, { skuDisplay, priceDisplay, count: groupVars.length });
    }
    return map;
  }, [categories, variants, inventory]);

  const EMPTY_SKU_PRICE_RANGE = { skuDisplay: '無SKU', priceDisplay: '無價格', count: 0 };

  const getGroupSkuAndPriceRange = (groupId: string) => {
    return groupSkuAndPriceRangeMap.get(groupId) || EMPTY_SKU_PRICE_RANGE;
  };

  const getClosingDateStyle = (closingDate: string | undefined | null) => {
    if (!closingDate) return { text: '-', color: '#64748b', fontWeight: 400 };
    
    const todayStr = getTodayStr();
    const closing = normalizeDate(closingDate);
    if (!closing) {
      return { text: closingDate, color: '#334155', fontWeight: 500 };
    }
    if (closing < todayStr) {
      return { text: closingDate, color: '#ef4444', fontWeight: 700 };
    }
    
    const todayTime = new Date(todayStr).getTime();
    const closingTime = new Date(closing).getTime();
    const diffDays = Math.ceil((closingTime - todayTime) / (1000 * 60 * 60 * 24));
    
    if (diffDays >= 0 && diffDays <= 3) {
      return { text: closingDate, color: '#f97316', fontWeight: 700 };
    }
    
    return { text: closingDate, color: '#334155', fontWeight: 500 };
  };

  // The search and secondary filters share one group → variants index. It is rebuilt only
  // when catalog data changes, not for every search query or displayed row.
  const searchIndex = useMemo(() => {
    try {
      return { varsByGroup: buildVariantsByGroup(categories, variants) };
    } catch (err) {
      console.error('[PurchaseRecords] searchIndex build failed:', err);
      logCrash('searchIndex useMemo', err);
      return { varsByGroup: new Map<string, ProductVariant[]>() };
    }
  }, [variants, categories]);

  // Build normalized searchable fields only when catalog data changes. Raw keystrokes update
  // the controlled input immediately; the deferred query below only performs one O(groups)
  // pass over these prepared documents instead of lowercasing and traversing variants and
  // categories again for every candidate group.
  const purchaseRecordSearchDocuments = useMemo(
    () => buildPurchaseRecordSearchDocuments(groups, categories, variants, isProxyProductMap),
    [categories, groups, isProxyProductMap, variants],
  );

  const baseGroups = useMemo(() => {
    try {
      let result = [...groups];

      // Filter by activeTab
      if (activeTab === 'c108') {
        result = result.filter(g => isC108Product(g));
      } else if (activeTab === 'hololive') {
        result = result.filter(g => isHololiveProduct(g));
      } else if (activeTab === 'vspo') {
        result = result.filter(g => isVspoProduct(g));
      } else if (activeTab === 'proxy') {
        result = result.filter(g => isProxyCategoryProduct(g));
      } else if (activeTab === 'other') {
        result = result.filter(g => isOtherProduct(g));
      }

      // 1. Filter Source
      if (filterSource !== 'all') {
        result = result.filter(g => {
          if (filterSource === '代理商品') return isProxyProduct(g);
          if (filterSource === 'Hololive') return isHololiveProduct(g);
          if (filterSource === 'VSPO') return isVspoProduct(g);
          return false;
        });
      }

      // 2. Filter Type
      if (filterType !== 'all') {
        result = result.filter(g => {
          if (filterType === '代理版') return checkIsProxyProduct(g);
          return (g.listing_type || '一般預購') === filterType;
        });
      }

      // 3. Search
      if (deferredSearchTerm.trim()) {
        const lowerTerm = deferredSearchTerm.toLowerCase();
        result = result.filter(g => {
          try {
            return purchaseRecordMatchesSearch(purchaseRecordSearchDocuments.get(g.id), lowerTerm);
          } catch {
            return true;
          }
        });
      }

      return result;
    } catch (err) {
      console.error('[PurchaseRecords] baseGroups filter failed:', err);
      logCrash('baseGroups useMemo', err);
      return [...groups];
    }
    // Classification helpers are pure projections of groups/isProxyProductMap and are
    // intentionally represented by those stable data dependencies rather than function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, deferredSearchTerm, filterSource, filterType, activeTab, isProxyProductMap, purchaseRecordSearchDocuments]);

  const checkHasMissingJpyCost = (g: ProductGroup): boolean => {
    if (isProxyProduct(g)) return false;
    const groupVars = searchIndex.varsByGroup.get(g.id) ?? [];
    return groupVars.some(v => v.default_jpy_cost === null || v.default_jpy_cost === undefined);
  };

  const checkNeedsPurchase = (g: ProductGroup): boolean => {
    const details = getGroupPlatformDetails(g.id);
    const existingGap = isProxyProduct(g) ? details.proxyGap : details.gap;
    return existingGap > 0;
  };

  const { progressCount, closedCount, noClosingDateCount, missingJpyCostCount, allCount, toPurchaseCount, needsPurchaseCount } = useMemo(() => {
    const progress = baseGroups.filter(g => !checkIsGroupClosed(g)).length;
    const closed = baseGroups.filter(g => checkIsGroupClosed(g)).length;
    const noClosingDate = baseGroups.filter(g => checkHasNoClosingDate(g)).length;
    const missingJpyCost = baseGroups.filter(g => checkHasMissingJpyCost(g)).length;
    const total = baseGroups.length;
    const toPurchase = baseGroups.filter(g => checkIsToPurchase(g)).length;
    const needsPurchase = baseGroups.filter(g => checkNeedsPurchase(g)).length;
    return { progressCount: progress, closedCount: closed, noClosingDateCount: noClosingDate, missingJpyCostCount: missingJpyCost, allCount: total, toPurchaseCount: toPurchase, needsPurchaseCount: needsPurchase };
  }, [baseGroups]);

  const completedGroups = useMemo(() => {
    try {
    if (secondaryTab !== 'progress') return [];

    let result = baseGroups.filter(g => {
      if (checkIsGroupClosed(g)) return false;
      return checkIsGroupOverdue(g);
    });

    if (needsPurchaseOnly) {
      result = result.filter(g => checkNeedsPurchase(g));
    }

    result.sort((a, b) => {
      if (sortMode === 'release_asc') {
        const ra = parseReleaseYm(a.release_month);
        const rb = parseReleaseYm(b.release_month);
        if (ra.tier !== rb.tier) return ra.tier - rb.tier;
        if (ra.tier === 1 && ra.ym !== rb.ym) return ra.ym - rb.ym;
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateComp = dateA.localeCompare(dateB);
        if (dateComp !== 0) return dateComp;
        const titleA = getNormalizedTitle(a.normalized_title || a.title || '');
        const titleB = getNormalizedTitle(b.normalized_title || b.title || '');
        return titleA.localeCompare(titleB);
      } else if (sortMode === 'closing_urgent') {
        const activeA = !checkIsGroupClosed(a);
        const activeB = !checkIsGroupClosed(b);
        if (activeA !== activeB) return activeA ? -1 : 1;
        
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        return dateA.localeCompare(dateB);
      } else if (sortMode === 'closing_name') {
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateComp = dateA.localeCompare(dateB);
        if (dateComp !== 0) return dateComp;
        
        const titleA = getNormalizedTitle(a.normalized_title || a.title || '');
        const titleB = getNormalizedTitle(b.normalized_title || b.title || '');
        return titleA.localeCompare(titleB);
      } else if (sortMode === 'closing_asc') {
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        return dateA.localeCompare(dateB);
      } else {
        const timeA = new Date(a.created_at || 0).getTime();
        const timeB = new Date(b.created_at || 0).getTime();
        return timeB - timeA;
      }
    });

    return result;
    } catch (err) {
      console.error('[PurchaseRecords] completedGroups failed:', err);
      logCrash('completedGroups useMemo', err);
      return [];
    }
  }, [baseGroups, secondaryTab, sortMode, needsPurchaseOnly]);

  const filteredAndSortedGroups = useMemo(() => {
    try {
    let result = [...baseGroups];

    if (secondaryTab === 'progress') {
      result = result.filter(g => {
        if (checkIsGroupClosed(g)) return false;
        
        // Overdue items go to the bottom section
        const isOverdue = checkIsGroupOverdue(g);
        if (isOverdue) {
          return false;
        }
        
        return true;
      });
    } else if (secondaryTab === 'closed') {
      result = result.filter(g => checkIsGroupClosed(g));
    } else if (secondaryTab === 'no_closing_date') {
      result = result.filter(g => checkHasNoClosingDate(g));
    } else if (secondaryTab === 'no_jpy_cost') {
      result = result.filter(g => checkHasMissingJpyCost(g));
    } else if (secondaryTab === 'to_purchase') {
      result = result.filter(g => checkIsToPurchase(g));
    }

    if (needsPurchaseOnly) {
      result = result.filter(g => checkNeedsPurchase(g));
    }

    // Sort
    result.sort((a, b) => {
      if (sortMode === 'release_asc') {
        const ra = parseReleaseYm(a.release_month);
        const rb = parseReleaseYm(b.release_month);
        if (ra.tier !== rb.tier) return ra.tier - rb.tier;
        if (ra.tier === 1 && ra.ym !== rb.ym) return ra.ym - rb.ym;
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateComp = dateA.localeCompare(dateB);
        if (dateComp !== 0) return dateComp;
        const titleA = getNormalizedTitle(a.normalized_title || a.title || '');
        const titleB = getNormalizedTitle(b.normalized_title || b.title || '');
        return titleA.localeCompare(titleB);
      } else if (sortMode === 'closing_urgent') {
        const activeA = !checkIsGroupClosed(a);
        const activeB = !checkIsGroupClosed(b);
        
        if (activeA !== activeB) {
          return activeA ? -1 : 1;
        }
        
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        return dateA.localeCompare(dateB);
      } else if (sortMode === 'closing_name') {
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateComp = dateA.localeCompare(dateB);
        if (dateComp !== 0) return dateComp;
        
        const titleA = getNormalizedTitle(a.normalized_title || a.title || '');
        const titleB = getNormalizedTitle(b.normalized_title || b.title || '');
        return titleA.localeCompare(titleB);
      } else if (sortMode === 'closing_asc') {
        const dateA = a.closing_date ? a.closing_date.replace(/\//g, '-') : '9999-12-31';
        const dateB = b.closing_date ? b.closing_date.replace(/\//g, '-') : '9999-12-31';
        return dateA.localeCompare(dateB);
      } else {
        const timeA = new Date(a.created_at || 0).getTime();
        const timeB = new Date(b.created_at || 0).getTime();
        return timeB - timeA;
      }
    });

    return result;
    } catch (err) {
      console.error('[PurchaseRecords] filteredAndSortedGroups failed:', err);
      logCrash('filteredAndSortedGroups useMemo', err);
      return [];
    }
  }, [baseGroups, secondaryTab, sortMode, needsPurchaseOnly]);

  const [stableEditOrder, setStableEditOrder] = useState<string[] | null>(null);
  const [stableCompletedOrder, setStableCompletedOrder] = useState<string[] | null>(null);

  const captureCurrentEditView = () => {
    const snapshot = capturePurchaseRecordsEditView(filteredAndSortedGroups, completedGroups);
    setStableEditOrder(snapshot.mainGroupIds);
    setStableCompletedOrder(snapshot.completedGroupIds);
  };

  const toggleEditMode = () => {
    if (editMode) {
      setEditMode(false);
      setStableEditOrder(null);
      setStableCompletedOrder(null);
      setDraftClosingDates({});
      setClosingDateSaveErrors({});
      return;
    }

    captureCurrentEditView();
    setEditMode(true);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (editMode) captureCurrentEditView();
  }, [searchTerm, filterSource, filterType, activeTab, secondaryTab, sortMode, needsPurchaseOnly]);



  const displayedMainGroups = useMemo(() => {
    if (editMode && stableEditOrder) {
      return resolvePurchaseRecordsEditView(stableEditOrder, groups);
    }
    return filteredAndSortedGroups;
  }, [editMode, stableEditOrder, filteredAndSortedGroups, groups]);

  const displayedCompletedGroups = useMemo(() => {
    if (editMode && stableCompletedOrder) {
      return resolvePurchaseRecordsEditView(stableCompletedOrder, groups);
    }
    return completedGroups;
  }, [editMode, stableCompletedOrder, completedGroups, groups]);

  useEffect(() => {
    if (searchTerm.trim().length > 0) {
      if (completedGroups.length > 0) {
        setCompletedExpanded(true);
      }
    } else {
      setCompletedExpanded(false);
    }
  }, [searchTerm, completedGroups.length]);

  useEffect(() => {
    loadData();
  }, []);

  const loadGeneration = useRef(0);
  useEffect(() => () => { loadGeneration.current += 1; }, []);
  const loadData = async () => {
    const generation = ++loadGeneration.current;
    // Stale-while-revalidate: if the local IndexedDB cache already has data (from a previous
    // visit), show it immediately instead of a blank "0 筆" table while the real cloud sync —
    // which can take several seconds — is still in flight. This reads straight from the local
    // adapter (no Supabase call), so it resolves near-instantly. The real fetch below always
    // still runs afterwards and is what actually gets persisted into state/localStorage as
    // before; this is purely an early, possibly-stale preview.
    try {
      const directCache = ['cloud', 'fallback'].includes(getProviderMode()) ? cloudCacheDb : localDb;
      const cachedGroups = await directCache.getProductGroups();
      if (cachedGroups.length > 0) {
        const [cachedVars, cachedCats, cachedBatches, cachedBatchItems, cachedPrivateOrders, cachedPrivateItems, cachedInventory, cachedOrderItems] = await Promise.all([
          directCache.getProductVariants(),
          directCache.getProductCategories(),
          directCache.getPurchaseBatches(),
          directCache.getPurchaseBatchItems(),
          directCache.getPrivateOrders(),
          directCache.getPrivateOrderItems(),
          directCache.getInventory(),
          directCache.getSalesOrderItems()
        ]);
        const cachedMeta = cachedGroups.find(g => g.id === WACA_META_ID) || null;
        if (generation !== loadGeneration.current) return;
        setWacaMeta(cachedMeta);
        setGroups(cachedGroups.filter(g => g.id !== WACA_META_ID));
        setVariants(cachedVars);
        setCategories(cachedCats);
        setBatches(cachedBatches);
        setBatchItems(cachedBatchItems);
        setPrivateOrders(cachedPrivateOrders);
        setPrivateOrderItems(cachedPrivateItems);
        setInventory(cachedInventory);
        setSalesOrderItems(cachedOrderItems);
        setIsInitialLoading(false);
        setIsSyncing(true);
      }
    } catch (e) {
      console.warn('[UI Load] Failed to read local cache for instant preview, falling back to normal load', e);
    }

    // Guaranteed cleanup: even if the real fetch below throws, we must clear the loading
    // flags so the UI never gets stuck showing the loading screen (or the "syncing" badge)
    // forever. The error itself is intentionally NOT swallowed here — it still propagates
    // as an unhandled rejection afterwards, same as before this change.
    try {
      if (generation !== loadGeneration.current) return;
      await loadFreshData();
    } finally {
      setIsInitialLoading(false);
      setIsSyncing(false);
    }
  };

  const loadFreshData = async () => {
    const generation = ++loadGeneration.current;
    const [fetchedGroups, fetchedVars, fetchedCats, fetchedBatches, fetchedBatchItems, fetchedPrivateOrders, fetchedPrivateItems, fetchedInventory, fetchedOrderItems] = await Promise.all([
      dataProvider.getProductGroups(),
      dataProvider.getProductVariants(),
      dataProvider.getProductCategories(),
      dataProvider.getPurchaseBatches(),
      dataProvider.getPurchaseBatchItems(),
      dataProvider.getPrivateOrders(),
      dataProvider.getPrivateOrderItems(),
      dataProvider.getInventory(),
      dataProvider.getSalesOrderItems()
    ]);
    if (generation !== loadGeneration.current) return;
    console.log(`[UI Load] UI groups count: ${fetchedGroups.length}`);
    console.log(`[UI Load] UI variants count: ${fetchedVars.length}`);
    console.log('[UI Load] variants sample:', fetchedVars.length > 0 ? JSON.stringify(fetchedVars[0]) : 'empty');
    
    // Product Groups are the sole source of truth for proxy_agent. The retired
    // erp_proxy_agent_map key is deliberately ignored and left untouched.
    const finalGroups = fetchedGroups;

    const meta = finalGroups.find(g => g.id === WACA_META_ID) || null;
    setWacaMeta(meta);
    const regularGroups = finalGroups.filter(g => g.id !== WACA_META_ID);
    
    setGroups(regularGroups);
    setVariants(fetchedVars);
    setCategories(fetchedCats);
    setBatches(fetchedBatches);
    setBatchItems(fetchedBatchItems);
    setPrivateOrders(fetchedPrivateOrders);
    setPrivateOrderItems(fetchedPrivateItems);
    setInventory(fetchedInventory);
    setSalesOrderItems(fetchedOrderItems);
    dataProvider.registerFreshLoad();
  };

  const { refreshAuthoritative } = useCloudResourceSync(
    'purchase-records',
    ['products', 'purchases', 'privateOrders', 'inventory', 'salesOrders'],
    Object.keys(draftDemands).length > 0 || Object.keys(draftClosingDates).length > 0
      || showWacaDialog || showClosingDateWorkbench,
    loadFreshData,
    showWacaDialog || showClosingDateWorkbench ? undefined : {
      kind: 'groups',
      ids: [...new Set([
        ...Object.keys(draftDemands).map(key => key.replace(/_(myacg|waca|purchased)$/, '')),
        ...Object.keys(draftClosingDates),
        ...selectedGroupIds,
      ])],
    },
    { rereadProtectedCacheWhileEditing: true },
  );

  const handleUpdateWacaMeta = async (updatedBy: string) => {
    if (guardAgainstStaleWrite()) return;
    
    const nowStr = new Date().toISOString();
    
    const wacaMetaId = WACA_META_ID;
    const allGroups = await dataProvider.getProductGroups();
    const existingMeta = allGroups.find(g => g.id === wacaMetaId);
    
    let updatedMeta: ProductGroup;
    if (existingMeta) {
      updatedMeta = {
        ...existingMeta,
        proxy_agent: updatedBy,
        closing_date: nowStr,
        updated_at: new Date().toISOString()
      };
    } else {
      updatedMeta = {
        id: wacaMetaId,
        title: 'WACA_UPDATE_METADATA_DO_NOT_DELETE',
        purchase_date: new Date().toISOString().split('T')[0],
        priority: 'Low',
        closing_date: nowStr,
        release_month: '',
        has_official_site: false,
        product_url: '',
        proxy_agent: updatedBy,
        show_in_purchase_list: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }
    
    const newAllGroups = [...allGroups.filter(g => g.id !== wacaMetaId), updatedMeta];
    
    try {
      await dataProvider.saveProductGroups(newAllGroups);
      setWacaMeta(updatedMeta);
      closeWacaDialog();
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      throw err;
    }
  };

  const guardAgainstStaleWrite = (): boolean => {
    const liveStale = dataProvider.checkIsStaleLive();
    if (isStale || liveStale) {
      alert('資料已在其他分頁更新，請重新載入最新資料後再編輯。');
      return true; // blocked
    }
    return false; // allowed
  };

  useEffect(() => {
    const unsubscribe = dataProvider.onStaleChange(setIsStale);
    setIsStale(dataProvider.checkIsStaleLive());
    return unsubscribe;
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showWacaDialog) {
        closeWacaDialog();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showWacaDialog]);

  const handleUpdateGroupField = async (groupId: string, field: string, value: any) => {
    if (guardAgainstStaleWrite()) return false;
    if (!['purchase_date', 'closing_date', 'release_month', 'product_url'].includes(field)) {
      return false;
    }
    if (field === 'closing_date') {
      setDraftClosingDates(prev => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
    }
    let processedValue = value;
    if ((field === 'closing_date' || field === 'purchase_date') && typeof value === 'string') {
      processedValue = value.replace(/-/g, '/');
    }
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return { ...g, [field]: processedValue } as ProductGroup;
      }
      return g;
    });
    setGroups(updatedGroups);
    try {
      await dataProvider.saveProductGroups(updatedGroups);
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return false;
      }
      throw err;
    }
    return true;
  };

  const applyCloudClosingDateSelections = useCallback(async (request: ClosingDateWorkbenchApplyRequest) => {
    const { applyCloudClosingDateResolutionBatch } = await import('../lib/cloudClosingDateWorkbenchApply');
    return applyCloudClosingDateResolutionBatch(request.resolutionBatch, request.selections);
  }, []);

  const handleBatchApply = async () => {
    if (guardAgainstStaleWrite()) return;
    if (selectedGroupIds.size === 0) {
      alert('請先選取商品項目！');
      return;
    }
    if (!batchClosingDate.trim() && !batchReleaseMonth.trim()) {
      alert('請填寫欲批次套用的官方結單日或發售月份！');
      return;
    }

    const confirmMsg = `您即將批次更新 ${selectedGroupIds.size} 筆商品群組的日期資訊，是否確認？`;
    if (!window.confirm(confirmMsg)) return;

    let finalBatchClosingDate = '';
    if (batchClosingDate.trim()) {
      const normalized = normalizeDateInput(batchClosingDate);
      if (!normalized) {
        alert('官方結單日格式不正確，請輸入正確的日期格式 (例如 10/5、2026-10-05)！');
        return;
      }
      finalBatchClosingDate = normalized.replace(/-/g, '/');
    }

    const updatedGroups = groups.map(g => {
      if (selectedGroupIds.has(g.id)) {
        const nextGroup = { ...g };
        if (finalBatchClosingDate) {
          nextGroup.closing_date = finalBatchClosingDate;
        }
        if (batchReleaseMonth.trim()) {
          nextGroup.release_month = batchReleaseMonth.trim();
        }
        return nextGroup;
      }
      return g;
    });

    setGroups(updatedGroups);
    try {
      await dataProvider.saveProductGroups(updatedGroups);
      setSelectedGroupIds(new Set());
      setBatchClosingDate('');
      setBatchReleaseMonth('');
      alert('批次更新完成！');
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      throw err;
    }
  };

  const [isLookingUpDeadlines, setIsLookingUpDeadlines] = useState(false);
  const [lookupDiagnostics, setLookupDiagnostics] = useState<LookupDiagnostic[]>([]);

  const handleAutoLookupDeadlines = async () => {
    if (guardAgainstStaleWrite()) return;

    type ProductSource = 'proxy' | 'hololive' | 'vspo';
    type LookupResult = {
      closing_date?: string;
      release_month?: string;
      productUrl?: string;
      matchName?: string;
      score: number;
      failureReason?: string;
      identityVerified?: boolean;
      diagnostic?: LookupDiagnostic;
    };
    const getSource = (g: ProductGroup): ProductSource | null => {
      if (isProxyProduct(g)) return 'proxy';
      if (isHololiveProduct(g)) return 'hololive';
      if (isVspoProduct(g)) return 'vspo';
      return null;
    };

    const targetGroups = groups.filter(g =>
      selectedGroupIds.has(g.id) &&
      getSource(g) !== null &&
      (!g.closing_date || (getSource(g) !== 'proxy' && !g.product_url))
    );

    if (targetGroups.length === 0) {
      alert('選取的商品中沒有需要查詢結單日的商品（已有結單日且官網網址的會跳過）。');
      return;
    }

    setIsLookingUpDeadlines(true);
    setLookupDiagnostics([]);
    let matched = 0;
    let failed = 0;
    const details: string[] = [];
    const diagnostics: LookupDiagnostic[] = [];
    const updatedGroups = [...groups];

    const stripShopTitle = (t: string) => t
      .replace(/^(在庫|通販)\s*/g, '')
      .replace(/^(Hololive|hololive|VSPO|ぶいすぽっ！?)\s*/gi, '')
      .replace(/(合作|原創|透明|文件夾|兩款一套|兩款|一套|全套|套裝|追加販售|販售|周邊|假期周邊|第[一二三四五六七八九十]彈)\s*/g, '')
      .replace(/\s*商品$/g, '')
      .replace(/[【】「」《》（）\(\)！!？?×]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const shopMatchScore = (catalogName: string, originalTitle: string, strippedSegments: string[]) => {
      const catalogLower = catalogName.toLowerCase();
      const originalLower = originalTitle.toLowerCase();
      const catalogCompact = catalogLower.replace(/\s+/g, '');
      if (strippedSegments.length === 0) return 0;
      let hits = 0;
      for (const word of strippedSegments) {
        const lower = word.toLowerCase();
        if (catalogLower.includes(lower) || catalogCompact.includes(lower.replace(/\s+/g, ''))) hits += 1;
      }
      let score = hits / strippedSegments.length;
      const scalePattern = /(\d\/\d+)/;
      const originalScale = originalLower.match(scalePattern)?.[1];
      const catalogScale = catalogLower.match(scalePattern)?.[1];
      if (originalScale && catalogScale && originalScale !== catalogScale) return 0;
      if (originalScale && !catalogScale) score *= 0.3;
      if (!originalScale && catalogScale) score *= 0.7;

      const mismatchTypes = ['泡麵蓋', '絨毛', '胸針', '鍵帽', '盲盒', '抱枕', '壓克力', '掛件', '徽章', '公仔', '吊飾'];
      for (const productType of mismatchTypes) {
        if (catalogLower.includes(productType) && !originalLower.includes(productType)) {
          score *= 0.3;
          break;
        }
      }

      const tail = strippedSegments.slice(Math.max(0, strippedSegments.length - 2));
      const tailHits = tail.filter(word => {
        const lower = word.toLowerCase();
        return catalogLower.includes(lower) || catalogCompact.includes(lower.replace(/\s+/g, ''));
      }).length;
      if (tail.length > 0 && tailHits === 0) score *= 0.4;
      return score;
    };

    // --- Proxy (代理版) catalog lookup ---
    const catalogQueryCache = new Map<string, Promise<{ products?: any[] }>>();
    const searchCatalog = async (query: string) => {
      const normalizedQuery = query.trim();
      const cached = catalogQueryCache.get(normalizedQuery);
      if (cached) return cached;
      const request = fetchReadonlyCatalogJson<{ products?: any[] }>(
        `/api/catalog/search?q=${encodeURIComponent(normalizedQuery)}&pageSize=8`,
      );
      catalogQueryCache.set(normalizedQuery, request);
      try {
        return await request;
      } catch (error) {
        catalogQueryCache.delete(normalizedQuery);
        throw error;
      }
    };

    const lookupProxy = async (group: ProductGroup): Promise<LookupResult> => {
      const originalTitle = group.normalized_title || group.title;
      const identity = normalizeProxyProductIdentity(originalTitle);
      const sourceIdentityShadow = isNextIdentityShadowMode
        ? createProxyIdentityShadowDiagnostic(originalTitle, identity)
        : undefined;

      const queries = buildProxyCatalogQueries(identity);
      if (queries.length === 0) {
        return {
          score: 0,
          failureReason: '商品識別資訊不足，需要人工確認',
          diagnostic: {
            groupId: group.id,
            source: 'proxy',
            originalTitle,
            decision: 'NOT_FOUND',
            decisionSource: 'NO_MATCH_V1_ONLY',
            score: 0,
            reason: '商品識別資訊不足，需要人工確認',
            sourceIdentity: summarizeIdentity(identity),
            sourceIdentityShadow,
          },
        };
      }

      const candidates: ProxyCatalogCandidate[] = [];
      const executedQueries: string[] = [];
      let selection = selectProxyCatalogCandidate(originalTitle, candidates);
      let decisionResolution = resolveProxyCatalogDecision(providerMode, originalTitle, candidates, selection);
      let successfulQueries = 0;
      let lastQueryError: unknown = null;
      for (const q of queries) {
        executedQueries.push(q);
        let data: { products?: any[] };
        try {
          data = await searchCatalog(q);
          successfulQueries += 1;
        } catch (error) {
          lastQueryError = error;
          continue;
        }
        if (data.products && data.products.length > 0) candidates.push(...data.products);
        selection = selectProxyCatalogCandidate(originalTitle, candidates);
        decisionResolution = resolveProxyCatalogDecision(providerMode, originalTitle, candidates, selection);
        // Preserve the existing v1 early-stop behavior. A Pilot match keeps
        // collecting the already-planned queries so Wanrong priority can see all
        // supplier listings; it does not add queries beyond the v1 rejection path.
        if (
          decisionResolution.match?.decisionSource === 'V1'
          && decisionResolution.match.candidate.catalog?.deadlineAt
        ) break;
      }
      const v2Queries = canUseProxyIdentityPilot(providerMode)
        ? buildProxyCatalogQueriesV2(originalTitle).filter(query => !queries.includes(query))
        : [];
      if (!decisionResolution.match && v2Queries.length > 0) {
        for (const q of v2Queries) {
          executedQueries.push(q);
          let data: { products?: any[] };
          try {
            data = await searchCatalog(q);
            successfulQueries += 1;
          } catch (error) {
            lastQueryError = error;
            continue;
          }
          if (data.products && data.products.length > 0) candidates.push(...data.products);
          selection = selectProxyCatalogCandidate(originalTitle, candidates);
          decisionResolution = resolveProxyCatalogDecision(providerMode, originalTitle, candidates, selection);
          const supplier = decisionResolution.match?.candidate.catalog?.supplier?.code?.toLocaleLowerCase();
          if (decisionResolution.match?.decisionSource === 'V1' || supplier === 'wanrong') break;
        }
      }
      if (successfulQueries === 0 && lastQueryError) throw lastQueryError;
      const v2Attempted = canUseProxyIdentityPilot(providerMode);
      const bestPilotRejection = v2Attempted
        ? candidates
          .map(candidate => scoreProxyCatalogCandidateV2Pilot(originalTitle, candidate))
          .filter(result => result.rejected)
          .sort((left, right) => right.evidence.length - left.evidence.length)[0]
        : undefined;
      const summarizeScoredCandidate = (candidate: ProxyCatalogCandidate) => summarizeCandidate(
        candidate,
        scoreProxyCatalogCandidate(originalTitle, candidate).confidence,
        sourceIdentityShadow,
      );
      const selectionCandidates = selection.status === 'ambiguous'
        ? selection.candidates.map(summarizeScoredCandidate)
        : selection.status === 'no_match' && selection.bestCandidate
          ? [summarizeScoredCandidate(selection.bestCandidate)]
          : [];
      const selectionDiagnostic = (overrides: Partial<LookupDiagnostic> = {}): LookupDiagnostic => ({
        groupId: group.id,
        source: 'proxy',
        originalTitle,
        decision: selection.status === 'match'
          ? 'MATCH'
          : selection.status === 'ambiguous'
            ? 'AMBIGUOUS'
            : 'NOT_FOUND',
        decisionSource: decisionResolution.match?.decisionSource
          ?? (v2Attempted ? 'NO_MATCH_AFTER_V2' : 'NO_MATCH_V1_ONLY'),
        score: selection.confidence,
        reason: selection.status === 'match' ? undefined : selection.message,
        sourceIdentity: summarizeIdentity(identity),
        sourceIdentityShadow,
        v1Queries: queries,
        v2Queries,
        executedQueries,
        v2Attempted,
        v2RejectReason: bestPilotRejection?.reason,
        v2SafetyVetoReason: decisionResolution.safetyVeto?.reason,
        candidates: selectionCandidates,
        ...overrides,
      });
      const effectiveMatch = decisionResolution.match;
      if (!effectiveMatch) {
        const bestName = selection.status === 'no_match' ? selection.bestCandidate?.name : undefined;
        const failureMessage = decisionResolution.safetyVeto?.reason === 'version_conflict'
          ? '商品版本不一致，為避免套用錯誤結單日，本次自動配對已取消'
          : selection.status === 'match'
            ? '商品識別驗證未通過'
          : selection.message;
        return {
          matchName: bestName || undefined,
          score: selection.confidence,
          failureReason: failureMessage,
          identityVerified: false,
          diagnostic: selectionDiagnostic({
            decision: 'NOT_FOUND',
            reason: failureMessage,
          }),
        };
      }

      const selected = effectiveMatch.candidate;
      if (!selected.catalog?.deadlineAt) {
        return {
          matchName: selected.name || undefined,
          score: effectiveMatch.confidence,
          failureReason: '已識別商品，但來源沒有有效結單日',
          identityVerified: true,
          diagnostic: selectionDiagnostic({
            decision: 'MATCH',
            decisionSource: effectiveMatch.decisionSource,
            score: effectiveMatch.confidence,
            pilotEvidence: effectiveMatch.pilotEvidence,
            selected: summarizeCandidate(
              selected,
              effectiveMatch.confidence,
              sourceIdentityShadow,
              effectiveMatch.pilotEvidence,
            ),
            reason: '已識別商品，但來源沒有有效結單日',
          }),
        };
      }

      // Write guard: deadline data is trusted only after the selected identity is
      // re-verified by its decision source and the unchanged ambiguity gate has passed.
      const reverifiedDecision = resolveProxyCatalogDecision(providerMode, originalTitle, candidates, selection);
      const effectiveMatchIsStillSafe = reverifiedDecision.match !== null
        && reverifiedDecision.match.decisionSource === effectiveMatch.decisionSource
        && reverifiedDecision.match.candidate === selected;
      if (effectiveMatchIsStillSafe) {
        const deadline = new Date(selected.catalog.deadlineAt);
        deadline.setDate(deadline.getDate() - 2);
        const dateStr = `${deadline.getFullYear()}/${String(deadline.getMonth() + 1).padStart(2, '0')}/${String(deadline.getDate()).padStart(2, '0')}`;
        return {
          closing_date: dateStr,
          matchName: selected.name || undefined,
          score: effectiveMatch.confidence,
          identityVerified: true,
          diagnostic: selectionDiagnostic({
            decision: 'MATCH',
            decisionSource: effectiveMatch.decisionSource,
            score: effectiveMatch.confidence,
            pilotEvidence: effectiveMatch.pilotEvidence,
            selected: summarizeCandidate(
              selected,
              effectiveMatch.confidence,
              sourceIdentityShadow,
              effectiveMatch.pilotEvidence,
            ),
            finalClosingDate: dateStr,
          }),
        };
      }
      return {
        score: 0,
        identityVerified: false,
        failureReason: '商品識別驗證未通過',
        diagnostic: selectionDiagnostic({
          decision: 'NOT_FOUND',
          score: 0,
          reason: '商品識別驗證未通過',
        }),
      };
    };

    // --- Shopify store lookup (Hololive / VSPO) ---
    const shopifyCache: Record<string, any[]> = {};

    const fetchShopifyProducts = async (apiBase: string): Promise<any[]> => {
      if (shopifyCache[apiBase]) return shopifyCache[apiBase];
      const all: any[] = [];
      let page = 1;
      while (page <= 4) {
        const data = await fetchReadonlyCatalogJson<{ products?: any[] }>(
          `${apiBase}/products.json?limit=250&page=${page}`,
        );
        if (!data.products || data.products.length === 0) break;
        all.push(...data.products);
        if (data.products.length < 250) break;
        page++;
      }
      shopifyCache[apiBase] = all;
      return all;
    };

    const parseShopifyPageDates = async (apiBase: string, handle: string): Promise<{ deadline?: string; shippingMonth?: string }> => {
      const html = await fetchReadonlyCatalogText(`${apiBase}/products/${handle}`);
      const text = html.replace(/<[^>]*>/g, '');
      let deadline: string | undefined;
      const dlMatch = text.match(/(?:受注受付期間|販売期間)[^〜～~]*[〜～~]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (dlMatch) {
        const d = new Date(parseInt(dlMatch[1]), parseInt(dlMatch[2]) - 1, parseInt(dlMatch[3]));
        d.setDate(d.getDate() - 4);
        deadline = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
      }
      let shippingMonth: string | undefined;
      const smMatch = text.match(/(?:発送予定日|配送予定日|お届け予定)[：:]*\s*(\d{4})年(\d{1,2})月/);
      if (smMatch) {
        shippingMonth = `${smMatch[1]}-${smMatch[2].padStart(2, '0')}`;
      }
      return { deadline, shippingMonth };
    };

    const lookupShopify = async (group: ProductGroup, apiBase: string): Promise<{ closing_date?: string; release_month?: string; productUrl?: string; matchName?: string; score: number; diagnostic?: LookupDiagnostic }> => {
      const originalTitle = group.normalized_title || group.title;
      const cleaned = stripShopTitle(originalTitle);
      const source = apiBase === '/api/hololive' ? 'hololive' : 'vspo';
      if (cleaned.length < 2) {
        return {
          score: 0,
          diagnostic: {
            groupId: group.id,
            source,
            originalTitle,
            decision: 'NOT_FOUND',
            score: 0,
            reason: '商品名稱不足以建立查詢',
          },
        };
      }
      const stopWords = new Set(['pop', 'up', 'in', 'at', 'of', 'the', 'and', 'or', 'for', 'to', 'vs', 'vol', 'ver', 'no']);
      const segments = cleaned.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w.toLowerCase()));
      const products = await fetchShopifyProducts(apiBase);
      const otLower = originalTitle.toLowerCase();
      const otCompact = otLower.replace(/\s+/g, '');

      let bestMatch: any = null;
      let bestScore = 0;
      for (const p of products) {
        const fwd = shopMatchScore(p.title || '', originalTitle, segments);
        const shopSegs = (p.title || '').replace(/^(hololive|VSPO|ぶいすぽっ！?)\s*/gi, '').split(/[\s「」【】（）]+/).filter((w: string) => w.length >= 2);
        let revHits = 0;
        for (const w of shopSegs) {
          const wl = w.toLowerCase();
          if (otLower.includes(wl) || otCompact.includes(wl.replace(/\s+/g, ''))) revHits++;
        }
        const rev = shopSegs.length > 0 ? revHits / shopSegs.length : 0;
        const score = Math.max(fwd, rev * 0.6);
        if (score > bestScore) { bestScore = score; bestMatch = p; }
      }
      const storeOrigin = apiBase === '/api/hololive' ? 'https://shop.hololivepro.com' : 'https://store.vspo.jp';
      const candidateSummary = bestMatch
        ? summarizeCandidate({
          name: bestMatch.title,
          catalog: { deadlineAt: null },
        }, bestScore)
        : undefined;
      if (!bestMatch || bestScore < 0.4) {
        return {
          matchName: bestMatch?.title,
          score: bestScore,
          diagnostic: {
            groupId: group.id,
            source,
            originalTitle,
            decision: 'NOT_FOUND',
            score: bestScore,
            reason: '候選配對度不足，需要人工確認',
            candidates: candidateSummary ? [candidateSummary] : [],
          },
        };
      }
      const dates = await parseShopifyPageDates(apiBase, bestMatch.handle);
      const selected = summarizeCandidate({
        name: bestMatch.title,
        catalog: { deadlineAt: dates.deadline || null },
      }, bestScore);
      return {
        closing_date: dates.deadline,
        release_month: dates.shippingMonth,
        productUrl: `${storeOrigin}/products/${bestMatch.handle}`,
        matchName: bestMatch.title,
        score: bestScore,
        diagnostic: {
          groupId: group.id,
          source,
          originalTitle,
          decision: 'MATCH',
          score: bestScore,
          selected,
          finalClosingDate: dates.deadline,
        },
      };
    };

    // --- Main loop ---
    let catalogServiceFailed = false;
    for (const group of targetGroups) {
      try {
        const source = getSource(group)!;
        const originalTitle = (group.normalized_title || group.title).slice(0, 35);
        let result: LookupResult;

        if (source === 'proxy') {
          result = await lookupProxy(group);
        } else {
          const apiBase = source === 'hololive' ? '/api/hololive' : '/api/vspo';
          result = await lookupShopify(group, apiBase);
        }

        if (result.diagnostic) diagnostics.push(result.diagnostic);

        const identityGuardPassed = source !== 'proxy' || result.identityVerified === true;
        if (result.closing_date && result.score >= 0.4 && identityGuardPassed) {
          const idx = updatedGroups.findIndex(g => g.id === group.id);
          if (idx !== -1) {
            const updates: Partial<ProductGroup> = {};
            if (!updatedGroups[idx].closing_date) {
              updates.closing_date = result.closing_date;
            }
            if (result.release_month && !updatedGroups[idx].release_month) {
              updates.release_month = result.release_month;
            }
            if (result.productUrl && !updatedGroups[idx].product_url) {
              updates.product_url = result.productUrl;
            }
            updatedGroups[idx] = { ...updatedGroups[idx], ...updates };
            matched++;
            const extra = result.release_month ? ` 發售:${result.release_month}` : '';
            details.push(`✅ ${originalTitle}… → ${result.matchName?.slice(0, 25)} (${Math.round(result.score * 100)}%) → ${result.closing_date}${extra}`);
          }
        } else {
          failed++;
          const pct = result.score > 0 ? ` (${Math.round(result.score * 100)}%)` : '';
          if (result.failureReason) {
            details.push(`❌ ${originalTitle}… — ${result.failureReason}${pct}${result.matchName ? `: ${result.matchName.slice(0, 20)}` : ''}`);
          } else if (result.matchName && result.score >= 0.4) {
            details.push(`❌ ${originalTitle}… — 無結單日${pct}: ${result.matchName.slice(0, 20)}`);
          } else {
            details.push(`❌ ${originalTitle}… — ${result.matchName ? `配對度不足${pct}: ${result.matchName.slice(0, 20)}` : '未找到'}`);
          }
        }
      } catch (err) {
        failed++;
        console.error('[AutoLookup] Error:', err);
        if (err instanceof CatalogServiceError) {
          diagnostics.push({
            groupId: group.id,
            source: getSource(group)!,
            originalTitle: group.normalized_title || group.title,
            decision: 'SERVICE_ERROR',
            score: 0,
            reason: err.message,
          });
          catalogServiceFailed = true;
          break;
        }
      }
    }

    if (catalogServiceFailed) {
      setLookupDiagnostics(diagnostics);
      setIsLookingUpDeadlines(false);
      alert(CATALOG_SERVICE_UNAVAILABLE_MESSAGE);
      return;
    }

    if (matched > 0) {
      setGroups(updatedGroups);
      try {
        await dataProvider.saveProductGroups(updatedGroups);
      } catch (err) {
        if (err instanceof StaleDataError) {
          alert(err.message);
          setIsStale(true);
          await loadData();
          setIsLookingUpDeadlines(false);
          return;
        }
      }
    }

    setIsLookingUpDeadlines(false);
    setLookupDiagnostics(diagnostics);
    console.log('[AutoLookup] Results:', details.join('\n'));
    alert(`自動查詢結單日完成！\n\n✅ 成功：${matched} 筆\n❌ 未找到：${failed} 筆\n\n${details.join('\n')}\n\n代理版 = 目錄 - 2天 / Hololive·VSPO = 官方 - 4天`);
  };

  const handlePaste = async (
    e: React.ClipboardEvent<HTMLInputElement>,
    startRowIndex: number,
    field: 'closing_date' | 'release_month' | 'purchase_date' | 'product_url',
    sourceList: ProductGroup[] = filteredAndSortedGroups
  ) => {
    if (guardAgainstStaleWrite()) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) return;

    const listToUpdate = sourceList.slice(startRowIndex, startRowIndex + lines.length);
    if (listToUpdate.length === 0) return;

    const groupMap = new Map(groups.map(g => [g.id, g]));
    listToUpdate.forEach((item, offset) => {
      const dbGroup = groupMap.get(item.id);
      if (dbGroup) {
        let val = lines[offset];
        if (field === 'closing_date' || field === 'purchase_date') {
          const normalized = normalizeDateInput(val);
          if (normalized) {
            val = normalized.replace(/-/g, '/');
          } else {
            // Keep unchanged if it cannot be normalized
            return;
          }
        }
        dbGroup[field] = val;
      }
    });

    const nextGroups = Array.from(groupMap.values());
    setGroups(nextGroups);
    try {
      await dataProvider.saveProductGroups(nextGroups);
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      throw err;
    }
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    field: string,
    tableId: string
  ) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const nextInput = document.querySelector(
        `input[data-table="${tableId}"][data-row="${rowIndex + 1}"][data-field="${field}"]`
      ) as HTMLInputElement;
      if (nextInput) {
        nextInput.focus();
        nextInput.select();
      }
    }
  };

  const formatReleaseMonth = (val: string | undefined | null) => {
    if (!val) return '-';
    const match = val.match(/^(\d{4})-(\d{2})$/);
    if (match) {
      return `${match[1]}年${match[2]}月`;
    }
    return val;
  };

  const handleUpdateGroupPlatformDemand = async (groupId: string, platform: 'myacg' | 'waca' | 'purchased', totalValue: number) => {
    if (guardAgainstStaleWrite()) return false;
    if (isNaN(totalValue) || totalValue < 0) totalValue = 0;
    
    const g = groups.find(x => x.id === groupId);
    if (!g || !isProxyProduct(g)) {
      console.warn(`[Edit Blocked] Only proxy products are allowed to modify platform quantities at the group level.`);
      return false;
    }
    
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    
    if (groupVars.length === 0) return false;
    const targetVar = groupVars[0];
    
    const allVars = await dataProvider.getProductVariants();
    const dbTarget = allVars.find(v => v.id === targetVar.id);
    
    if (dbTarget) {
      let patch: Partial<ProductVariant> = {};
      if (platform === 'myacg') {
        patch = { myacg_manual_adjustment: totalValue };
      } else if (platform === 'waca') {
        patch = { waca_manual_adjustment: totalValue };
      } else if (platform === 'purchased') {
        patch = { purchased_manual_adjustment: totalValue };
      }
      try {
        await dataProvider.updateProductVariantPatch(targetVar.id, patch);
        setVariants(prev => prev.map(v => v.id === targetVar.id ? { ...v, ...patch } : v));
        return true;
      } catch (e) {
        console.error(e);
        alert('手動調整儲存失敗，請確認網路連線後再試。本次輸入仍保留在畫面上。');
        return false;
      }
    }
    return false;
  };

  const handleDeleteGroup = async (groupId: string, groupTitle: string) => {
    if (guardAgainstStaleWrite()) return;
    const confirmDelete = window.confirm(`確定要刪除「${groupTitle}」嗎？`);
    if (!confirmDelete) return;

    try {
      await dataProvider.deleteProductGroup(groupId);
      alert(`已成功刪除商品群組「${groupTitle}」。`);
      await loadData();
    } catch (e) {
      alert('刪除失敗');
      console.error(e);
    }
  };

  const handleBatchDelete = async () => {
    if (guardAgainstStaleWrite()) return;
    if (selectedGroupIds.size === 0) return;
    const confirmDelete = window.confirm(`確定刪除已選取的 ${selectedGroupIds.size} 筆商品？`);
    if (!confirmDelete) return;

    try {
      const idsToDelete = Array.from(selectedGroupIds);
      await dataProvider.deleteProductGroups(idsToDelete);
      alert(`已成功刪除 ${idsToDelete.length} 筆商品群組。`);
      setSelectedGroupIds(new Set());
      await loadData();
    } catch (e) {
      alert('批次刪除失敗，請重試。');
      console.error(e);
    }
  };

  const handleNextFieldTestClearClosingDates = async () => {
    if (!canUseNextFieldTestClosingDateClear(getProviderMode())) {
      alert('此操作只允許在 NEXT SANDBOX 使用。');
      return;
    }
    if (guardAgainstStaleWrite() || selectedGroupIds.size === 0 || isClearingClosingDates) return;

    let plan;
    try {
      plan = createNextFieldTestClosingDateClearPlan(groups, selectedGroupIds);
    } catch (error) {
      alert(error instanceof Error ? error.message : '無法確認選取商品，請重新載入後再試。');
      return;
    }

    const confirmed = window.confirm(
      `確定要清除已選取 ${plan.selectedCount} 筆商品的結單日嗎？\n\n此操作只會清除結單日，不會刪除商品或其他資料。`,
    );
    if (!confirmed) return;

    if (plan.modifiedCount === 0) {
      alert(`已清除 0 筆結單日，${plan.alreadyEmptyCount} 筆原本未設定`);
      return;
    }

    setIsClearingClosingDates(true);
    try {
      await dataProvider.saveProductGroups(plan.nextGroups);
      const rawCollections = await readNextRawCollections();
      assertNextFieldTestProductGroupsReadback(
        plan.nextGroups,
        rawCollections.productGroups as unknown as ProductGroup[],
      );

      setGroups(plan.nextGroups);
      setDraftClosingDates(previous => {
        const next = { ...previous };
        selectedGroupIds.forEach(id => delete next[id]);
        return next;
      });
      setSelectedGroupIds(new Set());
      alert(`已清除 ${plan.modifiedCount} 筆結單日，${plan.alreadyEmptyCount} 筆原本未設定`);
    } catch (error) {
      if (error instanceof StaleDataError) {
        alert(error.message);
        setIsStale(true);
      } else {
        alert('清除結單日失敗，未顯示成功結果；請重新載入確認資料狀態。');
        console.error('[Next Field Test] bulk closing-date clear failed:', error);
      }
      await loadData();
    } finally {
      setIsClearingClosingDates(false);
    }
  };

  const handleBatchUpdateShowInPurchaseList = async (show: boolean) => {
    if (guardAgainstStaleWrite()) return;
    if (selectedGroupIds.size === 0) return;
    const actionName = show ? '加入採購總表' : '移出採購總表';

    try {
      const nextGroups = groups.map(g => {
        if (selectedGroupIds.has(g.id)) {
          return { ...g, show_in_purchase_list: show } as ProductGroup;
        }
        return g;
      });

      setGroups(nextGroups);
      await dataProvider.saveProductGroups(nextGroups);
      alert(`已成功將 ${selectedGroupIds.size} 筆商品${actionName}。`);
      setSelectedGroupIds(new Set());
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      alert(`批次${actionName}失敗，請重試。`);
      console.error(err);
    }
  };


  // Save the scroll position of the actual scrolling container (.main-area, see layout.css —
  // the window itself doesn't scroll) right before leaving for a detail page, so we can
  // restore it if the user comes back via the browser Back button.
  const navigateToDetail = (id: string) => {
    const scrollEl = document.querySelector('.main-area');
    if (scrollEl) {
      sessionStorage.setItem('erp_purchase_records_scroll', String(scrollEl.scrollTop));
    }
    navigate(`/purchase-records/${id}`);
  };

  const handleRowClick = (id: string, e: React.MouseEvent) => {
    // Don't navigate if clicking inputs/buttons or selecting product name text
    if ((e.target as HTMLElement).tagName === 'INPUT' ||
        (e.target as HTMLElement).tagName === 'SELECT' ||
        (e.target as HTMLElement).tagName === 'BUTTON' ||
        (e.target as HTMLElement).closest('button') ||
        (e.target as HTMLElement).closest('.product-name-text')) {
      return;
    }
    if (editMode) return;
    navigateToDetail(id);
  };

  if (isInitialLoading) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        padding: '80px 24px',
        color: '#64748b',
        fontSize: '14px'
      }}>
        <div style={{
          width: '28px',
          height: '28px',
          border: '3px solid #e2e8f0',
          borderTopColor: '#2563eb',
          borderRadius: '50%',
          animation: 'erp-spin 0.8s linear infinite'
        }} />
        <span>正在同步雲端資料...</span>
        <style>{`@keyframes erp-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className="flex-col gap-lg" style={{ paddingBottom: isMobile ? '180px' : '0px' }}>
      <div
        data-testid="purchase-records-sync-slot"
        role="status"
        aria-live="polite"
        aria-hidden={isSyncing ? undefined : true}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          height: '18px',
          minHeight: '18px',
          fontSize: '12px',
          lineHeight: '18px',
          color: '#64748b',
          visibility: isSyncing ? 'visible' : 'hidden',
        }}>
          <div style={{
            width: '12px',
            height: '12px',
            border: '2px solid #e2e8f0',
            borderTopColor: '#2563eb',
            borderRadius: '50%',
            animation: 'erp-spin 0.8s linear infinite'
          }} />
          <span>同步中，顯示的是上次載入的資料...</span>
          <style>{`@keyframes erp-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
      <style>{`
        .erp-table th {
          padding: 0 !important;
        }

        .purchase-records-sticky-header th {
          position: sticky;
          top: 0;
          z-index: 20;
          background-color: #f8fafc !important;
          background-clip: padding-box;
          box-shadow: 0 1px 0 #e2e8f0;
        }

        .th-inner {
          position: relative;
          padding: 8px 12px;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          width: 100%;
          height: 100%;
          min-height: 38px;
        }

        .th-inner.justify-center {
          justify-content: center;
        }

        .th-inner.justify-end {
          justify-content: flex-end;
        }

        .resizer-handle {
          position: absolute;
          right: 0;
          top: 4px;
          bottom: 4px;
          width: 4px;
          border-right: 2px solid #000000;
          cursor: col-resize;
          user-select: none;
          z-index: 10;
          opacity: 0.6;
          transition: opacity 0.15s;
        }

        .resizer-handle:hover,
        .resizer-handle:active {
          opacity: 1;
          border-right: 2px solid #2563eb;
        }

        @media (max-width: 767px) {
          .mobile-card-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 8px;
            background-color: #f8fafc;
          }
          .mobile-product-card {
            display: flex;
            align-items: center;
            padding: 8px 10px;
            background-color: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
            transition: all 0.2s ease;
          }
          .mobile-product-card.selected {
            background-color: #f0fdf4;
            border-color: #86efac;
          }
          .card-checkbox-wrapper {
            margin-right: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }
          .card-content-wrapper {
            display: flex;
            flex-direction: column;
            gap: 4px;
            flex: 1;
            min-width: 0;
          }
          .card-title-row {
            display: flex;
            align-items: flex-start;
            gap: 4px;
            min-width: 0;
          }
          .card-title {
            font-size: 13px;
            font-weight: 600;
            color: #1e293b;
            line-height: 1.35;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            text-overflow: ellipsis;
            word-break: break-all;
            flex: 1;
          }
          .badge-missing {
            background-color: #ffedd5;
            color: #ea580c;
            padding: 1px 4px;
            border-radius: 3px;
            font-weight: 600;
            font-size: 9px;
            white-space: nowrap;
            flex-shrink: 0;
          }
          .card-sku-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: #64748b;
            gap: 8px;
          }
          .card-sku {
            text-overflow: ellipsis;
            overflow: hidden;
            white-space: nowrap;
            min-width: 0;
            flex: 1;
          }
          .card-price {
            font-weight: 600;
            color: #0f172a;
            white-space: nowrap;
            flex-shrink: 0;
          }
          .card-badges-row {
            display: flex;
            flex-wrap: wrap;
            gap: 4px 6px;
            align-items: center;
            margin-top: 1px;
            font-size: 11px;
            color: #64748b;
          }
          .badge-purchase {
            font-size: 9px;
            padding: 1px 4px;
            border-radius: 3px;
            font-weight: 600;
          }
          .badge-purchase.added {
            background-color: #dbeafe;
            color: #1d4ed8;
          }
          .badge-purchase.not-added {
            background-color: #f1f5f9;
            color: #64748b;
          }
          .badge-count {
            background-color: #f1f5f9;
            color: #475569;
            font-size: 9px;
            padding: 1px 4px;
            border-radius: 3px;
            font-weight: 600;
          }
        }
        @media (min-width: 1400px) {
          .th-inner {
            padding: 10px 14px !important;
            min-height: 44px !important;
          }
          .resizer-handle {
            top: 6px !important;
            bottom: 6px !important;
          }
        }
        @media (min-width: 2500px) {
          .th-inner {
            padding: 12px 18px !important;
            min-height: 50px !important;
          }
          .resizer-handle {
            top: 8px !important;
            bottom: 8px !important;
          }
        }
      `}</style>


      <div className="flex justify-between items-center" style={{ marginBottom: 'var(--spacing-md)' }}>
        <div>
          <h1 style={{ marginBottom: '4px', fontSize: '20px', fontWeight: 600 }}>訂購紀錄表</h1>
          <p className="text-muted text-sm" style={{ margin: 0 }}>總體商品群組清單，點擊進入該群組進行採購與需求管理。</p>
        </div>
      </div>

      <CloudRefreshButton
        refresh={refreshAuthoritative}
        resources={['products', 'purchases', 'privateOrders', 'inventory', 'salesOrders']}
        onLocalRefresh={loadFreshData}
      />
      {isStale && (
        <div style={{
          backgroundColor: '#fef3c7',
          borderLeft: '4px solid #d97706',
          padding: '16px',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderRadius: '4px',
          boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>⚠️</span>
            <span style={{ color: '#92400e', fontWeight: 500 }}>你正在編輯的資料已在其他 Client 變更；草稿已保留，請先處理衝突。</span>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: isMobile ? '4px' : '8px', borderBottom: '1px solid #e2e8f0', paddingBottom: '0px', marginBottom: '16px', flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : 'visible', width: '100%', maxWidth: '100%', WebkitOverflowScrolling: 'touch' }}>
        <button 
          onClick={() => { setActiveTab('all'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'all' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'all' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          全部商品 ({groups.length})
        </button>
        <button
          onClick={() => { setActiveTab('c108'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'c108' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'c108' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          C108專區 ({groups.filter(isC108Product).length})
        </button>
        <button 
          onClick={() => { setActiveTab('hololive'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'hololive' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'hololive' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          Hololive商品 ({groups.filter(isHololiveProduct).length})
        </button>
        <button 
          onClick={() => { setActiveTab('vspo'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'vspo' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'vspo' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          VSPO商品 ({groups.filter(isVspoProduct).length})
        </button>
        <button 
          onClick={() => { setActiveTab('proxy'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'proxy' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'proxy' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          代理版商品 ({groups.filter(isProxyCategoryProduct).length})
        </button>
        <button 
          onClick={() => { setActiveTab('other'); setSearchTerm(''); }}
          style={{
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'other' ? '2px solid #2563eb' : '2px solid transparent',
            color: activeTab === 'other' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            whiteSpace: 'nowrap',
            flex: isMobile ? '0 0 auto' : undefined
          }}
        >
          其他商品 ({groups.filter(isOtherProduct).length})
        </button>

        {/* WACA 迷你更新資訊區塊 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 16px',
          fontSize: '13px',
          color: '#475569',
          marginLeft: isMobile ? '0' : 'auto',
          alignSelf: 'center',
          whiteSpace: 'nowrap',
          borderLeft: isMobile ? 'none' : '1px solid #e2e8f0',
          paddingLeft: isMobile ? '16px' : '24px',
          flexShrink: 0
        }}>
          <span style={{ fontWeight: 600 }}>
            {wacaMeta?.closing_date 
              ? `WACA：${formatWacaDate(wacaMeta.closing_date)}・${wacaMeta.proxy_agent || '無'}` 
              : 'WACA：尚未更新'}
          </span>
          <button
            onClick={() => {
              if (wacaMeta?.proxy_agent) {
                const currentAgent = wacaMeta.proxy_agent as any;
                if (['小河馬', 'Flanlove', '許願', '江尚恩'].includes(currentAgent)) {
                  setSelectedWacaUpdater(currentAgent);
                }
              }
              openWacaDialog();
            }}
            style={{
              padding: '2px 8px',
              fontSize: '12px',
              fontWeight: 600,
              color: '#2563eb',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: '4px',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
            onMouseEnter={e => {
              e.currentTarget.style.backgroundColor = '#dbeafe';
              e.currentTarget.style.color = '#1d4ed8';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = '#eff6ff';
              e.currentTarget.style.color = '#2563eb';
            }}
          >
            更新紀錄
          </button>
        </div>
      </div>

      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: '16px',
        flexWrap: 'wrap',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <button
            onClick={() => { setSecondaryTab('progress'); }}
            style={{
              padding: secondaryTab === 'progress' ? '5px 15px' : '6px 16px',
              fontSize: '13px',
              fontWeight: secondaryTab === 'progress' ? 700 : 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: secondaryTab === 'progress' ? '2px solid #1d4ed8' : '1px solid #cbd5e1',
              backgroundColor: secondaryTab === 'progress' ? '#2563eb' : '#ffffff',
              color: secondaryTab === 'progress' ? '#ffffff' : '#475569',
              transition: 'all 0.15s ease'
            }}
          >
            進行中 ({progressCount})
          </button>
          <button
            onClick={() => { setSecondaryTab('closed'); }}
            style={{
              padding: secondaryTab === 'closed' ? '5px 15px' : '6px 16px',
              fontSize: '13px',
              fontWeight: secondaryTab === 'closed' ? 700 : 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: secondaryTab === 'closed' ? '2px solid #1d4ed8' : '1px solid #cbd5e1',
              backgroundColor: secondaryTab === 'closed' ? '#2563eb' : '#ffffff',
              color: secondaryTab === 'closed' ? '#ffffff' : '#475569',
              transition: 'all 0.15s ease'
            }}
          >
            已結單 ({closedCount})
          </button>
          <button
            onClick={() => { setSecondaryTab('no_closing_date'); }}
            style={{
              padding: secondaryTab === 'no_closing_date' ? '5px 15px' : '6px 16px',
              fontSize: '13px',
              fontWeight: secondaryTab === 'no_closing_date' ? 700 : 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: secondaryTab === 'no_closing_date' ? '2px solid #9a3412' : `1px solid ${noClosingDateCount > 0 ? '#fcd34d' : '#cbd5e1'}`,
              backgroundColor: secondaryTab === 'no_closing_date' ? '#c2410c' : (noClosingDateCount > 0 ? '#fffdf5' : '#ffffff'),
              color: secondaryTab === 'no_closing_date' ? '#ffffff' : (noClosingDateCount > 0 ? '#b45309' : '#475569'),
              transition: 'all 0.15s ease',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <AlertTriangle size={14} />
            未設定結單日 ({noClosingDateCount})
          </button>
          <button
            onClick={() => { setSecondaryTab('no_jpy_cost'); }}
            style={{
              padding: secondaryTab === 'no_jpy_cost' ? '5px 15px' : '6px 16px',
              fontSize: '13px',
              fontWeight: secondaryTab === 'no_jpy_cost' ? 700 : 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: secondaryTab === 'no_jpy_cost' ? '2px solid #9a3412' : `1px solid ${missingJpyCostCount > 0 ? '#fbbf24' : '#cbd5e1'}`,
              backgroundColor: secondaryTab === 'no_jpy_cost' ? '#c2410c' : '#ffffff',
              color: secondaryTab === 'no_jpy_cost' ? '#ffffff' : (missingJpyCostCount > 0 ? '#b45309' : '#475569'),
              transition: 'all 0.15s ease',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <CircleDollarSign size={14} />
            未設定日幣金額 ({missingJpyCostCount})
          </button>
          <button
            onClick={() => { setSecondaryTab('to_purchase'); }}
            style={{
              padding: secondaryTab === 'to_purchase' ? '5px 15px' : '6px 16px',
              fontSize: '13px',
              fontWeight: secondaryTab === 'to_purchase' ? 700 : 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: secondaryTab === 'to_purchase' ? '2px solid #991b1b' : `1px solid ${toPurchaseCount > 0 ? '#fca5a5' : '#cbd5e1'}`,
              backgroundColor: secondaryTab === 'to_purchase' ? '#dc2626' : (toPurchaseCount > 0 ? '#fff5f5' : '#ffffff'),
              color: secondaryTab === 'to_purchase' ? '#ffffff' : (toPurchaseCount > 0 ? '#dc2626' : '#475569'),
              transition: 'all 0.15s ease'
            }}
          >
            🚨 待採購 ({toPurchaseCount})
          </button>
          <button
            onClick={() => { setSecondaryTab('all'); }}
            style={{
              padding: secondaryTab === 'all' ? '5px 15px' : '6px 16px',
              fontSize: '13px',
              fontWeight: secondaryTab === 'all' ? 700 : 600,
              borderRadius: '20px',
              cursor: 'pointer',
              border: secondaryTab === 'all' ? '2px solid #1d4ed8' : '1px solid #cbd5e1',
              backgroundColor: secondaryTab === 'all' ? '#2563eb' : '#ffffff',
              color: secondaryTab === 'all' ? '#ffffff' : '#475569',
              transition: 'all 0.15s ease'
            }}
          >
            全部 ({allCount})
          </button>
        </div>


      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '16px', backgroundColor: '#fff', padding: '16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
        
        <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '0 12px', height: '40px' }}>
          <Search size={18} style={{ color: '#64748b', marginRight: '8px' }} />
          <input 
            type="text" 
            placeholder="搜尋品項、商品名稱、月份、類型..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ border: 'none', background: 'transparent', outline: 'none', width: '100%', fontSize: '14px', color: '#334155' }}
          />
        </div>
        
        {isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {/* Row 1: Source and Type filters side-by-side */}
            <div style={{ display: 'flex', gap: '10px', width: '100%' }}>
              {/* Column 1: Source */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>商品來源</span>
                <select 
                  className="select" 
                  style={{ width: '100%', height: '36px', fontSize: '13px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 8px', backgroundColor: '#fff' }} 
                  value={filterSource} 
                  onChange={e => { setFilterSource(e.target.value); setSearchTerm(''); }}
                >
                  <option value="all">全部</option>
                  <option value="Hololive">Hololive</option>
                  <option value="VSPO">VSPO</option>
                  <option value="代理商品">代理商品</option>
                </select>
              </div>
              {/* Column 2: Type */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>商品種類</span>
                <select 
                  className="select" 
                  style={{ width: '100%', height: '36px', fontSize: '13px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 8px', backgroundColor: '#fff' }} 
                  value={filterType} 
                  onChange={e => { setFilterType(e.target.value); setSearchTerm(''); }}
                >
                  <option value="all">全部</option>
                  <option value="一般預購">一般預購</option>
                  <option value="現貨">現貨</option>
                  <option value="現地代購">現地代購</option>
                  <option value="日本代購">日本代購</option>
                  <option value="代理版">代理版</option>
                </select>
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '36px', fontSize: '13px', fontWeight: 600, color: '#115e59', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={needsPurchaseOnly}
                onChange={e => setNeedsPurchaseOnly(e.target.checked)}
                style={{ width: '17px', height: '17px', margin: 0, accentColor: '#047857', cursor: 'pointer' }}
              />
              <span>只看需要採購（{needsPurchaseCount}）</span>
            </label>

            {/* Row 2: Sort select */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>排序</span>
              <select 
                className="select" 
                style={{ width: '100%', height: '36px', fontSize: '13px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 8px', backgroundColor: '#fff' }} 
                value={sortMode} 
                onChange={e => { setSortMode(e.target.value); setSearchTerm(''); }}
              >
                <option value="closing_urgent">開單中優先 + 結單日近優先</option>
                <option value="closing_name">結單日近 ＋ 名稱相近</option>
                <option value="created_desc">建立時間 (新到舊)</option>
                <option value="closing_asc">結單日 (近到遠)</option>
                <option value="release_asc">發售月份 (近到遠)</option>
              </select>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品來源</span>
              <select className="input" style={{ width: '140px', height: '36px', fontSize: '13px' }} value={filterSource} onChange={e => { setFilterSource(e.target.value); setSearchTerm(''); }}>
                <option value="all">全部</option>
                <option value="Hololive">Hololive</option>
                <option value="VSPO">VSPO</option>
                <option value="代理商品">代理商品</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品類型</span>
              <select className="input" style={{ width: '140px', height: '36px', fontSize: '13px' }} value={filterType} onChange={e => { setFilterType(e.target.value); setSearchTerm(''); }}>
                <option value="all">全部</option>
                <option value="一般預購">一般預購</option>
                <option value="現貨">現貨</option>
                <option value="現地代購">現地代購</option>
                <option value="日本代購">日本代購</option>
                <option value="代理版">代理版</option>
              </select>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '36px', fontSize: '13px', fontWeight: 600, color: '#115e59', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={needsPurchaseOnly}
                onChange={e => setNeedsPurchaseOnly(e.target.checked)}
                style={{ width: '17px', height: '17px', margin: 0, accentColor: '#047857', cursor: 'pointer' }}
              />
              <span>只看需要採購（{needsPurchaseCount}）</span>
            </label>

            <div style={{ flex: 1 }}></div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>排序</span>
              <select className="input" style={{ width: '220px', height: '36px', fontSize: '13px' }} value={sortMode} onChange={e => { setSortMode(e.target.value); setSearchTerm(''); }}>
                <option value="closing_urgent">開單中優先 + 結單日近優先</option>
                <option value="closing_name">結單日近 ＋ 名稱相近</option>
                <option value="created_desc">建立時間 (新到舊)</option>
                <option value="closing_asc">結單日 (近到遠)</option>
                <option value="release_asc">發售月份 (近到遠)</option>
              </select>
              <button
                onClick={() => {
                  resetWidths();
                  alert('欄位寬度已重設為預設值！');
                }}
                style={{
                  height: '36px',
                  padding: '0 12px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#475569',
                  backgroundColor: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  display: 'inline-flex',
                  alignItems: 'center',
                  whiteSpace: 'nowrap'
                }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = '#f8fafc'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = '#ffffff'}
              >
                重置欄位寬度
              </button>
            </div>

          </div>
        )}

        <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span>共</span>
          <span style={{ color: '#2563eb', fontWeight: 700, fontSize: '15px' }}>
            {secondaryTab === 'progress' ? filteredAndSortedGroups.length + completedGroups.length : filteredAndSortedGroups.length}
          </span>
          <span>筆商品符合條件</span>
          {secondaryTab === 'progress' && !needsPurchaseOnly && (
            <span style={{ color: '#64748b', fontSize: '12px' }}>
              (進行中: {filteredAndSortedGroups.length} 筆 / 已過結單日: {completedGroups.length} 筆)
            </span>
          )}
        </div>
      </div>


      {editMode && (
        <div style={{
          backgroundColor: '#eff6ff',
          border: '1px solid #bfdbfe',
          borderRadius: '12px',
          padding: '16px',
          marginBottom: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#1e40af' }}>批量編輯 ({selectedGroupIds.size} 筆已選取)</span>
            <span style={{ fontSize: '12px', color: '#1e40af' }}>勾選左側核取方塊後，填寫下方欄位並點擊套用</span>
          </div>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>官方結單日：</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
                <input
                  type="text"
                  className="input"
                  placeholder="YYYY/MM/DD"
                  value={batchClosingDate}
                  onChange={e => setBatchClosingDate(e.target.value)}
                  style={{ width: '150px', height: '36px', fontSize: '13px', paddingRight: '24px' }}
                />
                <Calendar
                  size={14}
                  style={{ position: 'absolute', right: '8px', color: '#64748b', cursor: 'pointer' }}
                  onClick={() => {
                    const el = document.getElementById('batch-datepicker-input') as HTMLInputElement | null;
                    if (el) el.showPicker();
                  }}
                />
                <input
                  id="batch-datepicker-input"
                  type="date"
                  style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                  value={batchClosingDate ? batchClosingDate.replace(/\//g, '-') : ''}
                  onChange={e => {
                    setBatchClosingDate(e.target.value.replace(/-/g, '/'));
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>發售月份：</span>
              <input
                type="text"
                className="input"
                placeholder="YYYY-MM (如 2026-07)"
                value={batchReleaseMonth}
                onChange={e => setBatchReleaseMonth(e.target.value)}
                style={{ width: '180px', height: '36px', fontSize: '13px' }}
              />
            </div>

            <button
              onClick={handleBatchApply}
              disabled={selectedGroupIds.size === 0}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: selectedGroupIds.size > 0 ? '#2563eb' : '#9ca3af',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: selectedGroupIds.size > 0 ? 'pointer' : 'not-allowed',
                transition: 'all 0.2s'
              }}
            >
              套用至勾選商品
            </button>

            {!isClosingDateWorkbenchAvailable && (
              <button
                onClick={handleAutoLookupDeadlines}
                disabled={selectedGroupIds.size === 0 || isLookingUpDeadlines}
                style={{
                  padding: '0 16px',
                  height: '36px',
                  backgroundColor: selectedGroupIds.size > 0 ? '#059669' : '#9ca3af',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: selectedGroupIds.size > 0 ? 'pointer' : 'not-allowed',
                  transition: 'all 0.2s',
                  opacity: isLookingUpDeadlines ? 0.7 : 1,
                }}
              >
                {isLookingUpDeadlines ? '查詢中...' : '🔍 自動查詢結單日'}
              </button>
            )}
          </div>
        </div>
      )}

      {lookupDiagnostics.length > 0 && (
        <details
          open
          data-testid="closing-date-diagnostics"
          style={{
            marginBottom: '16px',
            border: '1px solid #bfdbfe',
            borderRadius: '12px',
            backgroundColor: '#f8fbff',
            overflow: 'hidden',
          }}
        >
          <summary style={{
            cursor: 'pointer',
            padding: '12px 16px',
            color: '#1e40af',
            fontWeight: 700,
            fontSize: '13px',
          }}>
            最近一次結單日查詢診斷（{lookupDiagnostics.length} 筆；僅供 Field Test，不寫入額外資料）
          </summary>
          <div style={{ maxHeight: '420px', overflowY: 'auto', padding: '0 16px 16px' }}>
            {lookupDiagnostics.map((diagnostic) => (
              <div
                key={diagnostic.groupId}
                style={{
                  padding: '12px 0',
                  borderTop: '1px solid #dbeafe',
                  fontSize: '12px',
                  color: '#334155',
                }}
              >
                <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <strong style={{ color: diagnostic.decision === 'MATCH' ? '#047857' : diagnostic.decision === 'SERVICE_ERROR' ? '#b91c1c' : '#b45309' }}>
                    {diagnostic.decision}
                  </strong>
                  <span>{diagnostic.originalTitle}</span>
                  <span style={{ color: '#64748b' }}>Score {Math.round(diagnostic.score * 100)}%</span>
                  {diagnostic.decisionSource && (
                    <span
                      style={{
                        padding: '2px 6px',
                        borderRadius: '999px',
                        backgroundColor: diagnostic.decisionSource === 'V2_PILOT' ? '#ede9fe' : '#e2e8f0',
                        color: diagnostic.decisionSource === 'V2_PILOT' ? '#6d28d9' : '#475569',
                        fontWeight: 700,
                      }}
                    >
                      Decision Source: {diagnostic.decisionSource}
                    </span>
                  )}
                </div>
                {diagnostic.sourceIdentity && (
                  <div style={{ marginTop: '6px', color: '#475569' }}>
                    <strong>Parser v1 ERP：</strong>類型 {diagnostic.sourceIdentity.productType || '—'} ・
                    Product Line {diagnostic.sourceIdentity.productLine || '—'} ・
                    識別 {diagnostic.sourceIdentity.identity.join('、') || '—'} ・
                    系列 {diagnostic.sourceIdentity.series.join('、') || '—'} ・
                    Version {diagnostic.sourceIdentity.qualifiers.join('、') || '—'} ・
                    尺寸 {diagnostic.sourceIdentity.size || '—'} ・
                    製造商 {diagnostic.sourceIdentity.manufacturer || '—'}
                  </div>
                )}
                {diagnostic.executedQueries && diagnostic.executedQueries.length > 0 && (
                  <div style={{ marginTop: '6px', color: '#475569' }}>
                    <strong>Runtime Queries：</strong>{diagnostic.executedQueries.join(' → ')}
                    {diagnostic.v2Queries && diagnostic.v2Queries.length > 0 && (
                      <span style={{ color: '#6d28d9' }}>（含 Parser v2 fallback）</span>
                    )}
                  </div>
                )}
                {diagnostic.v2Attempted && (
                  <div style={{ marginTop: '4px', color: '#6d28d9' }}>
                    <strong>V2 attempted：</strong>YES
                    {diagnostic.v2RejectReason && (
                      <span> ・ V2 reject reason：{diagnostic.v2RejectReason}</span>
                    )}
                  </div>
                )}
                {diagnostic.v2SafetyVetoReason && (
                  <div style={{ marginTop: '4px', color: '#b91c1c', fontWeight: 700 }}>
                    <strong>V2 Safety Veto：</strong>{diagnostic.v2SafetyVetoReason}
                    （已阻止 v1 自動套用結單日）
                  </div>
                )}
                {isNextIdentityShadowMode && diagnostic.sourceIdentityShadow && (
                  <IdentityShadowBlock shadow={diagnostic.sourceIdentityShadow} />
                )}
                {diagnostic.selected && (
                  <div style={{ marginTop: '6px', padding: '8px 10px', backgroundColor: '#ecfdf5', borderRadius: '6px' }}>
                    <div><strong>Catalog：</strong>{diagnostic.selected.title}</div>
                    <div><strong>Parser v1 Candidate：</strong>類型 {diagnostic.selected.productType || '—'} ・ Product Line {diagnostic.selected.productLine || '—'} ・ 識別 {diagnostic.selected.identity.join('、') || '—'} ・ 系列 {diagnostic.selected.series.join('、') || '—'} ・ Version {diagnostic.selected.qualifiers.join('、') || '—'} ・ 尺寸 {diagnostic.selected.size || '—'}</div>
                    <div>Supplier：{diagnostic.selected.supplier || '—'} ・ Raw Deadline：{diagnostic.selected.rawDeadline || '—'} ・ ERP 結單日：{diagnostic.finalClosingDate || '—'}</div>
                    {diagnostic.decisionSource === 'V2_PILOT' && diagnostic.pilotEvidence && (
                      <div style={{ marginTop: '4px', color: '#6d28d9', fontWeight: 700 }}>
                        V2 Pilot Evidence（Parser v2.1）：{diagnostic.pilotEvidence.join('、')}
                      </div>
                    )}
                    {isNextIdentityShadowMode && diagnostic.selected.identityShadow && (
                      <IdentityShadowBlock
                        shadow={diagnostic.selected.identityShadow}
                        comparison={diagnostic.selected.shadowComparison}
                      />
                    )}
                  </div>
                )}
                {diagnostic.candidates && diagnostic.candidates.length > 0 && (
                  <div style={{ marginTop: '6px' }}>
                    <div style={{ fontWeight: 600 }}>候選／未採用：</div>
                    {diagnostic.candidates.map((candidate, index) => (
                      <div key={`${diagnostic.groupId}-${index}`} style={{ marginTop: '5px', paddingLeft: '10px' }}>
                        <div>{candidate.title} ・ 類型 {candidate.productType || '—'} ・ 識別 {candidate.identity.join('、') || '—'} ・ 尺寸 {candidate.size || '—'} ・ Supplier {candidate.supplier || '—'} ・ Score {candidate.score === null ? '—' : `${Math.round(candidate.score * 100)}%`}</div>
                        {isNextIdentityShadowMode && candidate.identityShadow && (
                          <IdentityShadowBlock
                            shadow={candidate.identityShadow}
                            comparison={candidate.shadowComparison}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {diagnostic.reason && <div style={{ marginTop: '6px', color: '#92400e' }}>原因：{diagnostic.reason}</div>}
              </div>
            ))}
          </div>
        </details>
      )}

      {selectedGroupIds.size > 0 && (
        <div style={{
          backgroundColor: '#fef2f2',
          border: '1px solid #fee2e2',
          borderRadius: '12px',
          padding: '16px',
          marginBottom: '16px',
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          alignItems: isMobile ? 'stretch' : 'center',
          justifyContent: 'space-between',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#991b1b' }}>
              已選取 {selectedGroupIds.size} 筆商品
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {isClosingDateWorkbenchAvailable && (
              <button
                type="button"
                data-testid="open-closing-date-workbench"
                onClick={() => setShowClosingDateWorkbench(true)}
                title={closingDateWorkbenchMode === 'cloud' ? '候選結單日查詢' : 'NEXT FIELD TEST ONLY'}
                style={{
                  padding: '0 14px',
                  height: '36px',
                  backgroundColor: '#059669',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  fontWeight: 700,
                  fontSize: '13px',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Search size={14} />
                <span>分析結單日</span>
                {closingDateWorkbenchMode === 'next' && (
                  <span style={{ fontSize: '9px', padding: '2px 4px', borderRadius: '4px', backgroundColor: 'rgba(255,255,255,0.2)' }}>
                    NEXT ONLY
                  </span>
                )}
              </button>
            )}
            <button
              onClick={() => handleBatchUpdateShowInPurchaseList(true)}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <span>加入採購總表</span>
            </button>
            <button
              onClick={() => handleBatchUpdateShowInPurchaseList(false)}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: '#ea580c',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <span>移出採購總表</span>
            </button>
            {canUseNextFieldTestClosingDateClear(getProviderMode()) && (
              <button
                data-testid="next-field-test-clear-closing-date"
                onClick={handleNextFieldTestClearClosingDates}
                disabled={isClearingClosingDates}
                title="NEXT FIELD TEST ONLY"
                style={{
                  padding: '0 14px',
                  height: '36px',
                  backgroundColor: isClearingClosingDates ? '#a78bfa' : '#7c3aed',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: isClearingClosingDates ? 'wait' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Calendar size={14} />
                <span>{isClearingClosingDates ? '清除中…' : '清除結單日'}</span>
                <span style={{ fontSize: '9px', padding: '2px 4px', borderRadius: '4px', backgroundColor: 'rgba(255,255,255,0.2)' }}>
                  NEXT ONLY
                </span>
              </button>
            )}
            <button
              onClick={handleBatchDelete}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <Trash2 size={14} />
              <span>批次刪除</span>
            </button>
            <button
              onClick={() => setSelectedGroupIds(new Set())}
              style={{
                padding: '0 16px',
                height: '36px',
                backgroundColor: '#ffffff',
                color: '#4b5563',
                border: '1px solid #d1d5db',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              取消選取
            </button>
          </div>
        </div>
      )}

      {/* Table section */}
      {(() => {
        const renderGroupsTable = (list: ProductGroup[], tableId: string) => {
          try {
            return renderGroupsTableInner(list, tableId);
          } catch (err) {
            console.error('[PurchaseRecords] renderGroupsTable crashed:', err);
            logCrash(`renderGroupsTable(${tableId})`, err);
            return (
              <div style={{ padding: '20px', textAlign: 'center', color: '#ef4444' }}>
                <p style={{ fontWeight: 600 }}>表格渲染發生錯誤</p>
                <p style={{ fontSize: '13px', color: '#64748b' }}>請嘗試清除搜尋關鍵字或重新整理頁面</p>
                <pre style={{ fontSize: '11px', color: '#94a3b8', maxWidth: '600px', margin: '8px auto', overflow: 'auto', textAlign: 'left' }}>{String(err)}</pre>
              </div>
            );
          }
        };

        const renderGroupsTableInner = (list: ProductGroup[], tableId: string) => {
          if (isMobile) {
            return (
              <div className="mobile-card-list">
                {list.map((g) => {
                  const details = getGroupPlatformDetails(g.id);
                  const demandAndPurchased = getGroupDemandAndPurchased(g.id);
                  const { skuDisplay, count } = getGroupSkuAndPriceRange(g.id);

                  const isProxy = activeTab === 'proxy';
                  const totalDemand = isProxy 
                    ? (details.myacg + details.wacaManual + details.privateOrder) 
                    : demandAndPurchased.demand;
                  const purchased = isProxy ? details.purchased : demandAndPurchased.purchased;
                  const gap = isProxy ? getDynamicGap(g.id, details.gap) : demandAndPurchased.gap;

                  const isChecked = selectedGroupIds.has(g.id);

                  return (
                    <div 
                      key={g.id}
                      className={`mobile-product-card ${isChecked ? 'selected' : ''}`}
                      onClick={(e) => handleRowClick(g.id, e)}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        padding: '12px',
                        backgroundColor: isChecked ? '#f0fdf4' : '#ffffff',
                        border: isChecked ? '1px solid #86efac' : '1px solid #e2e8f0',
                        borderRadius: '8px',
                        boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
                        gap: '10px'
                      }}
                    >
                      {/* Left: checkbox */}
                      <div className="card-checkbox-wrapper" onClick={e => e.stopPropagation()} style={{ marginTop: '2px', flexShrink: 0 }}>
                        <input 
                          type="checkbox"
                          data-testid={`purchase-record-select-${g.id}`}
                          checked={isChecked}
                          onChange={(e) => {
                            const next = new Set(selectedGroupIds);
                            if (e.target.checked) {
                              next.add(g.id);
                            } else {
                              next.delete(g.id);
                            }
                            setSelectedGroupIds(next);
                          }}
                          style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                        />
                      </div>

                      {/* Right: details stacked */}
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        
                        {/* Line 1: Product Name (max 2 lines) */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '4px', minWidth: 0 }}>
                          <span style={{ 
                            fontSize: '14px', 
                            fontWeight: 600, 
                            color: '#1e293b', 
                            lineHeight: '1.4',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            wordBreak: 'break-word',
                            flex: 1
                          }}>
                            {g.normalized_title || g.title}
                            {gap > 0 && (
                              <span style={{
                                backgroundColor: '#fee2e2',
                                color: '#991b1b',
                                padding: '2px 8px',
                                borderRadius: '12px',
                                fontWeight: 600,
                                fontSize: '12px',
                                marginLeft: '6px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                lineHeight: 1
                              }}>
                                -{gap}
                              </span>
                            )}
                          </span>

                        </div>

                        {/* Line 2: SKU */}
                        <div style={{ fontSize: '12px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          SKU: {skuDisplay}
                        </div>

                        {/* Line 3: Status badge / Variant count / Is in purchase list */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                          <span style={{ 
                            fontSize: '11px', 
                            fontWeight: 600,
                            color: getGroupStatus(g).active ? '#15803d' : '#475569',
                            backgroundColor: getGroupStatus(g).active ? '#dcfce7' : '#f1f5f9',
                            padding: '2px 6px',
                            borderRadius: '4px'
                          }}>
                            {getGroupStatus(g).text}
                          </span>
                          <span style={{ 
                            backgroundColor: '#f1f5f9', 
                            color: '#475569', 
                            fontSize: '11px', 
                            padding: '2px 6px', 
                            borderRadius: '4px', 
                            fontWeight: 500 
                          }}>
                            {count} 規格
                          </span>
                          <span style={{ 
                            fontSize: '11px', 
                            padding: '2px 6px', 
                            borderRadius: '4px', 
                            fontWeight: 600,
                            backgroundColor: (g as any).show_in_purchase_list ? '#dbeafe' : '#f1f5f9',
                            color: (g as any).show_in_purchase_list ? '#1d4ed8' : '#64748b'
                          }}>
                            {(g as any).show_in_purchase_list ? '已入採購單' : '未入採購單'}
                          </span>
                        </div>

                        {/* Line 4: Demands */}
                        <div style={{ fontSize: '13px', color: '#475569', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span>需求 <strong>{totalDemand}</strong></span>
                          <span style={{ color: '#cbd5e1' }}>|</span>
                          <span>已採購 <strong>{purchased}</strong></span>
                          <span style={{ color: '#cbd5e1' }}>|</span>
                          {gap > 0 && (
                            <>
                              <span style={{ color: '#cbd5e1' }}>|</span>
                              <span style={{ color: '#ef4444', fontWeight: 700 }}>-{gap}</span>
                            </>
                          )}
                        </div>

                        {/* Line 5: Closing Date & Release Month */}
                        <div style={{ fontSize: '13px', color: '#475569', display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
                          <div>結單日：{(() => {
                            if (!g.closing_date) return '-';
                            const clean = g.closing_date.replace(/\//g, '-');
                            const parts = clean.split('-');
                            if (parts.length >= 3) {
                              return `${parts[1]}/${parts[2]}`;
                            }
                            return g.closing_date;
                          })()}</div>
                          <div>發售：{formatReleaseMonth(g.release_month)}</div>
                        </div>

                      </div>
                    </div>
                  );
                })}
              </div>
            );
          }

          return (
            <>
              {activeTab === 'proxy' ? (
              <ScrollWrapper isMobile={isMobile}>
                <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed', minWidth: editMode ? '1350px' : undefined }}>
                <thead>
                  <tr>
                    <th style={{ width: '40px', textAlign: 'center' }}>
                      <input 
                        type="checkbox"
                        checked={list.length > 0 && list.every(g => selectedGroupIds.has(g.id))}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedGroupIds(new Set(list.map(g => g.id)));
                          } else {
                            setSelectedGroupIds(new Set());
                          }
                        }}
                      />
                    </th>
                    {editMode && <th style={{ width: `${DELETE_COLUMN_WIDTH}px`, minWidth: `${DELETE_COLUMN_WIDTH}px`, textAlign: 'center', whiteSpace: 'nowrap' }}>刪除</th>}
                    <th style={{ width: '128px' }}>
                      <div className="th-inner justify-center">
                        <span style={{ whiteSpace: 'nowrap' }}>狀態</span>
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.title}px` }}>
                      <div className="th-inner">
                        <span>商品名稱</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('title', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.gap}px` }}>
                      <div className="th-inner justify-center">
                        <span>缺口</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('gap', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.purchased}px` }}>
                      <div className="th-inner justify-center">
                        <span>已採購</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('purchased', e)} />
                      </div>
                    </th>
                    {editMode && (
                      <th style={{ width: `${colWidths.closingDate}px` }}>
                        <div className="th-inner justify-center">
                          <span>官方結單日</span>
                          <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('closingDate', e)} />
                        </div>
                      </th>
                    )}
                    <th style={{ width: '100px' }}>
                      <div className="th-inner justify-center">
                        <span>代理商</span>
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.myacg}px` }}>
                      <div className="th-inner justify-center">
                        <span>買動漫</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('myacg', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.waca}px` }}>
                      <div className="th-inner justify-center">
                        <span>WACA</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('waca', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.privateOrder}px` }}>
                      <div className="th-inner justify-center">
                        <span>私下登記</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('privateOrder', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.totalDemand || 90}px` }}>
                      <div className="th-inner justify-center">
                        <span>總需求</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('totalDemand', e)} />
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((g, idx) => {
                    const details = getGroupPlatformDetails(g.id);
                    const status = getGroupStatus(g);
                    const closingDateStyle = getClosingDateStyle(g.closing_date);

                    const dynamicGap = getDynamicGap(g.id, details.gap);
    
                    return (
                      <tr 
                        key={g.id} 
                        onClick={(e) => handleRowClick(g.id, e)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <input 
                            type="checkbox"
                            data-testid={`purchase-record-select-${g.id}`}
                            checked={selectedGroupIds.has(g.id)}
                            onChange={(e) => {
                              const next = new Set(selectedGroupIds);
                              if (e.target.checked) {
                                next.add(g.id);
                              } else {
                                next.delete(g.id);
                              }
                              setSelectedGroupIds(next);
                            }}
                          />
                        </td>
                        {editMode && (
                          <td style={{ width: `${DELETE_COLUMN_WIDTH}px`, minWidth: `${DELETE_COLUMN_WIDTH}px`, textAlign: 'center', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                            <button 
                              onClick={() => handleDeleteGroup(g.id, g.normalized_title || g.title)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#ef4444',
                                cursor: 'pointer',
                                padding: '4px 8px',
                                fontSize: '12px',
                                fontWeight: 600,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                borderRadius: '4px',
                                transition: 'all 0.2s'
                              }}
                              onMouseEnter={e => {
                                e.currentTarget.style.backgroundColor = '#fef2f2';
                              }}
                              onMouseLeave={e => {
                                e.currentTarget.style.backgroundColor = 'transparent';
                              }}
                            >
                              <Trash2 size={14} />
                              <span>刪除</span>
                            </button>
                          </td>
                        )}
                        <td style={{ textAlign: 'center', fontWeight: 600, whiteSpace: 'nowrap', paddingRight: '20px' }}>
                          {status.text}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          <div className="flex-col gap-xs">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span className="product-name-text" style={{ userSelect: 'text', cursor: 'text' }}>{g.normalized_title || g.title}</span>
                              {dynamicGap > 0 && (
                                <span style={{
                                  backgroundColor: '#fee2e2',
                                  color: '#991b1b',
                                  padding: '2px 8px',
                                  borderRadius: '12px',
                                  fontWeight: 600,
                                  fontSize: '12px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  lineHeight: 1
                                }}>
                                  -{dynamicGap}
                                </span>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigateToDetail(g.id);
                                }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: '#2563eb',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  borderRadius: '4px',
                                  transition: 'all 0.2s',
                                  flexShrink: 0
                                }}
                                onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#eff6ff'; }}
                                onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                                title="進入商品詳情"
                              >
                                <ExternalLink size={14} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyTitle(g.id, g.normalized_title || g.title);
                                }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: copiedGroupId === g.id ? '#10b981' : '#94a3b8',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  borderRadius: '4px',
                                  transition: 'all 0.2s',
                                  flexShrink: 0
                                }}
                                title="複製商品名稱"
                              >
                                {copiedGroupId === g.id ? (
                                  <>
                                    <Check size={14} style={{ color: '#10b981' }} />
                                    <span style={{ fontSize: '11px', fontWeight: 600, color: '#10b981' }}>已複製</span>
                                  </>
                                ) : (
                                  <Copy size={14} />
                                )}
                              </button>

                            </div>
                            {editMode ? (
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                                {g.listing_type && (
                                  <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                    {g.listing_type}
                                  </span>
                                )}
                              </div>
                            ) : (() => {
                              const isClosed = closingDateStyle.color === '#ef4444';
                              const isUrgent = closingDateStyle.color === '#f97316';
                              const closingDateTagStyle = isClosed
                                ? { background: '#fee2e2', color: '#ef4444', border: '1px solid #fca5a5' }
                                : isUrgent
                                ? { background: '#ffedd5', color: '#ea580c', border: '1px solid #fed7aa' }
                                : { background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0' };

                              const formatClosingDateSimplified = (dateStr: string | undefined | null) => {
                                if (!dateStr) return '';
                                const clean = dateStr.replace(/\//g, '-');
                                const parts = clean.split('-');
                                if (parts.length >= 3) {
                                  return `結單 ${parts[1]}/${parts[2]}`;
                                }
                                return `結單 ${dateStr}`;
                              };

                              return (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'center', fontSize: '11px', marginTop: '4px' }}>
                                  {g.listing_type && (
                                    <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                      {g.listing_type}
                                    </span>
                                  )}
                                  {g.closing_date && (
                                    <span style={{ ...closingDateTagStyle, borderRadius: '4px', padding: '2px 6px', display: 'inline-flex', alignItems: 'center', fontWeight: isClosed || isUrgent ? 600 : 500 }}>
                                      {formatClosingDateSimplified(g.closing_date)}
                                    </span>
                                  )}
                                  {g.release_month && (
                                    <span style={{ background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '2px 6px', fontWeight: 500 }}>
                                      發售：{formatReleaseMonth(g.release_month)}
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: '#ef4444' }}>
                          {dynamicGap > 0 ? `-${dynamicGap}` : ''}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input
                              data-testid={`proxy-purchased-quantity-${g.id}`}
                              aria-label={`代理版商品 ${g.normalized_title || g.title} 叫貨數量`}
                              aria-busy={pendingDemandCommits.has(`${g.id}_purchased`)}
                              disabled={pendingDemandCommits.has(`${g.id}_purchased`)}
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input"
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }}
                              value={draftDemands[`${g.id}_purchased`] !== undefined ? draftDemands[`${g.id}_purchased`] : String(details.purchased)}
                              onChange={e => handleUpdateDraft(g.id, 'purchased', e.target.value.replace(/[^0-9]/g, ''))}
                              onBlur={() => handleCommitDraft(g.id, 'purchased')}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                  handleCancelDraft(g.id, 'purchased');
                                  e.currentTarget.blur();
                                }
                              }}
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.purchased
                          )}</td>
                        {editMode && (
                          <td style={{ textAlign: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', position: 'relative' }}>
                              <input
                                className="input"
                                type="text"
                                placeholder="YYYY/MM/DD"
                                style={{ flex: 1, minWidth: 0, height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }}
                                value={getClosingDateInputVal(g)}
                                onChange={e => setDraftClosingDates(prev => ({ ...prev, [g.id]: e.target.value }))}
                                onClick={e => e.stopPropagation()}
                                onBlur={() => handleCommitClosingDate(g.id, getClosingDateInputVal(g))}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    handleCommitClosingDate(g.id, getClosingDateInputVal(g));
                                  } else if (e.key === 'Escape') {
                                    handleCancelClosingDateDraft(g.id);
                                    e.currentTarget.blur();
                                  }
                                  handleKeyDown(e, idx, 'closing_date', tableId);
                                }}
                                onPaste={e => handlePaste(e, idx, 'closing_date', list)}
                                data-table={tableId}
                                data-row={idx}
                                data-field="closing_date"
                                aria-invalid={closingDateSaveErrors[g.id] ? 'true' : undefined}
                                title={closingDateSaveErrors[g.id] || undefined}
                              />
                              {closingDateSaveErrors[g.id] && (
                                <span data-testid="closing-date-save-error" style={{ color: '#dc2626', fontSize: '11px', whiteSpace: 'nowrap' }}>
                                  {closingDateSaveErrors[g.id]}
                                </span>
                              )}
                              <Calendar
                                size={14}
                                style={{ flexShrink: 0, color: '#64748b', cursor: 'pointer' }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  datePickerRefs.current[g.id]?.showPicker();
                                }}
                              />
                              <input
                                type="date"
                                ref={el => { datePickerRefs.current[g.id] = el; }}
                                style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                                value={g.closing_date ? g.closing_date.replace(/\//g, '-') : ''}
                                onChange={e => handleUpdateGroupField(g.id, 'closing_date', e.target.value)}
                                onClick={e => e.stopPropagation()}
                              />
                            </div>
                          </td>
                        )}
                        <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <select
                            value={g.proxy_agent || ''}
                            onChange={(e) => handleUpdateAgent(g.id, e.target.value)}
                            className="select"
                            style={{ 
                              width: '100%', 
                              height: '32px', 
                              padding: '0 4px', 
                              fontSize: '13px', 
                              borderRadius: '4px',
                              border: '1px solid #d1d5db',
                              backgroundColor: '#fff',
                              color: g.proxy_agent ? '#1e293b' : '#94a3b8',
                              fontWeight: g.proxy_agent ? 600 : 400
                            }}
                          >
                            <option value="">(無)</option>
                            <option value="鉅霖">鉅霖</option>
                            <option value="萬榮">萬榮</option>
                          </select>
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              aria-busy={pendingDemandCommits.has(`${g.id}_myacg`)}
                              disabled={pendingDemandCommits.has(`${g.id}_myacg`)}
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={draftDemands[`${g.id}_myacg`] !== undefined ? draftDemands[`${g.id}_myacg`] : String(details.myacg)} 
                              onChange={e => handleUpdateDraft(g.id, 'myacg', e.target.value.replace(/[^0-9]/g, ''))} 
                              onBlur={() => handleCommitDraft(g.id, 'myacg')}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                  handleCancelDraft(g.id, 'myacg');
                                  e.currentTarget.blur();
                                }
                              }}
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.myacg
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              aria-busy={pendingDemandCommits.has(`${g.id}_waca`)}
                              disabled={pendingDemandCommits.has(`${g.id}_waca`)}
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={draftDemands[`${g.id}_waca`] !== undefined ? draftDemands[`${g.id}_waca`] : String(details.wacaManual)} 
                              onChange={e => handleUpdateDraft(g.id, 'waca', e.target.value.replace(/[^0-9]/g, ''))} 
                              onBlur={() => handleCommitDraft(g.id, 'waca')}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                  handleCancelDraft(g.id, 'waca');
                                  e.currentTarget.blur();
                                }
                              }}
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.wacaManual
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#475569' }}>
                          {details.privateOrder}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, color: '#1e293b' }}>
                          {(() => {
                            const myacgVal = (editMode && isProxyProduct(g) && draftDemands[`${g.id}_myacg`] !== undefined)
                              ? (parseInt(draftDemands[`${g.id}_myacg`], 10) || 0)
                              : details.myacg;
                            const wacaVal = (editMode && isProxyProduct(g) && draftDemands[`${g.id}_waca`] !== undefined)
                              ? (parseInt(draftDemands[`${g.id}_waca`], 10) || 0)
                              : details.wacaManual;
                            const privateVal = details.privateOrder;
                            return myacgVal + wacaVal + privateVal;
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </ScrollWrapper>
            ) : (
              <ScrollWrapper isMobile={isMobile}>
                <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed', minWidth: editMode ? '1200px' : undefined }}>
                <thead className="purchase-records-sticky-header">
                  <tr>
                    <th style={{ width: '40px', textAlign: 'center' }}>
                      <input 
                        type="checkbox"
                        checked={list.length > 0 && list.every(g => selectedGroupIds.has(g.id))}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedGroupIds(new Set(list.map(g => g.id)));
                          } else {
                            setSelectedGroupIds(new Set());
                          }
                        }}
                      />
                    </th>
                    {editMode && <th style={{ width: `${DELETE_COLUMN_WIDTH}px`, minWidth: `${DELETE_COLUMN_WIDTH}px`, textAlign: 'center', whiteSpace: 'nowrap' }}>刪除</th>}
                    <th style={{ width: '128px' }}>
                      <div className="th-inner justify-center">
                        <span style={{ whiteSpace: 'nowrap' }}>狀態</span>
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.title}px` }}>
                      <div className="th-inner">
                        <span>商品名稱</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('title', e)} />
                      </div>
                    </th>
                    {editMode && (
                      <>
                        <th style={{ width: `${colWidths.gap}px` }}>
                          <div className="th-inner justify-center">
                            <span>缺口</span>
                            <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('gap', e)} />
                          </div>
                        </th>
                        <th style={{ width: `${colWidths.closingDate}px` }}>
                          <div className="th-inner justify-center">
                            <span>官方結單日</span>
                            <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('closingDate', e)} />
                          </div>
                        </th>
                        <th style={{ width: `${colWidths.releaseMonth}px` }}>
                          <div className="th-inner justify-center">
                            <span>發售月份</span>
                            <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('releaseMonth', e)} />
                          </div>
                        </th>
                        <th style={{ width: `${colWidths.productUrl}px` }}>
                          <div className="th-inner justify-center">
                            <span>官網</span>
                            <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('productUrl', e)} />
                          </div>
                        </th>
                      </>
                    )}
                    <th style={{ width: `${colWidths.myacg}px` }}>
                      <div className="th-inner justify-center">
                        <span>買動漫</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('myacg', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.waca}px` }}>
                      <div className="th-inner justify-center">
                        <span>WACA</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('waca', e)} />
                      </div>
                    </th>
                    <th style={{ width: `${colWidths.purchased}px` }}>
                      <div className="th-inner justify-center">
                        <span>已採購</span>
                        <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('purchased', e)} />
                      </div>
                    </th>
                    {!editMode && (
                      <th style={{ width: `${colWidths.gap}px` }}>
                        <div className="th-inner justify-center">
                          <span>缺口</span>
                          <div className="resizer-handle" onMouseDown={(e) => handleMouseDown('gap', e)} />
                        </div>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {list.map((g, idx) => {
                    const details = getGroupPlatformDetails(g.id);
                    const demandAndPurchased = getGroupDemandAndPurchased(g.id);
                    const status = getGroupStatus(g);
                    const closingDateStyle = getClosingDateStyle(g.closing_date);
    
                    return (
                      <tr 
                        key={g.id} 
                        onClick={(e) => handleRowClick(g.id, e)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <input 
                            type="checkbox"
                            data-testid={`purchase-record-select-${g.id}`}
                            checked={selectedGroupIds.has(g.id)}
                            onChange={(e) => {
                              const next = new Set(selectedGroupIds);
                              if (e.target.checked) {
                                next.add(g.id);
                              } else {
                                next.delete(g.id);
                              }
                              setSelectedGroupIds(next);
                            }}
                          />
                        </td>
                        {editMode && (
                          <td style={{ width: `${DELETE_COLUMN_WIDTH}px`, minWidth: `${DELETE_COLUMN_WIDTH}px`, textAlign: 'center', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                            <button 
                              onClick={() => handleDeleteGroup(g.id, g.normalized_title || g.title)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#ef4444',
                                cursor: 'pointer',
                                padding: '4px 8px',
                                fontSize: '12px',
                                fontWeight: 600,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                borderRadius: '4px',
                                transition: 'all 0.2s'
                              }}
                              onMouseEnter={e => {
                                e.currentTarget.style.backgroundColor = '#fef2f2';
                              }}
                              onMouseLeave={e => {
                                e.currentTarget.style.backgroundColor = 'transparent';
                              }}
                            >
                              <Trash2 size={14} />
                              <span>刪除</span>
                            </button>
                          </td>
                        )}
                        <td style={{ textAlign: 'center', fontWeight: 600, whiteSpace: 'nowrap', paddingRight: '20px' }}>
                          {editMode ? (
                            status.text
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px' }}>
                              <span>{status.text}</span>
                              {g.listing_type && (
                                <span style={{ 
                                  backgroundColor: '#e2e8f0', 
                                  color: '#475569', 
                                  fontSize: '10px', 
                                  padding: '1px 4px', 
                                  borderRadius: '3px', 
                                  fontWeight: 500,
                                  marginTop: '2px'
                                }}>
                                  {g.listing_type}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          <div className="flex-col gap-xs">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span className="product-name-text" style={{ userSelect: 'text', cursor: 'text' }}>{g.normalized_title || g.title}</span>
                              {demandAndPurchased.gap > 0 && (
                                <span style={{
                                  backgroundColor: '#fee2e2',
                                  color: '#991b1b',
                                  padding: '2px 8px',
                                  borderRadius: '12px',
                                  fontWeight: 600,
                                  fontSize: '12px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  lineHeight: 1
                                }}>
                                  -{demandAndPurchased.gap}
                                </span>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigateToDetail(g.id);
                                }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: '#2563eb',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  borderRadius: '4px',
                                  transition: 'all 0.2s',
                                  flexShrink: 0
                                }}
                                onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#eff6ff'; }}
                                onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                                title="進入商品詳情"
                              >
                                <ExternalLink size={14} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyTitle(g.id, g.normalized_title || g.title);
                                }}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: '4px',
                                  cursor: 'pointer',
                                  color: copiedGroupId === g.id ? '#10b981' : '#94a3b8',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  borderRadius: '4px',
                                  transition: 'all 0.2s',
                                  flexShrink: 0
                                }}
                                title="複製商品名稱"
                              >
                                {copiedGroupId === g.id ? (
                                  <>
                                    <Check size={14} style={{ color: '#10b981' }} />
                                    <span style={{ fontSize: '11px', fontWeight: 600, color: '#10b981' }}>已複製</span>
                                  </>
                                ) : (
                                  <Copy size={14} />
                                )}
                              </button>

                            </div>
                            {editMode ? (
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                                {g.listing_type && (
                                  <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                    {g.listing_type}
                                  </span>
                                )}
                              </div>
                            ) : (() => {
                              const isClosed = closingDateStyle.color === '#ef4444';
                              const isUrgent = closingDateStyle.color === '#f97316';
                              const closingDateTagStyle = isClosed
                                ? { background: '#fee2e2', color: '#ef4444', border: '1px solid #fca5a5' }
                                : isUrgent
                                ? { background: '#ffedd5', color: '#ea580c', border: '1px solid #fed7aa' }
                                : { background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0' };
    
                              const formatClosingDateSimplified = (dateStr: string | undefined | null) => {
                                if (!dateStr) return '';
                                const clean = dateStr.replace(/\//g, '-');
                                const parts = clean.split('-');
                                if (parts.length >= 3) {
                                  return `結單 ${parts[1]}/${parts[2]}`;
                                }
                                return `結單 ${dateStr}`;
                              };
    
                              return (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'center', fontSize: '11px', marginTop: '4px' }}>
                                  {g.closing_date && (
                                    <span style={{ ...closingDateTagStyle, borderRadius: '4px', padding: '2px 6px', display: 'inline-flex', alignItems: 'center', fontWeight: isClosed || isUrgent ? 600 : 500 }}>
                                      {formatClosingDateSimplified(g.closing_date)}
                                    </span>
                                  )}
                                  {g.release_month && (
                                    <span style={{ background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '2px 6px', fontWeight: 500 }}>
                                      發售：{formatReleaseMonth(g.release_month)}
                                    </span>
                                  )}
                                  {g.product_url && (
                                    <a 
                                      href={g.product_url} 
                                      target="_blank" 
                                      rel="noreferrer" 
                                      onClick={e => e.stopPropagation()}
                                      style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                                      onMouseEnter={e => { e.currentTarget.style.color = '#1d4ed8'; }}
                                      onMouseLeave={e => { e.currentTarget.style.color = '#2563eb'; }}
                                    >
                                      🔗 官網
                                    </a>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </td>
                        {editMode && (
                          <td style={{ textAlign: 'center', fontWeight: 700, color: '#ef4444' }}>
                            {demandAndPurchased.gap > 0 ? `-${demandAndPurchased.gap}` : ''}
                          </td>
                        )}
                        {editMode && (
                          <td style={{ textAlign: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', position: 'relative' }}>
                              <input
                                className="input"
                                type="text"
                                placeholder="YYYY/MM/DD"
                                style={{ flex: 1, minWidth: 0, height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }}
                                value={getClosingDateInputVal(g)}
                                onChange={e => setDraftClosingDates(prev => ({ ...prev, [g.id]: e.target.value }))}
                                onClick={e => e.stopPropagation()}
                                onBlur={() => handleCommitClosingDate(g.id, getClosingDateInputVal(g))}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    handleCommitClosingDate(g.id, getClosingDateInputVal(g));
                                  } else if (e.key === 'Escape') {
                                    handleCancelClosingDateDraft(g.id);
                                    e.currentTarget.blur();
                                  }
                                  handleKeyDown(e, idx, 'closing_date', tableId);
                                }}
                                onPaste={e => handlePaste(e, idx, 'closing_date', list)}
                                data-table={tableId}
                                data-row={idx}
                                data-field="closing_date"
                                aria-invalid={closingDateSaveErrors[g.id] ? 'true' : undefined}
                                title={closingDateSaveErrors[g.id] || undefined}
                              />
                              {closingDateSaveErrors[g.id] && (
                                <span data-testid="closing-date-save-error" style={{ color: '#dc2626', fontSize: '11px', whiteSpace: 'nowrap' }}>
                                  {closingDateSaveErrors[g.id]}
                                </span>
                              )}
                              <Calendar
                                size={14}
                                style={{ flexShrink: 0, color: '#64748b', cursor: 'pointer' }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  datePickerRefs.current[g.id]?.showPicker();
                                }}
                              />
                              <input
                                type="date"
                                ref={el => { datePickerRefs.current[g.id] = el; }}
                                style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                                value={g.closing_date ? g.closing_date.replace(/\//g, '-') : ''}
                                onChange={e => handleUpdateGroupField(g.id, 'closing_date', e.target.value)}
                                onClick={e => e.stopPropagation()}
                              />
                            </div>
                          </td>
                        )}
                        {editMode && (
                          <>
                            <td style={{ textAlign: 'center' }}>
                              <input
                                className="input"
                                style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px' }}
                                value={g.release_month || ''}
                                onChange={e => handleUpdateGroupField(g.id, 'release_month', e.target.value)}
                                onClick={e => e.stopPropagation()}
                                onKeyDown={e => handleKeyDown(e, idx, 'release_month', tableId)}
                                onPaste={e => handlePaste(e, idx, 'release_month', list)}
                                data-table={tableId}
                                data-row={idx}
                                data-field="release_month"
                                placeholder="例如：2026-11"
                              />
                            </td>
                            <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                              <input
                                className="input"
                                style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px' }}
                                value={g.product_url || ''}
                                onChange={e => handleUpdateGroupField(g.id, 'product_url', e.target.value)}
                                onKeyDown={e => handleKeyDown(e, idx, 'product_url', tableId)}
                                onPaste={e => handlePaste(e, idx, 'product_url', list)}
                                data-table={tableId}
                                data-row={idx}
                                data-field="product_url"
                                placeholder="官網網址"
                              />
                            </td>
                          </>
                        )}
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.myacg} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'myacg', parseInt(e.target.value.replace(/[^0-9]/g, '')) || 0)} 
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.myacg
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {editMode && isProxyProduct(g) ? (
                            <input 
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="input" 
                              style={{ width: '100%', height: '32px', padding: '0 8px', fontSize: '13px', textAlign: 'center' }} 
                              value={details.wacaManual} 
                              onChange={e => handleUpdateGroupPlatformDemand(g.id, 'waca', parseInt(e.target.value.replace(/[^0-9]/g, '')) || 0)} 
                              onClick={e => e.stopPropagation()}
                            />
                          ) : (
                            details.wacaManual
                          )}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: '#334155' }}>
                          {details.purchased}
                        </td>
                        {!editMode && (
                          <td style={{ textAlign: 'center', fontWeight: 700, color: '#ef4444' }}>
                            {demandAndPurchased.gap > 0 ? `-${demandAndPurchased.gap}` : ''}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </ScrollWrapper>
            )}
          </>
        );
      };
    
      return (
        <div className="flex-col gap-md">
          {(displayedMainGroups.length === 0 && displayedCompletedGroups.length === 0) ? (
            <EmptyState
              icon={Receipt}
              title={groups.length === 0 ? "尚未有訂購紀錄" : "找不到符合的紀錄"}
              description={groups.length === 0 ? "您可以透過匯入商品清單來自動產生母體，或手動建立。" : "請嘗試調整搜尋關鍵字或篩選條件。"}
              actionLabel={groups.length === 0 ? "前往商品清單匯入" : ""}
              onAction={() => groups.length === 0 ? navigate('/inventory') : undefined}
            />
          ) : (
            <div className="flex-col gap-md">
              {displayedMainGroups.length > 0 && (
                <div className="card" style={{ padding: 0, overflow: 'hidden', width: '100%', maxWidth: '100%' }}>
                  {renderGroupsTable(displayedMainGroups, 'main')}
                </div>
              )}
    
              {secondaryTab === 'progress' && displayedCompletedGroups.length > 0 && (
                <div style={{ marginTop: '8px' }}>
                  <button
                    onClick={() => setCompletedExpanded(!completedExpanded)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '12px 16px',
                      backgroundColor: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: '12px',
                      fontSize: '14px',
                      fontWeight: 600,
                      color: '#475569',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)'
                    }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = '#f1f5f9'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = '#f8fafc'}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{completedExpanded ? '▼' : '▶'}</span>
                      <span>已過結單日商品 ({displayedCompletedGroups.length})</span>
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#94a3b8', fontWeight: 500 }}>
                      {completedExpanded ? '點擊收合' : '點擊展開'}
                    </span>
                  </button>
                  {completedExpanded && (
                    <div className="card" style={{ padding: 0, overflow: 'hidden', width: '100%', maxWidth: '100%', marginTop: '8px' }}>
                      {renderGroupsTable(displayedCompletedGroups, 'completed')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      );
    })()}

      {/* WACA 更新紀錄對話框 */}
      {showWacaDialog && (
        <div 
          className={`modal-overlay ${animateWacaDialog ? 'active' : ''}`} 
          onClick={closeWacaDialog}
        >
          <div 
            className="modal-content" 
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '360px' }}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>更新 WACA 記錄</h3>
            </div>
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>選擇更新人</label>
                <select
                  id="waca-updater-select"
                  value={selectedWacaUpdater}
                  onChange={e => setSelectedWacaUpdater(e.target.value as any)}
                  style={{
                    width: '100%',
                    height: '38px',
                    padding: '0 10px',
                    fontSize: '14px',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    outline: 'none',
                    backgroundColor: '#fff',
                    color: '#0f172a'
                  }}
                >
                  <option value="小河馬">小河馬</option>
                  <option value="Flanlove">Flanlove</option>
                  <option value="許願">許願</option>
                  <option value="江尚恩">江尚恩</option>
                </select>
              </div>
            </div>
            <div style={{
              padding: '12px 20px',
              backgroundColor: '#f8fafc',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px'
            }}>
              <button
                onClick={closeWacaDialog}
                style={{
                  padding: '6px 14px',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: '#475569',
                  backgroundColor: '#fff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                取消
              </button>
              <button
                onClick={() => handleUpdateWacaMeta(selectedWacaUpdater)}
                style={{
                  padding: '6px 14px',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: '#fff',
                  backgroundColor: '#2563eb',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                儲存
              </button>
            </div>
          </div>
        </div>
      )}

      {isClosingDateWorkbenchAvailable && showClosingDateWorkbench && (
        <Suspense fallback={(
          <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'grid', placeItems: 'center', background: 'rgba(15,23,42,0.55)', color: '#fff', fontWeight: 700 }}>
            載入結單日工作台…
          </div>
        )}>
          <ClosingDateResolutionWorkbench
            selectedGroups={closingDateWorkbenchSelection}
            allGroups={groups}
            onClose={() => setShowClosingDateWorkbench(false)}
            applySelections={closingDateWorkbenchMode === 'cloud'
              ? applyCloudClosingDateSelections
              : undefined}
            onApplied={async appliedCount => {
              await loadData();
              setSelectedGroupIds(new Set());
              setClosingDateApplyNotice(`已成功套用 ${appliedCount} 筆結單日`);
            }}
          />
        </Suspense>
      )}

      {closingDateApplyNotice && (
        <div
          role="status"
          data-testid="closing-date-apply-success"
          style={{
            position: 'fixed',
            top: '20px',
            right: '20px',
            zIndex: 2100,
            padding: '11px 16px',
            border: '1px solid #86efac',
            borderRadius: '9px',
            background: '#f0fdf4',
            color: '#166534',
            boxShadow: '0 10px 30px rgba(15, 23, 42, 0.16)',
            fontWeight: 700,
          }}
        >
          {closingDateApplyNotice}
        </div>
      )}
      
      {/* Floating Action Button (FAB) */}
      <button
        data-testid="purchase-records-edit-mode-toggle"
        onClick={toggleEditMode}
        style={{
          position: 'fixed',
          bottom: isMobile ? 'calc(env(safe-area-inset-bottom) + 72px)' : '24px',
          right: isMobile ? '16px' : '24px',
          zIndex: 9999,
          height: isMobile ? '40px' : '46px',
          padding: isMobile ? '10px 16px' : '0 24px',
          fontWeight: 700,
          fontSize: isMobile ? '13px' : '14px',
          borderRadius: '9999px',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          backgroundColor: editMode ? '#ea580c' : '#2563eb',
          color: '#ffffff',
          boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
          transition: 'all 0.2s ease',
          outline: 'none'
        }}
      >
        {editMode ? '✏️ 編輯模式' : '🔒 鎖定模式'}
      </button>
    </div>
  );
}
