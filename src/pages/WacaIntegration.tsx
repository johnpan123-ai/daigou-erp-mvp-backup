import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileSpreadsheet, Link2, RefreshCw } from 'lucide-react';
import { PageHeader, PageShell } from '../components/layout/PageHeader';
import { FileUploadButton } from '../components/FileUploadButton';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';
import { supabaseEnvironment } from '../providers/cloud/supabaseClient';
import { parseMyAcgFile } from '../utils/myacgParser';
import { normalizeProductTitle, type InventoryItem, type ProductGroup, type ProductVariant } from '../lib/db';
import { productGroupDisplayName } from '../lib/productGroupDisplayName';
import {
  cloneWacaRepository, importWacaRows, indexWacaMaster,
  isWacaDiscount, matchWacaItem, refreshWacaMasterStatus, rematchHistoricalWaca,
  setWacaMapping, wacaFeature, wacaOrderKey,
  type MasterVariant, type WacaImportResult, type WacaItem, type WacaRow, type WacaStatus,
} from '../waca/orderCore';
import {
  buildWacaMasterReference, linksFromMyAcgInventory, mergeMyAcgMasterLinks,
  planMyAcgMasterLinkDelta,
  type LinkImportResult, type MyAcgMasterLink,
} from '../waca/masterReference';
import {
  repositoryFromSnapshot, snapshotFromRepository,
  type NextWacaSnapshot, type WacaBatch,
} from '../waca/nextStorage';
import { parseWacaWorkbook } from '../waca/workbookParser';
import { reconcileWacaReadback } from '../waca/reconciliation';
import {
  buildWacaPreviewComparisons, isWacaPreviewVariantVisible,
  type WacaVariantPreviewComparison,
} from '../waca/previewReconciliation';
import { supportsWacaProvider } from '../waca/providerSupport';
import { classifyWacaError, wacaNotice, type WacaStage, type WacaUiError } from '../waca/importErrors';
import { commitAndVerifyWaca, commitAndVerifyWacaCounted, commitAndVerifyWacaRematch } from '../waca/confirmFlow';
import {
  applyCountedItems, planWacaCountedImport, wacaTransitionContext,
  type WacaCountedImportResult, type WacaCountedItemPreview, type WacaVariantCountedPreview, type WacaOverlapChoice, type WacaTransitionContext, type WacaUpdateMode,
} from '../waca/countedImport';
import { hasWacaPreviewReview, isWacaCountedReviewRowVisible } from '../waca/previewVisibility';
import { type WacaRepository } from '../waca/orderCore';
import { useCloudResourceSync, useGlobalSyncControl } from '../contexts/CloudRealtimeSyncContext';
import './WacaIntegration.css';
import { OrderRecognitionManager } from '../waca/OrderRecognitionManager';

type Tab = 'import' | 'orders' | 'mappings' | 'history' | 'pending';
type PendingImport = {
  fileName: string;
  rows: WacaRow[];
  revision: number;
  importId: string;
  result: WacaImportResult;
  items: WacaItem[];
  candidateOrders: Array<{ key: string; orderNumber: string; status: WacaStatus }>;
  links: MyAcgMasterLink[];
  comparisonByVariant: Map<string, WacaVariantPreviewComparison>;
  /** Cloud transition import (073): planned against this ledger / Restore epoch. */
  counted: { context: WacaTransitionContext; currentRepo: WacaRepository; candidate: WacaRepository; importedKeys: Set<string> } | null;
};
const MODE_LABEL: Record<WacaUpdateMode, string> = { OVERWRITE: '覆蓋', ACCUMULATE: '累加', KEEP: '維持' };
const STATE_LABEL: Record<string, string> = { COUNTED: '已計入', PENDING: '待核對（未計入）', BASELINE: '已含在 ERP1 歷史', UNMATCHED: '未配對' };
/** Display only: orders whose WACA status is not effective never add quantity, whatever the counted reason says. */
const NOT_COUNTED_STATUS_LABEL: Partial<Record<WacaStatus, string>> = { 取消: '已取消｜不計入數量', 失敗: '付款失敗｜不計入數量' };
type GroupModeState = WacaUpdateMode | 'MIXED' | 'NONE';
const groupModeState = (modes: WacaUpdateMode[]): GroupModeState => !modes.length ? 'NONE'
  : modes.every(mode => mode === modes[0]) ? modes[0] : 'MIXED';
const REASON_LABEL: Record<string, string> = {
  LEGACY_COUNTED: '已計入', NEW_AFTER_BASELINE: '原已認列訂單', NORMAL_IMPORT: '有效來源正常認列', OWNER_CONFIRMED_NEW: 'Owner 確認為新訂單',
  SOURCE_CHANGE_APPLIED: '來源數量／狀態變更已套用', OVERWRITE: '覆蓋計入', BASELINE_INCLUDED: '已含在 ERP1 歷史數量',
  PENDING_REVIEW: '認列證據待核對，暫不調整數量', KEPT: '本次維持（暫不更新），下次匯入可重新判斷',
};
const MODE_HELP: Record<WacaUpdateMode, string> = {
  OVERWRITE: '依來源結果重新計算', ACCUMULATE: '保留原有數量並加上認列新增', KEEP: '本次暫不更新，下次匯入可重新判斷',
};
const UPDATE_MODES = ['OVERWRITE', 'ACCUMULATE', 'KEEP'] as const;
/** Owner decision 2026-10-18: every spec of a new preview starts as 累加. The preview plan and the confirm re-plan both use
 *  this constant with the same Owner choices (updateModes), so what is shown is exactly what is submitted. */
const WACA_DEFAULT_UPDATE_MODE: WacaUpdateMode = 'ACCUMULATE';
type PendingLinks = { fileName: string; revision: number; result: LinkImportResult; links: MyAcgMasterLink[] };
type UnresolvedPreviewTrace = {
  key: string; orderNumber: string; status: string; quantity: number; reason: string;
};

const statusText: Record<string, string> = {
  MASTER_EVIDENCE_MISSING: '找不到對應商品',
  MASTER_MAPPING_MISSING: '找不到對應商品',
  MASTER_GROUP_LINK_MISSING: '商品群組需要確認',
  VARIANT_NOT_MATCHED: '規格需要確認',
  MULTIPLE_VARIANT_CANDIDATES: '找到多個可能規格',
  VARIANT_NOT_IN_ERP: '找不到對應商品',
  PRODUCT_NOT_IN_MASTER: '找不到對應商品',
  NAME_CONFLICT: '商品名稱需要確認',
  SPEC_CODE_MISSING: '缺少規格編號，請確認來源訂單',
  SPEC_CODE_CONFLICT: '人工對照與規格編號不一致，請確認',
  AMBIGUOUS_VARIANT: '規格編號空白，商品有多個可能規格，請人工確認一次',
  PARENT_AMBIGUOUS: '商品編號對應多個商品群組，請確認來源資料',
  PARENT_NAME_CONFLICT: '商品編號與商品名稱不一致，請確認來源資料',
  SPEC_NAME_NOT_MATCHED: '規格名稱沒有唯一對應，請人工確認一次',
  SOURCE_SPEC_IDENTITY_CONFLICT: '同一訂單已有明確規格列；請先核對舊空白規格列，避免重複計量',
};

const resolutionText = (item: WacaItem): string => {
  if (!item.productVariantId) return item.diagnostic === 'AMBIGUOUS_VARIANT'
    ? `待處理：規格編號空白且商品有 ${item.candidateCount ?? '多'} 個可能規格`
    : `待處理：${statusText[item.diagnostic ?? ''] ?? '規格需要確認'}`;
  if (item.resolution === 'SPEC_CODE_EXACT') return '規格編號精確配對';
  if (item.match === 'MANUAL_MATCH') return '人工確認對照';
  if (item.resolution === 'SPEC_NAME_EXACT_UNIQUE') return '依規格名稱唯一配對';
  if (item.resolution === 'UNIQUE_PARENT_VARIANT') return '無規格商品／唯一規格自動配對';
  if (item.resolution === 'PRODUCT_SPEC_EXACT' || item.resolution === 'PRODUCT_UNIQUE_SPEC') return '商品名稱與規格唯一配對';
  if (item.resolution === 'PRODUCT_SINGLE_VARIANT') return '商品名稱唯一／單一規格自動配對';
  if (item.resolution === 'GLOBAL_UNIQUE_COMBINATION') return '完整商品與規格組合唯一配對';
  if (item.resolution === 'ALIAS_UNIQUE') return '商品別名與規格唯一配對';
  if (item.resolution === 'LEARNED_PARENT_SPEC') return '已驗證商品對照／規格唯一配對';
  return '已配對';
};

const quantity = (value: number) => value.toLocaleString('zh-TW');
const signedQuantity = (value: number) => value > 0 ? `+${quantity(value)}` : quantity(value);
const isPending = (item: WacaItem) => !item.productVariantId;
const readErrorText = (cause: unknown) => classifyWacaError(cause, 'read');

export default function WacaIntegration() {
  const [tab, setTab] = useState<Tab>('import');
  const [visitedMappings, setVisitedMappings] = useState(false);
  const [snapshot, setSnapshot] = useState<NextWacaSnapshot | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [chosenFileName, setChosenFileName] = useState('');
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [showOnlyBaselineDifferences, setShowOnlyBaselineDifferences] = useState(false);
  const [expandedTraces, setExpandedTraces] = useState<ReadonlySet<string>>(new Set());
  const [updateModes, setUpdateModes] = useState<ReadonlyMap<string, WacaUpdateMode>>(new Map());
  const [overlapChoices, setOverlapChoices] = useState<ReadonlyMap<string, WacaOverlapChoice>>(new Map());
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [onlyChangedSpecs, setOnlyChangedSpecs] = useState(true);
  const [includeReviewSpecs, setIncludeReviewSpecs] = useState(true);
  // Groups opened / closed by the Owner for one preview; before the first toggle the needs-review groups are open.
  const [openState, setOpenState] = useState<{ importId: string; ids: ReadonlySet<string> } | null>(null);
  const countedSupported = dataProvider.supportsWacaCountedImport();
  const [pendingLinks, setPendingLinks] = useState<PendingLinks | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<Record<string, string>>({});
  const [selectedParent, setSelectedParent] = useState<Record<string, string>>({});
  const [selectedStatus, setSelectedStatus] = useState<Record<string, WacaStatus>>({});
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [completion, setCompletion] = useState<{ orders: number; variants: number; pending: number } | null>(null);
  const confirming = useRef(false);
  const masterRefreshRunning = useRef(false);
  const sync = useGlobalSyncControl();
  const syncRef = useRef(sync.presentation);
  useEffect(() => { syncRef.current = sync.presentation; }, [sync.presentation]);
  const [error, setErrorState] = useState<WacaUiError | null>(null);
  const setError = useCallback((value: WacaUiError | string) => setErrorState(
    typeof value === 'string' ? value ? wacaNotice('VALIDATION_ERROR', value) : null : value,
  ), []);

  /** Cloud ledger writes outside an import (rematch, manual mapping, pending decisions) keep every
   * counted decision: counted orders follow their source, pending orders stay pending unless decided. */
  const commitCountedLedger = useCallback(async (options: {
    current: NextWacaSnapshot; candidate: WacaRepository; batches: WacaBatch[]; links: MyAcgMasterLink[];
    variants: ProductVariant[]; requestId: string | null; importedKeys?: Set<string>;
    choices?: ReadonlyMap<string, WacaOverlapChoice>; defaultMode?: WacaUpdateMode;
  }) => {
    const epoch = await dataProvider.readWacaRestoreEpoch();
    const context = wacaTransitionContext(options.current.cutoverState, epoch, new Date().toISOString());
    const planned = planWacaCountedImport({ variants: options.variants,
      current: repositoryFromSnapshot(options.current, options.variants), candidate: options.candidate, context,
      importedKeys: options.importedKeys ?? new Set(), defaultMode: options.defaultMode ?? 'ACCUMULATE',
      overlapChoices: options.choices, actor: 'owner' });
    applyCountedItems(options.candidate, planned);
    const wanted = snapshotFromRepository(options.current, options.candidate, options.batches, options.links);
    return commitAndVerifyWacaCounted({ provider: dataProvider, current: options.current, candidate: wanted,
      plan: planned.plan, requestId: options.requestId });
  }, []);

  const load = useCallback(async () => {
    if (masterRefreshRunning.current) return;
    masterRefreshRunning.current = true;
    // Cloud groups wait for the existing atomic catalog pull. Read its inventory
    // evidence afterwards so the first visit cannot pair fresh variants with old cache.
    try {
      let nextGroups = await dataProvider.getProductGroups();
      let [nextSnapshot, nextVariants, nextInventory] = await Promise.all([
        dataProvider.getNextWacaSnapshot(),
        dataProvider.getAuthoritativeWacaVariants(),
        dataProvider.getInventory(),
      ]);

      // Repair only Product Master rows needed by historical pending items.
      // This Catalog transaction is independent of WACA and never opts the
      // created variants into Purchase Records.
      const pendingItems = nextSnapshot.items.filter(row => !row.productVariantId);
      const pendingCodes = new Set<string>();
      for (const item of pendingItems) {
        pendingCodes.add(item.productCode.trim().toUpperCase());
        if (item.specCode) pendingCodes.add(item.specCode.trim().toUpperCase());
      }
      const variantCodes = new Set(nextVariants.map(row => row.myacg_item_code.trim().toUpperCase()));
      const inventoryByChild = new Map(nextInventory.map(row => [row.myacg_item_code.trim().toUpperCase(), row]));
      const inventoryByParent = new Map<string, InventoryItem[]>();
      for (const row of nextInventory) {
        const parent = (row.myacg_parent_code ?? '').trim().toUpperCase();
        if (parent) inventoryByParent.set(parent, [...(inventoryByParent.get(parent) ?? []), row]);
      }
      const missingCodes = new Set<string>();
      for (const item of pendingItems) {
        const explicit = item.specCode.trim().toUpperCase();
        const parent = item.productCode.trim().toUpperCase();
        const candidates = explicit ? [inventoryByChild.get(explicit)].filter((row): row is InventoryItem => Boolean(row))
          : [...(inventoryByParent.get(parent) ?? []), ...([inventoryByChild.get(parent)]
            .filter((row): row is InventoryItem => Boolean(row)))];
        for (const inventoryRow of candidates) {
          const child = inventoryRow.myacg_item_code.trim().toUpperCase();
          if (!variantCodes.has(child)) missingCodes.add(inventoryRow.myacg_item_code);
        }
      }
      if (missingCodes.size) {
        await dataProvider.ensureProductMasterFromInventory([...missingCodes]);
        [nextGroups, nextVariants, nextInventory] = await Promise.all([
          dataProvider.getProductGroups(),
          dataProvider.getAuthoritativeWacaVariants(),
          dataProvider.getInventory(),
        ]);
      }

      const fromInventory = linksFromMyAcgInventory(nextInventory, nextVariants, 'ERP2_CURRENT_BUYANIME_MASTER', '');
      // A WACA page visit must not materialize the entire BuyAnime link graph.
      // Persist only evidence that can resolve the current historical backlog;
      // with no pending items the page remains strictly read-only.
      const relevantLinks = fromInventory.links.filter(link => pendingCodes.has(link.mainCode.trim().toUpperCase())
        || pendingCodes.has(link.childCode.trim().toUpperCase()));
      const mergedLinks = mergeMyAcgMasterLinks(nextSnapshot.masterLinks, relevantLinks);
      const linkDelta = planMyAcgMasterLinkDelta(nextSnapshot.masterLinks, mergedLinks);
      const affectedCodes = new Set<string>([...missingCodes]);
      for (const link of linkDelta.links) { affectedCodes.add(link.mainCode); affectedCodes.add(link.childCode); }
      // Existing backlog is bounded by pending rows, never by the whole order
      // history. This allows a newly deployed resolver to close safely provable
      // items even when the durable link itself was already current.
      for (const item of pendingItems) {
        affectedCodes.add(item.productCode);
        if (item.specCode) affectedCodes.add(item.specCode);
      }
      if (affectedCodes.size) {
        const repo = repositoryFromSnapshot(nextSnapshot, nextVariants);
        const candidate = cloneWacaRepository(repo);
        const master = buildWacaMasterReference(nextVariants, mergedLinks);
        const result = rematchHistoricalWaca(candidate, master, crypto.randomUUID(), affectedCodes);
        refreshWacaMasterStatus(candidate, master);
        if (result.changed || result.quantityChanges.length || linkDelta.links.length) {
          const verified = dataProvider.supportsWacaCountedImport()
            ? await commitCountedLedger({ current: nextSnapshot, candidate, batches: nextSnapshot.batches,
              links: mergedLinks, variants: nextVariants, requestId: null })
            : await commitAndVerifyWacaRematch({ provider: dataProvider, current: nextSnapshot,
              candidate: snapshotFromRepository(nextSnapshot, candidate, nextSnapshot.batches, mergedLinks), cloud: false });
          nextSnapshot = verified.snapshot;
          nextVariants = verified.variants;
          setMessage(result.autoResolved
            ? `商品主檔更新後已自動配對 ${result.autoResolved} 筆歷史待處理資料；已計入的訂單依來源更新，未確認是否已含在 ERP1 數量的訂單保留為待核對。`
            : '商品主檔對照證據已更新。');
        }
      }
      setSnapshot(nextSnapshot);
      setVariants(nextVariants);
      setInventory(nextInventory);
      setGroups(nextGroups);
      setError('');
    } finally {
      masterRefreshRunning.current = false;
    }
  }, [setError, commitCountedLedger]);

  const { refreshAuthoritative } = useCloudResourceSync('waca-orders', ['products'], false,
    useCallback(async () => { if (!confirming.current) await load(); }, [load]));

  useEffect(() => {
    if (!supportsWacaProvider(getProviderMode(), supabaseEnvironment.projectRef)) return;
    void Promise.resolve().then(load).catch(cause => setError(readErrorText(cause)));
  }, [load, setError]);

  const masterState = useMemo(() => {
    if (!snapshot) return { links: [] as MyAcgMasterLink[], master: [] as MasterVariant[], error: '' };
    try {
      const fromInventory = linksFromMyAcgInventory(inventory, variants, 'NEXT_CURRENT_MYACG_CATALOG', '');
      const links = mergeMyAcgMasterLinks(fromInventory.links, snapshot.masterLinks);
      return { links, master: buildWacaMasterReference(variants, links), error: '' };
    } catch (cause) {
      return { links: snapshot.masterLinks, master: buildWacaMasterReference(variants, snapshot.masterLinks),
        error: classifyWacaError(cause, 'validation').message };
    }
  }, [snapshot, variants, inventory]);

  const repo = useMemo(() => {
    if (!snapshot) return null;
    try { return repositoryFromSnapshot(snapshot, variants); }
    catch { return null; }
  }, [snapshot, variants]);

  const orders = useMemo(() => [...(repo?.orders.values() ?? [])].sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt)), [repo]);
  const items = useMemo(() => [...(repo?.items.values() ?? [])], [repo]);
  const itemsByOrder = useMemo(() => {
    const byOrder = new Map<string, WacaItem[]>();
    for (const item of items) byOrder.set(item.orderKey, [...(byOrder.get(item.orderKey) ?? []), item]);
    return byOrder;
  }, [items]);
  const pendingItems = useMemo(() => items.filter(isPending), [items]);
  const variantById = useMemo(() => new Map(variants.map(row => [row.id, row])), [variants]);
  const groupById = useMemo(() => new Map(groups.map(row => [row.id, row])), [groups]);
  const displayNameForVariant = useCallback((variantId: string | null, fallback: string) => {
    const variant = variantId ? variantById.get(variantId) : undefined;
    const group = variant?.product_group_id ? groupById.get(variant.product_group_id) : undefined;
    return group ? productGroupDisplayName(group) : variant ? normalizeProductTitle(variant.product_title) : fallback;
  }, [variantById, groupById]);
  const reconciliation = useMemo(() => snapshot?.cutoverAudit?.length
    ? reconcileWacaReadback(snapshot, variants) : null, [snapshot, variants]);
  const mappingItems = useMemo(() => {
    const seen = new Set<string>();
    return items.filter(item => {
      if (seen.has(item.feature)) return false;
      seen.add(item.feature);
      return true;
    });
  }, [items]);
  const masterIndex = useMemo(() => indexWacaMaster(masterState.master), [masterState.master]);
  const evidenceByChildCode = useMemo(() => new Map(masterState.links.map(link => [link.childCode, link])), [masterState.links]);
  const matchByFeature = useMemo(() => new Map(mappingItems.map(item =>
    [item.feature, matchWacaItem(item, masterIndex)] as const)), [mappingItems, masterIndex]);
  // Recognition receipts remain in the durable snapshot, but are not Excel imports.
  const importBatches = useMemo(() => (snapshot?.batches ?? []).filter(batch => !batch.recognition), [snapshot]);
  const latestBatch = importBatches.at(-1);
  const matchedFeatures = mappingItems.filter(item => item.productVariantId).length;
  const manualFeatures = mappingItems.filter(item => item.match === 'MANUAL_MATCH').length;
  const multipleFeatures = mappingItems.filter(item => item.diagnostic === 'MULTIPLE_VARIANT_CANDIDATES').length;
  const rebaselinePreview = snapshot?.cutoverState?.mode === 'ORDER_REBASELINE_REQUIRED'
    || snapshot?.cutoverState?.mode === 'LEGACY_QUANTITY_ACTIVE';
  const countedPlanning = useMemo<{ plan: WacaCountedImportResult | null; error: string }>(() => {
    const counted = pendingImport?.counted;
    if (!counted) return { plan: null, error: '' };
    try {
      return { plan: planWacaCountedImport({ variants, current: counted.currentRepo,
        candidate: cloneWacaRepository(counted.candidate), context: counted.context, importedKeys: counted.importedKeys,
        modes: updateModes, defaultMode: WACA_DEFAULT_UPDATE_MODE, overlapChoices, actor: 'owner' }), error: '' };
    } catch (cause) { return { plan: null, error: classifyWacaError(cause, 'validation').message }; }
  }, [pendingImport, variants, updateModes, overlapChoices]);
  const countedPlan = countedPlanning.plan;
  const previewFeatures = useMemo(() => pendingImport
    ? [...new Map(pendingImport.items.map(item => [item.feature, item])).values()] : [], [pendingImport]);
  const previewReasons = useMemo(() => {
    const reasons = new Map<string, Set<string>>();
    for (const item of pendingImport?.items ?? []) {
      if (!item.productVariantId) continue;
      const values = reasons.get(item.productVariantId) ?? new Set<string>();
      values.add(resolutionText(item)); reasons.set(item.productVariantId, values);
    }
    return reasons;
  }, [pendingImport]);
  const previewUnresolvedByGroup = useMemo(() => {
    const result = new Map<string, UnresolvedPreviewTrace[]>();
    if (!pendingImport) return result;
    const orderByKey = new Map(pendingImport.candidateOrders.map(row => [row.key, row]));
    const add = (groupId: string, row: UnresolvedPreviewTrace) => {
      const values = result.get(groupId) ?? [];
      if (!values.some(value => value.key === row.key)) values.push(row);
      result.set(groupId, values);
    };
    for (const item of pendingImport.items.filter(row => !row.productVariantId)) {
      const match = matchWacaItem(item, masterIndex);
      const groups = new Set(match.candidates.map(row => row.productGroupId).filter(Boolean));
      if (groups.size !== 1) continue;
      const order = orderByKey.get(item.orderKey);
      add([...groups][0], { key: item.key, orderNumber: order?.orderNumber ?? item.orderKey.replace('WACA::', ''),
        status: '待處理', quantity: item.quantity, reason: resolutionText(item) });
    }
    const conflicts = new Set(pendingImport.result.statusConflicts);
    for (const row of pendingImport.rows) {
      const orderKey = wacaOrderKey(row.orderNumber);
      if (!conflicts.has(orderKey) || isWacaDiscount(row)) continue;
      const match = matchWacaItem(row, masterIndex);
      const groups = new Set(match.candidates.map(candidate => candidate.productGroupId).filter(Boolean));
      if (match.candidate?.productGroupId) groups.add(match.candidate.productGroupId);
      if (groups.size !== 1) continue;
      add([...groups][0], { key: `${orderKey}::${wacaFeature(row)}`, orderNumber: row.orderNumber,
        status: '狀態衝突', quantity: row.quantity, reason: '同一訂單出現多種狀態，確認前不計入 WACA 數量' });
    }
    return result;
  }, [pendingImport, masterIndex]);
  // Immutable membership for this preview, including pending rows outside the uploaded file.
  const initialCountedPlan = useMemo(() => {
    const counted = pendingImport?.counted;
    if (!counted) return null;
    try {
      return planWacaCountedImport({ variants, current: counted.currentRepo,
        candidate: cloneWacaRepository(counted.candidate), context: counted.context,
        importedKeys: counted.importedKeys, defaultMode: WACA_DEFAULT_UPDATE_MODE, actor: 'owner' });
    } catch { return null; /* countedPlanning reports errors and blocks confirmation. */ }
  }, [pendingImport, variants]);
  const previewGroups = useMemo(() => {
    if (!pendingImport) return [];
    const touched = new Set([...pendingImport.items.map(item => item.productVariantId),
      ...pendingImport.result.quantityChanges.map(change => change.variantId),
      ...[...(countedPlan?.variants.values() ?? [])].filter(row => row.touched || row.difference !== 0
        || hasWacaPreviewReview(row)).map(row => row.variantId),
      ...[...(initialCountedPlan?.variants.values() ?? [])].filter(row => row.touched || row.difference !== 0
        || hasWacaPreviewReview(row)).map(row => row.variantId),
    ].filter((id): id is string => Boolean(id)));
    const differenceFor = (variantId: string, fallback: number) => countedPlan
      ? countedPlan.variants.get(variantId)?.difference ?? 0 : fallback;
    const touchedGroups = new Set(variants.filter(row => touched.has(row.id)).map(row => row.product_group_id || row.id));
    for (const groupId of previewUnresolvedByGroup.keys()) touchedGroups.add(groupId);
    const variantsByGroup = new Map<string, ProductVariant[]>();
    for (const variant of variants) {
      const groupId = variant.product_group_id || variant.id;
      variantsByGroup.set(groupId, [...(variantsByGroup.get(groupId) ?? []), variant]);
    }
    const skuSort = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    const groups = [...touchedGroups].map(id => {
      const children = (variantsByGroup.get(id) ?? []).map(variant => ({
        variant, comparison: pendingImport.comparisonByVariant.get(variant.id)!,
      })).sort((a, b) => {
        const left = a.variant.myacg_item_code?.trim();
        const right = b.variant.myacg_item_code?.trim();
        if (!left || !right) return Number(!left) - Number(!right)
          || a.variant.variant_name.localeCompare(b.variant.variant_name) || a.variant.id.localeCompare(b.variant.id);
        return skuSort.compare(left, right) || a.variant.id.localeCompare(b.variant.id);
      });
      const group = groupById.get(id);
      return { id, title: group ? productGroupDisplayName(group)
        : normalizeProductTitle(children[0]?.variant.product_title || '未命名商品群組'),
        children, unresolved: previewUnresolvedByGroup.get(id) ?? [],
        increases: children.filter(row => differenceFor(row.variant.id, row.comparison.difference) > 0).length,
        decreases: children.filter(row => differenceFor(row.variant.id, row.comparison.difference) < 0).length,
        unchanged: children.filter(row => differenceFor(row.variant.id, row.comparison.difference) === 0).length,
        // Sort key from the file itself (independent of update modes and Owner decisions): the group order of one
        // import preview never changes when modes / order decisions are switched.
        sourceChanges: children.filter(row => row.comparison.difference !== 0).length };
    });
    return groups.sort((a, b) => Number(b.sourceChanges > 0) - Number(a.sourceChanges > 0)
      || b.sourceChanges - a.sourceChanges || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }, [pendingImport, variants, groupById, previewUnresolvedByGroup, countedPlan, initialCountedPlan]);
  const orderStatusByKey = useMemo(() => new Map((pendingImport?.candidateOrders ?? []).map(order => [order.key, order.status])), [pendingImport]);
  const traceStatus = (traceKey: string) => orderStatusByKey.get(traceKey.split('::').slice(0, 2).join('::'));
  const visiblePreviewGroups = previewGroups.map(group => ({ ...group, children: group.children.filter(row => {
    const counted = countedPlan?.variants.get(row.variant.id);
    if (!countedPlan) return isWacaPreviewVariantVisible(row.comparison, showUnchanged, showOnlyBaselineDifferences);
    if (showOnlyBaselineDifferences) return Boolean(counted && counted.difference !== 0);
    return showUnchanged || Boolean(counted && (counted.touched || counted.difference !== 0 || counted.pendingQuantity > 0));
  }) }))
    .filter(group => group.children.length > 0 || group.unresolved.length > 0);
  const changedPreviewVariants = previewGroups.reduce((sum, group) => sum
    + group.children.filter(row => row.comparison.ledgerBeforeQuantity !== row.comparison.ledgerAfterQuantity).length, 0);
  // Default-mode review state, not a warning about a hypothetical future OVERWRITE choice.
  const reviewVariantIds = useMemo(() => {
    const result = new Map<string, string>();
    for (const row of initialCountedPlan?.variants.values() ?? []) {
      if (hasWacaPreviewReview(row)) result.set(row.variantId, '有待核對訂單');
    }
    return result;
  }, [initialCountedPlan]);
  const reviewGroups = useMemo(() => previewGroups.map(group => ({ ...group,
    needsReview: group.unresolved.length > 0 || group.children.some(row => reviewVariantIds.has(row.variant.id)) }))
    // Stable order for one preview: needs-review first, then the file's own changes; never by mode or decision.
    .sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || b.sourceChanges - a.sourceChanges
      || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)), [previewGroups, reviewVariantIds]);
  const openGroups: ReadonlySet<string> = pendingImport && openState?.importId === pendingImport.importId ? openState.ids
    : new Set(reviewGroups.filter(group => group.needsReview || group.sourceChanges > 0
      || group.children.some(row => (initialCountedPlan?.variants.get(row.variant.id)?.difference ?? 0) !== 0)).map(group => group.id));
  const setGroupOpen = (groupId: string, open: boolean) => {
    if (!pendingImport || openGroups.has(groupId) === open) return;
    const ids = new Set(openGroups); if (open) ids.add(groupId); else ids.delete(groupId);
    setOpenState({ importId: pendingImport.importId, ids });
  };
  const sourceQuantityByKey = useMemo(() => new Map((pendingImport?.items ?? []).map(item => [item.key, item.quantity])), [pendingImport]);

  const run = (rows: WacaRow[], current: NextWacaSnapshot, importId: string, links = masterState.links) => {
    const currentRepo = repositoryFromSnapshot(current, variants);
    const candidate = cloneWacaRepository(currentRepo);
    const master = buildWacaMasterReference(variants, links);
    const result = importWacaRows(rows, candidate, master, importId);
    refreshWacaMasterStatus(candidate, master);
    return { currentRepo, candidate, result };
  };

  const handleWacaFile = async (file?: File) => {
    if (!file || !snapshot) return;
    setChosenFileName(file.name);
    setBusy(true); setError(''); setMessage(''); setPendingImport(null); setShowUnchanged(false);
    setShowOnlyBaselineDifferences(false); setExpandedTraces(new Set());
    setUpdateModes(new Map()); setOverlapChoices(new Map()); setRiskAcknowledged(false);
    setOnlyChangedSpecs(true); setIncludeReviewSpecs(true); setOpenState(null);
    try {
      if (masterState.error) throw new Error(masterState.error);
      const parsed = parseWacaWorkbook(await file.arrayBuffer());
      const importId = crypto.randomUUID();
      const { currentRepo, candidate, result } = run(parsed.rows, snapshot, importId);
      const keys = new Set(parsed.rows.map(row => `${wacaOrderKey(row.orderNumber)}::${wacaFeature(row)}`));
      const counted = countedSupported ? {
        context: wacaTransitionContext(snapshot.cutoverState, await dataProvider.readWacaRestoreEpoch(), new Date().toISOString()),
        currentRepo, candidate, importedKeys: new Set([...candidate.items.values()]
          .filter(item => keys.has(`${item.orderKey}::${item.feature}`)).map(item => item.key)),
      } : null;
      const comparisonByVariant = buildWacaPreviewComparisons(
        variants, currentRepo, candidate, snapshot.cutoverState?.mode,
      );
      setPendingImport({
        fileName: file.name, rows: parsed.rows, revision: snapshot.revision, importId, result,
        items: [...candidate.items.values()].filter(item => keys.has(`${item.orderKey}::${item.feature}`)),
        candidateOrders: [...candidate.orders.values()],
        links: masterState.links,
        comparisonByVariant,
        counted,
      });
    } catch (cause) { setChosenFileName(''); setError(classifyWacaError(cause, 'parse')); }
    finally { setBusy(false); }
  };

  const confirmImport = async () => {
    if (confirming.current || !pendingImport || !snapshot || pendingImport.result.errors.length) return;
    confirming.current = true;
    for (const name of ['click', 'validation', 'commit', 'readback', 'refresh', 'sync', 'verified']) {
      performance.clearMarks(`waca-confirm:${name}`);
    }
    performance.mark('waca-confirm:click');
    setBusy(true); setError(''); setMessage('正在更新並同步 WACA 資料…'); setCompletion(null);
    let stage: WacaStage = 'read';
    try {
      const current = await dataProvider.getNextWacaSnapshot();
      performance.mark('waca-confirm:validation');
      stage = 'validation';
      if (current.revision !== pendingImport.revision) throw new Error('WACA_STALE_REVISION');
      const { candidate, result } = run(pendingImport.rows, current, pendingImport.importId, pendingImport.links);
      if (result.errors.length) throw new Error('WACA_PREVIEW_VALIDATION_FAILED');
      performance.mark('waca-confirm:commit');
      const conflicts = new Set(result.statusConflicts);
      const batch: WacaBatch = {
        id: pendingImport.importId, fileName: pendingImport.fileName, importedAt: new Date().toISOString(),
        rows: pendingImport.rows.length, inserted: result.inserted, updated: result.updated,
        unchanged: result.unchanged, result,
        conflictRows: pendingImport.rows.filter(row => conflicts.has(wacaOrderKey(row.orderNumber))),
      };
      const cloud = getProviderMode() !== 'next';
      const onStage = (value: WacaStage) => { stage = value; if (value === 'readback') performance.mark('waca-confirm:readback'); };
      let committed: Awaited<ReturnType<typeof commitAndVerifyWaca>>;
      if (pendingImport.counted && countedPlan) {
        // Re-plan against the authoritative ledger + Restore epoch with the reviewed choices; any difference
        // from the preview the Owner saw stops here (nothing is written).
        if (countedPlan.riskyOverwrites.length && !riskAcknowledged) throw new Error('WACA_OVERWRITE_CONFIRMATION_REQUIRED');
        const epoch = await dataProvider.readWacaRestoreEpoch();
        const authoritativeVariants = await dataProvider.getAuthoritativeWacaVariants();
        const keys = new Set(pendingImport.rows.map(row => `${wacaOrderKey(row.orderNumber)}::${wacaFeature(row)}`));
        const planned = planWacaCountedImport({ variants: authoritativeVariants, current: repositoryFromSnapshot(current, authoritativeVariants), candidate,
          context: wacaTransitionContext(current.cutoverState, epoch, new Date().toISOString()),
          importedKeys: new Set([...candidate.items.values()]
            .filter(item => keys.has(`${item.orderKey}::${item.feature}`)).map(item => item.key)),
          modes: updateModes, defaultMode: WACA_DEFAULT_UPDATE_MODE, overlapChoices, actor: 'owner' });
        const stable = (plan: typeof planned.plan) => JSON.stringify([plan.restoreEpoch, plan.overwriteVariantIds,
          Object.entries(plan.expectedDisplay).sort(([a], [b]) => a.localeCompare(b))]);
        if (stable(planned.plan) !== stable(countedPlan.plan)) throw new Error('WACA_PREVIEW_STALE');
        applyCountedItems(candidate, planned);
        batch.transition = {
          contract: planned.plan.contract, restoreEpoch: planned.plan.restoreEpoch,
          recognitionPolicy: 'VALID_SOURCE_ACCUMULATE_V2',
          variants: [...planned.variants.values()].filter(row => row.touched || row.difference !== 0).map(row => ({
            variantId: row.variantId, mode: row.mode, before: row.displayBefore, ledger: row.ledgerAfter,
            countedDelta: row.countedDelta, after: row.displayAfter, pending: row.pendingQuantity })),
        };
        const next = snapshotFromRepository(current, candidate, [...current.batches, batch], pendingImport.links);
        committed = await commitAndVerifyWacaCounted({ provider: dataProvider, current, candidate: next,
          plan: planned.plan, requestId: batch.id, onStage });
      } else {
        const next = snapshotFromRepository(current, candidate, [...current.batches, batch], pendingImport.links);
        committed = await commitAndVerifyWaca({ provider: dataProvider, current, candidate: next, requestId: batch.id, cloud, onStage });
      }
      const { snapshot: finalSnapshot, variants: finalVariants, checked: finalCheck } = committed;
      const decided = batch.transition?.variants ?? [];
      const countedSummary = batch.transition
        ? `覆蓋 ${decided.filter(row => row.mode === 'OVERWRITE').length}、累加 ${decided.filter(row => row.mode === 'ACCUMULATE').length}、維持 ${decided.filter(row => row.mode === 'KEEP').length} 個規格；`
          + `本次新計入 ${decided.reduce((sum, row) => sum + Math.max(0, row.countedDelta), 0)} 件，`
          + `待核對 ${decided.reduce((sum, row) => sum + Math.max(0, row.pending), 0)} 件已保存；已計入過的訂單沒有重複加算。` : '';
      performance.mark('waca-confirm:refresh');
      if (cloud) {
        if (!refreshAuthoritative) throw new Error('WACA_TARGETED_REFRESH_UNAVAILABLE');
        const refreshed = await refreshAuthoritative(['products']);
        if (!refreshed || refreshed.conflicts.length) throw new Error('WACA_TARGETED_REFRESH_CONFLICT');
      }
      // Never claim success while the shared header still shows cached/loading.
      // Read the actual shared presentation; do not clear/fake global freshness.
      const deadline = Date.now() + 10_000;
      performance.mark('waca-confirm:sync');
      while (cloud && (syncRef.current.status !== 'fresh' || !syncRef.current.writeAllowed)) {
        if (Date.now() >= deadline) throw new Error('WACA_GLOBAL_SYNC_NOT_CONVERGED');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      setSnapshot(finalSnapshot);
      performance.mark('waca-confirm:verified');
      setVariants(finalVariants);
      setPendingImport(null);
      setChosenFileName('');
      const pendingFeatures = new Set(finalSnapshot.items.filter(isPending).map(item => item.feature)).size;
      const integrityIssues = finalCheck.issues.filter(issue => issue.reason !== 'UNMATCHED_SOURCE');
      if (integrityIssues.length || result.statusConflicts.length) {
        setTab('pending');
        setError(wacaNotice('CONFLICT', `WACA 訂單已保存，但有 ${integrityIssues.length + result.statusConflicts.length} 個對帳或訂單狀態問題需要確認。`));
      } else if (pendingFeatures) {
        // Historical pending items are retained and counted, but do not open
        // thousands of manual-choice controls behind the completion dialog.
        // The visible Pending tab remains available; no work is deferred.
        setMessage(`WACA 訂單已保存，已配對商品的數量已更新；${pendingFeatures} 個商品／規格保留為待處理。商品主檔建立後，系統會自動重新配對並更新數量，不必重傳 WACA Excel。${countedSummary}`);
      } else {
        setMessage(`WACA 更新完成：${finalCheck.passed} / ${finalCheck.total} 商品對帳一致，${finalCheck.effectiveQuantity} 件有效數量已更新，0 個需要處理。${countedSummary}`);
      }
      if (!integrityIssues.length && !result.statusConflicts.length) setCompletion({
        orders: new Set(pendingImport.rows.map(row => wacaOrderKey(row.orderNumber))).size,
        variants: result.quantityChanges.length, pending: pendingFeatures,
      });
    } catch (cause) {
      const classified = classifyWacaError(cause, stage, pendingImport.importId,
        pendingImport.counted && countedPlan ? 'erp_commit_waca_counted_snapshot' : 'erp_commit_waca_snapshot');
      setMessage(''); setError(classified);
      // A rejected plan must be rebuilt from fresh authoritative state, not
      // made into a second write attempt by clicking the same confirmation.
      if (classified.category === 'STALE_CONFLICT') setPendingImport(null);
    }
    finally { confirming.current = false; setBusy(false); }
  };

  const handleMasterFile = async (file?: File) => {
    if (!file || !snapshot) return;
    setBusy(true); setError(''); setMessage(''); setPendingLinks(null);
    try {
      const parsed = await parseMyAcgFile(file);
      const result = linksFromMyAcgInventory(parsed, variants, file.name, new Date().toISOString());
      const links = mergeMyAcgMasterLinks(masterState.links, result.links);
      setPendingLinks({ fileName: file.name, revision: snapshot.revision, result, links });
    } catch (cause) { setError(classifyWacaError(cause, 'parse')); }
    finally { setBusy(false); }
  };

  const confirmMasterLinks = async () => {
    if (!snapshot || !pendingLinks) return;
    setBusy(true); setError('');
    let stage: WacaStage = 'read';
    try {
      const current = await dataProvider.getNextWacaSnapshot();
      stage = 'validation';
      if (current.revision !== pendingLinks.revision) throw new Error('對照資料已變更，請重新選擇買動漫檔案。');
      stage = 'backup';
      await dataProvider.exportData();
      stage = 'commit';
      await dataProvider.commitNextWacaSnapshot({ ...current, masterLinks: pendingLinks.links }, current.revision, false);
      stage = 'readback';
      setPendingLinks(null);
      await load();
      setMessage(`已保存 ${pendingLinks.result.accepted} 筆買動漫 GP → G 對照證據。`);
    } catch (cause) { setError(classifyWacaError(cause, stage, undefined, 'erp_commit_waca_snapshot')); }
    finally { setBusy(false); }
  };

  const choicesFor = useCallback((item: WacaItem) => {
    if (item.diagnostic === 'SOURCE_SPEC_IDENTITY_CONFLICT') return [];
    const choices = matchByFeature.get(item.feature)?.candidates ?? [];
    if (item.specCode.trim() || choices.length) return choices;
    return masterIndex.byGroup.get(selectedParent[item.feature] ?? '') ?? [];
  }, [matchByFeature, masterIndex, selectedParent]);

  const explanationFor = useCallback((item: WacaItem) => {
    return resolutionText(item);
  }, []);

  const manualMap = useCallback(async (item: WacaItem) => {
    if (!snapshot) return;
    const chosen = choicesFor(item).find(row => row.variantId === selectedVariant[item.feature]);
    if (!chosen || !chosen.variantId) { setError('請先選擇已確認商品底下的規格；有規格編號時必須與編號一致。'); return; }
    setBusy(true); setError('');
    let stage: WacaStage = 'read';
    try {
      const current = await dataProvider.getNextWacaSnapshot();
      stage = 'validation';
      if (current.revision !== snapshot.revision) throw new Error('WACA 資料已變更，請重新讀取。');
      stage = 'backup';
      await dataProvider.exportData();
      stage = 'validation';
      const candidate = repositoryFromSnapshot(current, variants);
      setWacaMapping(candidate, {
        feature: item.feature, myacgMainId: chosen.mainCode || item.productCode, myacgVariantId: chosen.childCode,
        productVariantId: chosen.variantId, method: 'MANUAL', confirmedAt: new Date().toISOString(),
        historicalProductTitle: item.productTitle, historicalVariantTitle: chosen.variantTitle,
        masterStatus: 'ACTIVE',
      }, masterIndex, selectedParent[item.feature]);
      stage = 'commit';
      if (dataProvider.supportsWacaCountedImport()) {
        await commitCountedLedger({ current, candidate, batches: current.batches, links: masterState.links, variants, requestId: null });
      } else {
        await dataProvider.commitNextWacaSnapshot(
          snapshotFromRepository(current, candidate, current.batches, masterState.links), current.revision, true,
        );
      }
      stage = 'readback';
      await load();
      setMessage(dataProvider.supportsWacaCountedImport()
        ? '商品對照已保存；已計入的訂單依來源更新，接管前且尚未確認的訂單保留為待核對（可在「待處理」決定是否計入）。'
        : '商品對照已保存；所有受影響歷史訂單的 WACA 數量已重算。');
    } catch (cause) { setError(classifyWacaError(cause, stage, undefined,
      dataProvider.supportsWacaCountedImport() ? 'erp_commit_waca_counted_snapshot' : 'erp_commit_waca_snapshot')); }
    finally { setBusy(false); }
  }, [snapshot, choicesFor, selectedVariant, selectedParent, variants, masterState.links, masterIndex, load, setError, commitCountedLedger]);

  const parentConfirmation = useCallback((item: WacaItem) => item.diagnostic !== 'SOURCE_SPEC_IDENTITY_CONFLICT' && !item.specCode.trim()
    && !matchByFeature.get(item.feature)?.candidates.length ? <label>先人工確認商品群組
      <select aria-label={`商品群組 ${item.productCode} ${item.spec1}`} value={selectedParent[item.feature] ?? ''}
        onChange={event => {
          setSelectedParent(previous => ({ ...previous, [item.feature]: event.target.value }));
          setSelectedVariant(previous => ({ ...previous, [item.feature]: '' }));
        }}>
        <option value="">尚未確認商品群組</option>
        {groups.filter(group => masterIndex.byGroup.has(group.id)).map(group =>
          <option key={group.id} value={group.id}>{productGroupDisplayName(group)}</option>)}
      </select></label> : null, [matchByFeature, selectedParent, groups, masterIndex]);

  const conflicts = useMemo(() => {
    const result: Array<{ batch: WacaBatch; orderKey: string; rows: WacaRow[] }> = [];
    for (const batch of snapshot?.batches ?? []) {
      const byOrder = new Map<string, WacaRow[]>();
      for (const row of batch.conflictRows ?? []) {
        const key = wacaOrderKey(row.orderNumber);
        byOrder.set(key, [...(byOrder.get(key) ?? []), row]);
      }
      for (const [orderKey, rows] of byOrder) result.push({ batch, orderKey, rows });
    }
    return result;
  }, [snapshot]);

  const resolveConflict = async (batch: WacaBatch, orderKey: string, rows: WacaRow[]) => {
    if (!snapshot) return;
    const status = selectedStatus[orderKey];
    if (!status) { setError('請選擇此訂單的正確狀態。'); return; }
    setBusy(true); setError('');
    let stage: WacaStage = 'read';
    try {
      const current = await dataProvider.getNextWacaSnapshot();
      stage = 'validation';
      if (current.revision !== snapshot.revision) throw new Error('WACA 資料已變更，請重新讀取。');
      stage = 'backup';
      await dataProvider.exportData();
      stage = 'validation';
      const resolutionRows = rows.map(row => ({ ...row, orderStatus: status }));
      const importId = crypto.randomUUID();
      const { candidate, result } = run(resolutionRows, current, importId);
      if (result.errors.length || result.statusConflicts.length) throw new Error('狀態確認未通過驗證。');
      const batches = current.batches.map(row => row.id === batch.id
        ? { ...row, conflictRows: (row.conflictRows ?? []).filter(item => wacaOrderKey(item.orderNumber) !== orderKey) }
        : row);
      batches.push({
        id: importId, fileName: `${batch.fileName}／人工狀態確認`, importedAt: new Date().toISOString(),
        rows: resolutionRows.length, inserted: result.inserted, updated: result.updated,
        unchanged: result.unchanged, result, conflictRows: [],
      });
      stage = 'commit';
      if (dataProvider.supportsWacaCountedImport()) {
        await commitCountedLedger({ current, candidate, batches, links: masterState.links, variants, requestId: importId,
          importedKeys: new Set([...candidate.items.keys()].filter(key => key.startsWith(`${orderKey}::`))),
          defaultMode: 'ACCUMULATE' });
      } else {
        await dataProvider.commitNextWacaSnapshot(
          snapshotFromRepository(current, candidate, batches, masterState.links), current.revision, true,
        );
      }
      stage = 'readback';
      await load();
      setMessage(`${orderKey} 已按「${status}」重新計算。`);
    } catch (cause) { setError(classifyWacaError(cause, stage, undefined,
      dataProvider.supportsWacaCountedImport() ? 'erp_commit_waca_counted_snapshot' : 'erp_commit_waca_snapshot')); }
    finally { setBusy(false); }
  };

  // Matched orders not (fully) counted yet: pending Owner decision, never silently counted or dropped.
  const countedPendingItems = useMemo(() => {
    if (!countedSupported || !snapshot || !repo) return [];
    const driven = snapshot.cutoverState?.mode === 'ORDER_DRIVEN_ACTIVE';
    return items.filter(item => {
      if (!item.productVariantId) return false;
      const order = repo.orders.get(item.orderKey);
      const effective = order && ['處理中', '完成付款'].includes(order.status) ? item.quantity : 0;
      const counted = item.countedQuantity ?? (driven ? effective : 0);
      return Boolean(item.countedReview) || (item.countedReason !== 'BASELINE_INCLUDED' && counted !== effective);
    });
  }, [countedSupported, snapshot, repo, items]);

  const decidePending = async (item: WacaItem, choice: WacaOverlapChoice) => {
    if (!snapshot) return;
    setBusy(true); setError('');
    let stage: WacaStage = 'read';
    try {
      const current = await dataProvider.getNextWacaSnapshot();
      stage = 'validation';
      if (current.revision !== snapshot.revision) throw new Error('WACA 資料已變更，請重新讀取。');
      const candidate = repositoryFromSnapshot(current, variants);
      stage = 'commit';
      await commitCountedLedger({ current, candidate, batches: current.batches, links: masterState.links, variants,
        requestId: null, choices: new Map([[item.key, choice]]) });
      stage = 'readback';
      await load();
      setMessage(choice === 'COUNT_AS_NEW' ? `訂單 ${item.orderKey.replace('WACA::', '')} 已計入 WACA 數量。`
        : `訂單 ${item.orderKey.replace('WACA::', '')} 已標記為包含在 ERP1 歷史數量，不再重複計入。`);
    } catch (cause) { setError(classifyWacaError(cause, stage, undefined, 'erp_commit_waca_counted_snapshot')); }
    finally { setBusy(false); }
  };

  // Keep the expensive mapping table mounted after its first visit. Its element tree
  // only changes when source data, selection, or busy state changes—not on tab switches.
  const mappingsPanel = useMemo(() => <>
    <h2>WACA 商品對照</h2>
    <p>對照記錄會用於後續匯入；人工重配會回算已保存的歷史訂單。</p>
    {snapshot && !mappingItems.length && <p>目前沒有 WACA 商品對照。匯入訂單後會顯示配對結果。</p>}
    <div className="waca-scroll"><table><thead><tr><th>WACA 商品／規格</th><th>ERP 對應商品／規格／SKU</th><th>狀態</th><th>人工確認</th></tr></thead><tbody>
      {mappingItems.map(item => {
        const mapping = repo?.mappings.get(item.feature);
        const choices = choicesFor(item);
        const evidence = mapping && evidenceByChildCode.get(mapping.myacgVariantId);
        const target = item.productVariantId ? variantById.get(item.productVariantId) : undefined;
        return <tr key={item.feature}><td>{displayNameForVariant(item.productVariantId, item.productTitle)}<small>{item.spec1} {item.spec2}</small>
            <details className="waca-tech"><summary>原始 WACA 資料</summary><small>{item.productTitle}／{item.productCode}</small></details></td>
          <td>{target ? <>{displayNameForVariant(target.id, target.product_title)}<small>{target.variant_name}／SKU {target.myacg_item_code}</small></> : statusText[item.diagnostic ?? ''] ?? '待對照'}</td>
          <td>{resolutionText(item)}
            {mapping && <details className="waca-tech"><summary>查看技術資訊</summary><small>GP {mapping.myacgMainId}／G {mapping.myacgVariantId}</small>
              {evidence && <small>來源：{evidence.sourceFile}</small>}</details>}</td>
          <td><small>{explanationFor(item)}</small>{parentConfirmation(item)}<select aria-label={`對照 ${item.productCode} ${item.spec1}`} value={selectedVariant[item.feature] ?? ''} onChange={event => setSelectedVariant(previous => ({ ...previous, [item.feature]: event.target.value }))}>
            <option value="">選擇此商品的規格</option>
            {choices.filter(choice => choice.variantId).map(choice => <option key={choice.variantId} value={choice.variantId}>{displayNameForVariant(choice.variantId, choice.productTitle)}／{choice.variantTitle}／{choice.childCode}</option>)}
          </select><button className="btn btn-outline" disabled={busy || !selectedVariant[item.feature]} onClick={() => void manualMap(item)}>保存</button></td>
        </tr>;
      })}
    </tbody></table></div>
  </>, [mappingItems, repo, choicesFor, evidenceByChildCode, variantById, displayNameForVariant,
    explanationFor, parentConfirmation, selectedVariant, busy, manualMap, snapshot]);

  if (!supportsWacaProvider(getProviderMode(), supabaseEnvironment.projectRef)) return <PageShell><p>請使用 ERP 2.0 雲端或 NEXT 本機環境開啟 WACA 匯入。</p></PageShell>;
  // ---- UI v3: desktop order-review workbench (display only; plan, protections and commit path unchanged) ----
  const reviewFlags = (row: WacaVariantCountedPreview, plan: WacaCountedImportResult) => {
    const risky = plan.riskyOverwrites.includes(row.variantId);
    const flags: Array<{ text: string; tone: 'danger' | 'warn' | 'muted' }> = [];
    if (risky && row.difference < 0) flags.push({ text: '覆蓋會減少', tone: 'danger' });
    else if (risky) flags.push({ text: row.difference > 0 ? '首次接管覆蓋' : '首次接管覆蓋（數量不變）', tone: 'warn' });
    if (row.baselineChangedItems > 0) flags.push({ text: `歷史認列／取消待核對 ${row.baselineChangedItems} 筆`, tone: 'danger' });
    if (row.mode === 'ACCUMULATE' && row.uncertainItems > 0) flags.push({ text: `認列待核對 ${row.uncertainItems} 筆`, tone: 'warn' });
    if (row.pendingQuantity > 0) flags.push({ text: `待核對 ${quantity(row.pendingQuantity)} 件`, tone: 'muted' });
    return flags;
  };
  /** 維持 is a per-import decision, never a permanent exclusion (Owner decision 2026-10-18). Display only. */
  const keepNote = (row: WacaVariantCountedPreview) => row.touched && row.mode === 'KEEP';
  /** Counted quantity of already recognized orders that this import takes back (source cancelled / reduced). */
  const rollbackQuantity = (row: WacaVariantCountedPreview) => row.items
    .filter(trace => trace.reason === 'SOURCE_CHANGE_APPLIED' && trace.countedBefore > trace.countedAfter)
    .reduce((sum, trace) => sum + trace.countedBefore - trace.countedAfter, 0);
  const traceCategory = (trace: WacaCountedItemPreview, notCounted: boolean) => notCounted
    ? trace.baselineChanged ? '歷史認列待核對' : '取消／失敗來源'
    : trace.state === 'PENDING' ? '待核對' : trace.state === 'BASELINE' ? 'ERP1 歷史'
      : trace.reason === 'NORMAL_IMPORT' ? '正常匯入' : trace.reason === 'OVERWRITE' ? '覆蓋計入' : '已認列訂單';
  const diffText = (value: number) => value === 0 ? '±0' : value > 0 ? `+${quantity(value)}` : `−${quantity(-value)}`;
  const specName = (variantId: string) => {
    const variant = variantById.get(variantId);
    return `${displayNameForVariant(variantId, variant?.product_title ?? '')}｜${variant?.variant_name || '標準規格'}`;
  };

  const renderCountedReview = (pending: PendingImport, plan: WacaCountedImportResult) => {
    const planRows = [...plan.variants.values()];
    const unresolvedTotal = reviewGroups.reduce((sum, group) => sum + group.unresolved.length, 0);
    const needConfirm = planRows.filter(row => reviewFlags(row, plan).length > 0).length + unresolvedTotal;
    const increased = planRows.filter(row => row.difference > 0);
    const decreased = planRows.filter(row => row.difference < 0);
    const increaseTotal = increased.reduce((sum, row) => sum + row.difference, 0);
    const decreaseTotal = decreased.reduce((sum, row) => sum - row.difference, 0);
    const pendingTotal = planRows.reduce((sum, row) => sum + Math.max(0, row.pendingQuantity), 0);
    const baselineChanged = planRows.filter(row => row.baselineChangedItems > 0);
    const firstTakeover = pending.counted?.context.driven ? [] : plan.riskyOverwrites;
    const riskyIds = new Set(plan.riskyOverwrites);
    const shown = reviewGroups.map(group => ({ ...group,
      visibleChildren: group.children.filter(({ variant }) => isWacaCountedReviewRowVisible({
        initial: initialCountedPlan?.variants.get(variant.id), current: plan.variants.get(variant.id),
        onlyChanged: onlyChangedSpecs, includeReview: includeReviewSpecs,
        modeChosen: updateModes.has(variant.id) || Boolean(plan.variants.get(variant.id)?.items.some(item => overlapChoices.has(item.key))),
        riskyOverwrite: riskyIds.has(variant.id),
      })),
      showUnresolved: !onlyChangedSpecs || includeReviewSpecs,
    })).filter(group => group.visibleChildren.length > 0 || (group.showUnresolved && group.unresolved.length > 0));
    const visibleSpecs = shown.reduce((sum, group) => sum + group.visibleChildren.length, 0);
    const totalSpecs = reviewGroups.reduce((sum, group) => sum + group.children.length, 0);
    return <>
      <div className="waca-review-summary" data-testid="waca-review-summary" aria-label="WACA 核對摘要">
        <div className={needConfirm ? 'attention' : ''}><strong>{quantity(needConfirm)}</strong><span>需要確認（項）</span></div>
        <div className="up"><strong>+{quantity(increaseTotal)}</strong><span>預計增加（件）</span></div>
        <div className="down"><strong>{decreaseTotal ? `−${quantity(decreaseTotal)}` : '0'}</strong><span>預計減少（件）</span></div>
      </div>
      {pending.result.errors.length > 0 && <p className="waca-danger">資料列錯誤：{pending.result.errors.join('、')}</p>}
      <div className="waca-review-toolbar">
        <div className="waca-spec-filters" role="group" aria-label="篩選規格">
          <label><input type="checkbox" checked={onlyChangedSpecs}
            onChange={event => setOnlyChangedSpecs(event.target.checked)} />只顯示有數量變化的規格</label>
          <label><input type="checkbox" checked={includeReviewSpecs} disabled={!onlyChangedSpecs}
            onChange={event => setIncludeReviewSpecs(event.target.checked)} />同時顯示需要核對的規格</label>
          <small data-testid="waca-visible-spec-count">顯示 {visibleSpecs} / {totalSpecs} 個規格</small>
        </div>
        <p className="waca-mode-legend">{UPDATE_MODES.map(mode => <span key={mode}><b>{MODE_LABEL[mode]}{mode === WACA_DEFAULT_UPDATE_MODE ? '（預設）' : ''}</b>：{MODE_HELP[mode]}</span>)}</p>
      </div>
      <p className="waca-filter-note">關閉「只顯示有數量變化的規格」可查看本次相關商品的全部規格。篩選不影響計算或送出；已操作規格與原始差異會保留顯示，避免切換更新方式時消失。</p>
      {!includeReviewSpecs && onlyChangedSpecs && needConfirm > 0 && <p className="waca-notice">部分待核對規格目前隱藏；上方摘要與送出前檢查仍包含全部項目。</p>}
      {!shown.length && <p className="waca-no-changes">目前篩選沒有規格。可開啟待核對規格，或關閉篩選查看全部。</p>}
      <div className="waca-group-list waca-review-list">{shown.map(group => {
        const touchedIds = group.children.map(({ variant }) => variant.id).filter(id => plan.variants.get(id)?.touched);
        const groupState = groupModeState(touchedIds.map(id => plan.variants.get(id)!.mode));
        const groupRows = group.children.map(({ variant }) => plan.variants.get(variant.id)).filter(Boolean) as WacaVariantCountedPreview[];
        const groupConfirm = groupRows.filter(row => reviewFlags(row, plan).length > 0).length + group.unresolved.length;
        const up = groupRows.reduce((sum, row) => sum + Math.max(0, row.difference), 0);
        const down = groupRows.reduce((sum, row) => sum + Math.max(0, -row.difference), 0);
        return <details className={`waca-group waca-review-group ${groupConfirm > 0 ? 'needs-review' : ''}`} key={group.id}
          open={openGroups.has(group.id)} onToggle={event => setGroupOpen(group.id, event.currentTarget.open)}>
          <summary><strong className="waca-group-title">{group.title}</strong><span className="waca-group-counts">
            {groupConfirm > 0 && <em className="waca-chip waca-chip-confirm">需確認 {groupConfirm}</em>}
            {up > 0 && <em className="waca-chip waca-chip-up">+{quantity(up)}</em>}
            {down > 0 && <em className="waca-chip waca-chip-down">−{quantity(down)}</em>}
            {!up && !down && <em className="waca-chip">數量不變</em>}
            {touchedIds.length > 0 && <em className="waca-chip waca-chip-mode" data-testid="waca-group-mode-badge">
              {groupState === 'MIXED' ? '混合設定' : MODE_LABEL[groupState as WacaUpdateMode]}</em>}</span></summary>
          {touchedIds.length > 0 && <div className="waca-group-mode" data-testid="waca-group-mode">
            <span className="waca-group-mode-label">整組套用</span>
            <div className="waca-segmented" role="group" aria-label={`整組套用 ${group.title}`}>
              {UPDATE_MODES.map(mode => <button key={mode} type="button" disabled={busy} title={MODE_HELP[mode]}
                className={groupState === mode ? 'active' : ''} aria-pressed={groupState === mode}
                onClick={() => {
                  setUpdateModes(previous => { const next = new Map(previous);
                    for (const id of touchedIds) next.set(id, mode);
                    return next; });
                  setRiskAcknowledged(false);
                }}>{MODE_LABEL[mode]}</button>)}
            </div>
            <small className={groupState === 'MIXED' ? 'waca-mixed' : ''} data-testid="waca-group-mode-state">目前：{groupState === 'MIXED' ? '混合設定（各規格不同）' : MODE_LABEL[groupState as WacaUpdateMode]}</small>
          </div>}
          <div className="waca-scroll waca-counted-scroll"><table className="waca-counted-table waca-review-table" data-testid="waca-counted-preview"><thead><tr>
            <th>規格</th><th className="num">目前</th><th className="num">更新後</th><th className="num">差異</th><th>更新方式</th><th>需確認</th><th><span className="waca-sr-only">來源訂單</span></th></tr></thead><tbody>
            {group.visibleChildren.map(({ variant }) => {
              const current = Number(variant.waca_auto_quantity ?? 0) + Number(variant.waca_manual_adjustment ?? 0);
              const row: WacaVariantCountedPreview = plan.variants.get(variant.id) ?? { variantId: variant.id, mode: 'ACCUMULATE',
                displayBefore: current, autoBefore: Number(variant.waca_auto_quantity ?? 0), manualBefore: Number(variant.waca_manual_adjustment ?? 0),
                ledgerAfter: 0, countedBefore: 0, countedAfter: 0, countedDelta: 0, displayAfter: current,
                manualAfter: Number(variant.waca_manual_adjustment ?? 0), difference: 0, pendingQuantity: 0, uncertainItems: 0,
                baselineChangedItems: 0, newCountableQuantity: 0, touched: false, items: [] };
              const flags = reviewFlags(row, plan);
              const rollback = rollbackQuantity(row);
              const expanded = expandedTraces.has(variant.id);
              const overridden = groupState === 'MIXED' && row.touched;
              return <Fragment key={variant.id}><tr data-testid={`waca-counted-row-${variant.myacg_item_code}`} className={flags.length ? 'needs-review' : undefined}>
                <td className="waca-sku-cell"><strong>{variant.variant_name || '標準規格'}</strong><small className="waca-sku">SKU {variant.myacg_item_code}</small></td>
                <td className="waca-quantity-value num" data-label="目前">{quantity(row.displayBefore)}</td>
                <td className="waca-quantity-value num waca-after" data-label="更新後"><span className="waca-arrow" aria-hidden="true" />{quantity(row.displayAfter)}</td>
                <td data-label="差異" className={`num ${row.difference > 0 ? 'waca-increase' : row.difference < 0 ? 'waca-decrease' : 'waca-unchanged'}`}>
                  <span className="waca-diff">{diffText(row.difference)}</span></td>
                <td data-label="更新方式" className={overridden ? 'waca-mode-cell overridden' : 'waca-mode-cell'}>{row.touched
                  ? <select aria-label={`更新方式 ${variant.myacg_item_code}`} value={row.mode} disabled={busy} title={MODE_HELP[row.mode]}
                    onChange={event => { const mode = event.target.value as WacaUpdateMode;
                      setUpdateModes(previous => new Map(previous).set(variant.id, mode)); setRiskAcknowledged(false); }}>
                    {UPDATE_MODES.map(mode => <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>)}
                  </select> : <span className="waca-row-note">本次未匯入（不變）</span>}</td>
                <td data-label="需確認" className="waca-flags">{flags.map(flag => <span key={flag.text} className={`waca-flag waca-flag-${flag.tone}`}>{flag.text}</span>)}
                  {rollback > 0 && <span className="waca-flag waca-flag-muted">取消回沖 −{quantity(rollback)}</span>}
                  {keepNote(row) && <span className="waca-flag waca-flag-muted" title={MODE_HELP.KEEP}>本次暫不更新</span>}</td>
                <td data-label="來源訂單"><button type="button" className="waca-detail-toggle" aria-expanded={expanded}
                  aria-label={`${expanded ? '收合' : '查看'} ${variant.myacg_item_code} 來源訂單`}
                  onClick={() => setExpandedTraces(previous => {
                    const next = new Set(previous); if (next.has(variant.id)) next.delete(variant.id); else next.add(variant.id); return next;
                  })}>{expanded ? '▼ 收合明細' : '▶ 來源訂單'}</button></td>
              </tr>{expanded && <tr className="waca-trace-row"><td colSpan={7}>
                <div className="waca-trace-summary" data-testid={`waca-calc-${variant.myacg_item_code}`}>
                  <span>目前 <b>{quantity(row.displayBefore)}</b></span><span>來源訂單合計 <b>{quantity(row.ledgerAfter)}</b> 件</span>
                  <span>本次實際計入 <b>{signedQuantity(row.countedDelta)}</b></span>
                  {row.newCountableQuantity > 0 && <span>正常新認列 <b>{quantity(row.newCountableQuantity)}</b> 件</span>}
                  {rollback > 0 && <span>已認列訂單取消回沖 <b>−{quantity(rollback)}</b> 件</span>}
                  <span>{MODE_LABEL[row.mode]}後 <b>{quantity(row.displayAfter)}</b>（{diffText(row.difference)}）</span></div>
                {[...(previewReasons.get(variant.id) ?? [])].map(reason => <small key={reason} className="waca-row-note">配對：{reason}</small>)}
                {row.baselineChangedItems > 0 && <p className="waca-row-note waca-danger">歷史認列或取消來源待核對 {row.baselineChangedItems} 筆：無法安全追溯扣除依據，不會自動扣除，請人工核對。</p>}
                {rollback > 0 && <p className="waca-row-note">已計入 ERP2 的訂單取消／減量：依訂單明細自動回沖 {quantity(rollback)} 件；按「確認更新」前不會寫入。</p>}
                <div className="waca-scroll waca-trace-table"><table><thead><tr><th>WACA 訂單編號</th><th>日期</th><th className="num">來源數量</th><th className="num">已認列</th><th>類別</th><th>狀態</th><th>人工認列</th></tr></thead><tbody>
                  {row.items.map(trace => { const notCounted = NOT_COUNTED_STATUS_LABEL[traceStatus(trace.key) as WacaStatus];
                    return <tr key={trace.key} className={notCounted ? 'waca-trace-void' : undefined}>
                    <td data-label="訂單編號">{trace.orderNumber}{trace.isNew && <span className="waca-row-note">本次首次出現</span>}</td>
                    <td data-label="日期">{trace.purchasedAt || '日期不明'}</td>
                    <td className="num" data-label="來源數量">{quantity(sourceQuantityByKey.get(trace.key) ?? trace.effectiveQuantity)}</td>
                    <td className="num" data-label="已認列">{quantity(trace.countedAfter)}</td>
                    <td data-label="類別">{traceCategory(trace, Boolean(notCounted))}</td>
                    <td data-label="狀態">{notCounted
                      ? <><strong className="waca-status waca-status-void">{notCounted}</strong>
                        {trace.countedBefore > 0 && trace.state !== 'BASELINE' && <span className="waca-row-note">原已認列 {quantity(trace.countedBefore)} 件，自動回沖 −{quantity(trace.countedBefore - trace.countedAfter)}</span>}
                        {trace.baselineChanged && <span className="waca-row-note waca-danger">含在 ERP1 歷史，未自動扣除，需人工核對</span>}</>
                      : <><strong className={`waca-status waca-status-${trace.state.toLowerCase()}`}>{STATE_LABEL[trace.state]}</strong>
                        <span className="waca-row-note">{REASON_LABEL[trace.reason] ?? trace.reason}</span>
                        {trace.reason === 'SOURCE_CHANGE_APPLIED' && trace.countedBefore > trace.countedAfter
                          && <span className="waca-row-note">原已認列 {quantity(trace.countedBefore)} 件，自動回沖 −{quantity(trace.countedBefore - trace.countedAfter)}</span>}
                        {trace.baselineChanged && <span className="waca-row-note waca-danger">ERP1 歷史訂單有異動，未自動套用</span>}</>}</td>
                    <td data-label="人工認列">{row.mode === 'ACCUMULATE' && (trace.isNew || trace.overlapUncertain || trace.baselineChanged || overlapChoices.has(trace.key))
                      ? <select aria-label={`確認訂單 ${trace.orderNumber}`} value={overlapChoices.get(trace.key) ?? 'AUTO'} disabled={busy}
                        onChange={event => { const choice = event.target.value;
                          setOverlapChoices(previous => { const next = new Map(previous);
                            if (choice === 'AUTO') next.delete(trace.key); else next.set(trace.key, choice as WacaOverlapChoice); return next; }); }}>
                        <option value="AUTO">依認列規則（預設）</option>
                        <option value="PENDING">待核對（暫不計入）</option>
                        <option value="COUNT_AS_NEW">計入（新訂單）</option>
                        <option value="BASELINE_INCLUDED">已含在 ERP1 歷史</option>
                      </select> : <span className="waca-row-note">—</span>}</td></tr>; })}
                  {!row.items.length && <tr><td colSpan={7} className="waca-trace-empty">本次沒有此規格的訂單。</td></tr>}
                </tbody></table></div>
              </td></tr>}</Fragment>;
            })}
          </tbody></table></div>
          {group.showUnresolved && !!group.unresolved.length && <div className="waca-group-pending" data-testid="waca-group-unresolved">
            <strong>配對待處理 {group.unresolved.length} 筆（不計入數量）</strong>
            <div className="waca-scroll waca-trace-table"><table><thead><tr><th>訂單編號</th><th>狀態</th><th className="num">數量</th><th>原因</th></tr></thead><tbody>
              {group.unresolved.map(trace => <tr key={trace.key}><td>{trace.orderNumber}</td><td>{trace.status}</td><td className="num">{quantity(trace.quantity)}</td><td>{trace.reason}</td></tr>)}
            </tbody></table></div></div>}
        </details>;
      })}</div>

      <details className="waca-resolution-details waca-file-info"><summary>匯入檔案資訊（訂單數、配對理由）</summary>
        <div className="waca-metrics" aria-label="WACA 匯入預覽摘要">
          {([
            ['訂單', pending.result.ordersTotal], ['商品列', pending.result.productRows], ['商品規格', previewFeatures.length],
            ['已配對', previewFeatures.filter(item => Boolean(item.productVariantId)).length],
            ['有效數量', pending.result.effectiveQuantity], ['折扣忽略', pending.result.discountIgnored],
            ['待處理', previewFeatures.filter(item => !item.productVariantId).length + pending.result.statusConflicts.length],
          ] as const).map(([label, value]) => <div key={label}><strong>{quantity(value)}</strong><span>{label}</span></div>)}
        </div>
        <p className="waca-equation">新增 {pending.result.inserted}、更新 {pending.result.updated}、未變更 {pending.result.unchanged}；
          取消／失敗 {pending.result.cancelledOrders + pending.result.failedOrders} 張訂單不計入數量。</p>
        {pending.items.some(isPending) && <p className="waca-notice">未配對商品會先保存為待處理，暫不計入商品 WACA 數量；商品主檔建立後會自動重新配對，不必重傳 WACA Excel。</p>}
        <p>有效數量 {pending.result.effectiveQuantity} = 已配對 {pending.result.matchedEffectiveQuantity} + 待處理 {pending.result.unmatchedPendingQuantity}</p>
        <div className="waca-scroll"><table><thead><tr><th>訂單</th><th>商品</th><th>規格</th><th>數量</th><th>結果</th></tr></thead><tbody>
          {pending.items.map(item => <tr key={item.key}><td>{item.orderKey.replace('WACA::', '')}</td>
            <td>{displayNameForVariant(item.productVariantId, item.productTitle)}<small>原始 WACA：{item.productTitle}／{item.productCode}</small></td><td>{item.spec1} {item.spec2}</td><td>{item.quantity}</td>
            <td>{resolutionText(item)}{item.productVariantId && <small>SKU {variantById.get(item.productVariantId)?.myacg_item_code}</small>}</td>
          </tr>)}
        </tbody></table></div>
      </details>

      <section className="waca-final-confirm" data-testid="waca-final-confirm" aria-label="確認更新">
        <h3>確認更新</h3>
        {planRows.some(row => row.newCountableQuantity > 0) && <p className="waca-notice" data-testid="waca-history-risk-notice">
          正常有效訂單預設累加，已認列的訂單不會重複增加。尚無認列紀錄不代表已證明從未計入；若來源訂單已包含在既有 ERP1 歷史數量，
          請在來源訂單中標記「已含在 ERP1 歷史」或選擇「維持」，避免首次匯入重複認列。系統不會只依 Restore 時間將正常訂單列為異常。</p>}
        <ul className="waca-final-list">
          <li className="up">本次增加 <b>+{quantity(increaseTotal)}</b> 件（{increased.length} 個規格）</li>
          <li className="down">本次減少 <b>{decreaseTotal ? `−${quantity(decreaseTotal)}` : '0'}</b> 件（{decreased.length} 個規格）</li>
          <li>仍待核對 <b>{quantity(pendingTotal)}</b> 件{unresolvedTotal > 0 ? `、配對待處理 ${unresolvedTotal} 筆` : ''}：會保存為待核對，不計入數量、之後不會重複計入。</li>
          {baselineChanged.length > 0 && <li className="danger">歷史認列／取消待核對 {baselineChanged.length} 個規格：不會自動扣除，需人工核對。</li>}
          {firstTakeover.length > 0 && <li className="warn">首次接管覆蓋 {firstTakeover.length} 個規格：需勾選下方確認。</li>}
          {planRows.some(keepNote) && <li>維持 {planRows.filter(keepNote).length} 個規格：本次暫不更新，訂單會保存；下次匯入仍會重新判斷，不是永久排除。</li>}
        </ul>
        {decreased.length > 0 && <div className="waca-final-decreases" data-testid="waca-final-decreases"><strong>以下數量會減少（含 ERP1 歷史數量）</strong>
          <ul>{decreased.map(row => <li key={row.variantId}>{specName(row.variantId)}{'　'}{quantity(row.displayBefore)} → {quantity(row.displayAfter)}
            <b className="waca-decrease">（{diffText(row.difference)}）</b><span className="waca-row-note">{MODE_LABEL[row.mode]}</span></li>)}</ul></div>}
        <p className="waca-final-guard">送出時會重新讀取最新資料並比對版本與 Restore 次數，任何不一致都會停止且不寫入；整批一次寫入，不會只寫一部分。</p>
        <details className="waca-final-tech" data-testid="waca-counted-summary"><summary>技術明細</summary>
          <p>安全世代：Restore 第 {pending.counted?.context.restoreEpoch} 次；歷史稽核時間 {pending.counted?.context.baselineAt}（不作為正常訂單認列邊界）。</p>
          <p>認列規則：有效來源正常累加；保留既有認列證據與可追溯淨變動。</p>
          <p>覆蓋 {plan.plan.overwriteVariantIds.length}、累加 {planRows.filter(row => row.touched && row.mode === 'ACCUMULATE').length}、
            維持 {planRows.filter(row => row.touched && row.mode === 'KEEP').length} 個規格（預設：{MODE_LABEL[WACA_DEFAULT_UPDATE_MODE]}）。</p>
        </details>
        {plan.riskyOverwrites.length > 0 && <label className="waca-notice waca-risk" data-testid="waca-overwrite-ack">
          <input type="checkbox" checked={riskAcknowledged} onChange={event => setRiskAcknowledged(event.target.checked)} />
          我已確認：以「覆蓋」更新的 {plan.riskyOverwrites.length} 個規格{!pending.counted?.context.driven ? '（尚未建立接管基準）' : ''}
          會以本次訂單重算取代目前數量，其中 {plan.riskyOverwrites.filter(id => (plan.variants.get(id)?.difference ?? 0) < 0).length} 個會減少。
          若本次歷史訂單不完整，請改用「累加」或「維持」。</label>}
        {countedPlanning.error && <p className="waca-danger" role="alert">{countedPlanning.error}</p>}
        <button className="btn btn-md btn-primary" disabled={busy || pending.result.errors.length > 0
          || Boolean(pending.counted && !countedPlan)
          || Boolean(plan.riskyOverwrites.length > 0 && !riskAcknowledged)}
          onClick={() => void confirmImport()}>確認更新</button>
      </section>
    </>;
  };

  return <PageShell className="waca-page">
    {completion && (getProviderMode() === 'next' || (sync.presentation.status === 'fresh' && sync.presentation.writeAllowed)) &&
      <div className="modal-overlay active" role="presentation" data-testid="waca-update-success-modal">
        <section className="modal-content" role="dialog" aria-modal="true" aria-labelledby="waca-success-title">
          <h2 id="waca-success-title">WACA 更新完成</h2>
          <p>已完成 WACA 訂單與數量更新。</p>
          <p>更新訂單：{completion.orders}<br />更新商品規格：{completion.variants}<br />待處理：{completion.pending}</p>
          <p>{getProviderMode() === 'next' ? '本機' : '雲端'}資料已同步完成。</p>
          <button className="btn btn-primary" autoFocus onClick={() => setCompletion(null)}>確定</button>
        </section>
      </div>}
    <PageHeader className="waca-heading">
      <div><h1>WACA 匯入</h1><p>日常只需匯入一份 WACA 訂單 Excel。確認後會更新訂單、重算數量並自動對帳。</p></div>
      <button className="btn btn-md btn-outline" onClick={() => void load().catch(cause => setError(readErrorText(cause)))} disabled={busy}><RefreshCw size={16} /> 重新讀取</button>
    </PageHeader>
    {error && <div className="waca-notice waca-error" role="alert"><span className="badge badge-danger">{error.label}</span> {error.message}
      {error.diagnostic && <details className="waca-tech"><summary>技術資訊</summary>
        <small>類型：{error.category}／階段：{error.diagnostic.stage}</small>
        {error.diagnostic.code && <small>代碼：{error.diagnostic.code}</small>}
        <small>原因：{error.diagnostic.reason}</small>
        {error.diagnostic.rpc && <small>RPC：{error.diagnostic.rpc}</small>}
        {error.diagnostic.requestId && <small>請求：{error.diagnostic.requestId}</small>}
      </details>}
    </div>}
    {!snapshot && !error && <p role="status">正在讀取 WACA 訂單資料…</p>}
    {message && <div className="waca-notice" role="status"><span className="badge badge-success">已完成</span> {message}</div>}
    {snapshot?.cutoverState?.mode === 'ORDER_REBASELINE_REQUIRED' && (countedSupported
      ? <div className="waca-notice" role="status" data-testid="waca-transition-notice">目前保留 ERP1 備份的歷史數量。正常有效訂單預設累加，不因訂單日期或認列紀錄空白而全部列為待核對。
        可按整組或規格選擇「覆蓋／累加／維持」；覆蓋造成減少仍須確認。首次匯入前請留意整批確認區的歷史重複認列說明。</div>
      : <div className="waca-notice" role="status">目前顯示的是舊備份當時的 WACA 數量。請匯入完整 WACA 歷史訂單；確認更新後，系統會重新計算並取代舊數量。</div>)}
    {countedSupported && snapshot?.cutoverState?.transition && <div className="waca-notice" role="status" data-testid="waca-transition-baseline">
      WACA 認列紀錄已啟用；正常有效訂單預設累加，已認列訂單依來源淨變動更新，不會重複增加。Restore 世代檢查仍保留。</div>}
    {masterState.error && <div className="waca-notice waca-error">{masterState.error}</div>}
    <nav className="waca-tabs" aria-label="WACA 功能">
      {([
        ['import', 'WACA 匯入'], ['orders', '來源訂單'], ['mappings', '商品對照'],
        ['history', '匯入紀錄'], ['pending', `待處理 ${pendingItems.length + conflicts.length + (reconciliation?.issues.length ?? 0) + countedPendingItems.length}`],
      ] as const).map(([key, label]) =>
        <button key={key} className={tab === key ? 'active' : ''} onClick={() => {
          if (key === 'mappings') setVisitedMappings(true);
          setTab(key);
        }}>{label}</button>)}
    </nav>
    <div className="waca-metrics" aria-label="WACA 目前驗收摘要">
      {([
        ['商品特徵', mappingItems.length], ['已配對特徵', matchedFeatures],
        ['人工確認特徵', manualFeatures], ['待處理特徵', mappingItems.length - matchedFeatures],
        ['多候選特徵', multipleFeatures], ['最近一批折扣忽略', latestBatch?.result.discountIgnored ?? 0],
      ] as const).map(([label, value]) => <div key={label}><strong>{quantity(value)}</strong><span>{label}</span></div>)}
    </div>
    {tab === 'import' && <section className="waca-panel">
      <h2><FileSpreadsheet size={19} /> 匯入 WACA 訂單 Excel</h2>
      <p>選擇檔案後先看預覽；按「確認更新」前不會改動訂單或商品數量。</p>
      <p>尚未建立或尚未配對的商品會保存為待處理，不影響其他商品匯入。建立商品後重新匯入，即可配對並重算已保存訂單的 WACA 數量。</p>
      <FileUploadButton accept=".xlsx,.xls" inputLabel="選擇 WACA Excel" label="匯入 WACA Excel"
        selectedFileName={pendingImport?.fileName || chosenFileName} disabled={busy || !snapshot}
        onFile={file => void handleWacaFile(file)} />
      {pendingImport && <>
        <h3>匯入預覽：{pendingImport.fileName}</h3>
        {countedPlan ? renderCountedReview(pendingImport, countedPlan) : <>
        <div className="waca-metrics" aria-label="WACA 匯入預覽摘要">
          {([
            ['訂單', pendingImport.result.ordersTotal], ['商品列', pendingImport.result.productRows],
            ['商品規格', previewFeatures.length],
            ['已配對', previewFeatures.filter(item => Boolean(item.productVariantId)).length],
            ['自動配對', previewFeatures.filter(item => item.match === 'AUTO_MATCH' && Boolean(item.productVariantId)).length],
            ['有效數量', pendingImport.result.effectiveQuantity], ['折扣忽略', pendingImport.result.discountIgnored],
            ['待處理', previewFeatures.filter(item => !item.productVariantId).length + pendingImport.result.statusConflicts.length],
            ['數量變動', changedPreviewVariants],
          ] as const).map(([label, value]) => <div key={label}><strong>{quantity(value)}</strong><span>{label}</span></div>)}
        </div>
        {!!previewFeatures.length && previewFeatures.every(item => item.match === 'AUTO_MATCH' && item.productVariantId && !isPending(item))
          && !pendingImport.result.errors.length && !pendingImport.result.statusConflicts.length
          && <p className="waca-notice">全部商品已完成自動配對。</p>}
        <p className="waca-equation">新增 {pendingImport.result.inserted}、更新 {pendingImport.result.updated}、未變更 {pendingImport.result.unchanged}；
          取消／失敗 {pendingImport.result.cancelledOrders + pendingImport.result.failedOrders} 張訂單不計入數量。</p>
        {pendingImport.items.some(isPending) && <p className="waca-notice">未配對商品會先保存為待處理，暫不計入商品 WACA 數量；商品主檔建立後會自動重新配對，不必重傳 WACA Excel。</p>}
        {pendingImport.result.errors.length > 0 && <p className="waca-danger">資料列錯誤：{pendingImport.result.errors.join('、')}</p>}
        <h3>商品數量變化</h3>
        <p>{rebaselinePreview
          ? '以訂購紀錄表目前保留的 ERP1 WACA 數量，對照本次訂單完整重算結果。點開商品群組可看各規格。'
          : '以目前 WACA 數量對照本次匯入後的重算結果。點開商品群組可看各規格。'}</p>
        <div className="waca-preview-filters">
          <label className="waca-show-unchanged"><input type="checkbox" checked={showUnchanged}
            onChange={event => setShowUnchanged(event.target.checked)} /> 顯示未變更商品</label>
          <label className="waca-show-unchanged"><input type="checkbox" checked={showOnlyBaselineDifferences}
            onChange={event => setShowOnlyBaselineDifferences(event.target.checked)} /> {rebaselinePreview ? '只顯示與 ERP1 有差異' : '只顯示數量差異'}</label>
        </div>
        {!visiblePreviewGroups.length && <p className="waca-no-changes">這份檔案沒有商品數量變動。</p>}
        <div className="waca-group-list">{visiblePreviewGroups.map(group => {
          return <details className={`waca-group ${group.increases + group.decreases ? 'changed' : 'unchanged'}`} key={group.id}>
          <summary><strong className="waca-group-title">{group.title}</strong><span className="waca-group-counts">
            {group.increases > 0 && <em className="waca-chip waca-chip-up">增加 {group.increases}</em>}
            {group.decreases > 0 && <em className="waca-chip waca-chip-down">減少 {group.decreases}</em>}
            {!group.increases && !group.decreases && <em className="waca-chip">數量不變</em>}
            {showUnchanged && group.unchanged > 0 && <em className="waca-chip">一致 {group.unchanged}</em>}
            {group.unresolved.length > 0 && <em className="waca-chip waca-chip-pending">待處理 {group.unresolved.length}</em>}
</span></summary>
          {!!group.children.length && !countedPlan && <div className="waca-scroll"><table><thead><tr><th>規格／SKU</th>
            <th>{rebaselinePreview ? 'ERP1 原 WACA' : '目前 WACA'}</th>
            <th>匯入後 WACA</th><th>差異</th><th>明細</th></tr></thead><tbody>
            {group.children.map(({ variant, comparison }) => {
              const expanded = expandedTraces.has(variant.id);
              return <Fragment key={variant.id}><tr>
                <td><strong>{variant.variant_name || '標準規格'}</strong><small>SKU {variant.myacg_item_code}</small>
                  {[...(previewReasons.get(variant.id) ?? [])]
                    .map(reason => <small key={reason}>{reason}</small>)}</td>
                <td className="waca-quantity-value">{quantity(comparison.baselineQuantity)}</td>
                <td className="waca-quantity-value">{quantity(comparison.recomputedQuantity)}</td>
                <td className={comparison.difference > 0 ? 'waca-increase' : comparison.difference < 0 ? 'waca-decrease' : 'waca-unchanged'}>
                  {signedQuantity(comparison.difference)}</td>
                <td><button type="button" className="waca-detail-toggle"
                  aria-expanded={expanded} aria-label={`${expanded ? '收合' : '查看'} ${variant.myacg_item_code} 明細`}
                  onClick={() => setExpandedTraces(previous => {
                    const next = new Set(previous); if (next.has(variant.id)) next.delete(variant.id); else next.add(variant.id); return next;
                  })}>{expanded ? '▼ 收合明細' : '▶ 查看明細'}</button></td>
              </tr>{expanded && <tr className="waca-trace-row"><td colSpan={5}>
                <div className="waca-trace-summary">{comparison.baselineLabel} {quantity(comparison.baselineQuantity)}｜ERP2 重算 {quantity(comparison.recomputedQuantity)}｜
                  差異 {signedQuantity(comparison.difference)}｜計入 {quantity(comparison.includedOrderCount)} 筆訂單，共 {quantity(comparison.includedQuantity)} 件</div>
                <h4>計入的 WACA 訂單</h4>
                {!comparison.included.length && <p className="waca-trace-empty">目前沒有計入此規格的訂單。</p>}
                {!!comparison.included.length && <div className="waca-scroll waca-trace-table"><table><thead><tr><th>訂單編號</th><th>訂單狀態</th><th>規格／SKU</th><th>數量</th><th>配對方式</th><th>是否計入</th></tr></thead><tbody>
                  {comparison.included.map(trace => <tr key={trace.key}><td>{trace.orderNumber}</td><td>{trace.status}</td>
                    <td>{variant.variant_name || '標準規格'}<small>SKU {variant.myacg_item_code}</small></td><td>{quantity(trace.quantity)}</td>
                    <td>{trace.matchReason}<details className="waca-tech-inline"><summary>技術資訊</summary><small>{trace.resolutionCode ?? trace.matchReason}</small></details></td><td>計入</td></tr>)}
                </tbody><tfoot><tr><td colSpan={3}>合計</td><td>{quantity(comparison.includedQuantity)} 件</td><td colSpan={2}>{quantity(comparison.includedOrderCount)} 筆訂單</td></tr></tfoot></table></div>}
                {!!comparison.excluded.length && <details className="waca-excluded-details"><summary>未計入／待處理（{comparison.excluded.length}）</summary>
                  <div className="waca-scroll waca-trace-table"><table><thead><tr><th>訂單編號</th><th>狀態</th><th>數量</th><th>原因</th></tr></thead><tbody>
                    {comparison.excluded.map(trace => <tr key={trace.key}><td>{trace.orderNumber}</td><td>{trace.status}</td><td>{quantity(trace.quantity)}</td><td>{trace.excludedReason}</td></tr>)}
                  </tbody></table></div></details>}
                <details className="waca-tech waca-ledger-tech"><summary>查看技術資訊</summary>
                  <p>Ledger 匯入前：{quantity(comparison.ledgerBeforeQuantity)}</p><p>本次 Preview 後：{quantity(comparison.ledgerAfterQuantity)}</p>
                  <p>{comparison.baselineLabel}：{quantity(comparison.baselineQuantity)}</p><p>Rebaseline 差異：{signedQuantity(comparison.difference)}</p>
                </details>
              </td></tr>}</Fragment>;
            })}
          </tbody></table></div>}
          {!!group.unresolved.length && <details className="waca-excluded-details waca-group-pending"><summary>未計入／待處理（{group.unresolved.length}）</summary>
            <div className="waca-scroll waca-trace-table"><table><thead><tr><th>訂單編號</th><th>狀態</th><th>數量</th><th>原因</th></tr></thead><tbody>
              {group.unresolved.map(trace => <tr key={trace.key}><td>{trace.orderNumber}</td><td>{trace.status}</td><td>{quantity(trace.quantity)}</td><td>{trace.reason}</td></tr>)}
            </tbody></table></div></details>}
        </details>;
        })}</div>
        <details className="waca-resolution-details"><summary>查看每筆商品的配對理由（含待處理）</summary>
          <p>有效數量 {pendingImport.result.effectiveQuantity} = 已配對 {pendingImport.result.matchedEffectiveQuantity} + 待處理 {pendingImport.result.unmatchedPendingQuantity}</p>
          <div className="waca-scroll"><table><thead><tr><th>訂單</th><th>商品</th><th>規格</th><th>數量</th><th>結果</th></tr></thead><tbody>
            {pendingImport.items.map(item => <tr key={item.key}><td>{item.orderKey.replace('WACA::', '')}</td>
              <td>{displayNameForVariant(item.productVariantId, item.productTitle)}<small>原始 WACA：{item.productTitle}／{item.productCode}</small></td><td>{item.spec1} {item.spec2}</td><td>{item.quantity}</td>
              <td>{resolutionText(item)}{item.productVariantId && <small>SKU {variantById.get(item.productVariantId)?.myacg_item_code}</small>}</td>
            </tr>)}
          </tbody></table></div>
        </details>
        {countedPlanning.error && <p className="waca-danger" role="alert">{countedPlanning.error}</p>}
        <button className="btn btn-md btn-primary" disabled={busy || pendingImport.result.errors.length > 0
          || Boolean(pendingImport.counted && !countedPlan)}
          onClick={() => void confirmImport()}>確認更新</button>
        </>}
      </>}
      <details className="waca-master-import"><summary>進階／維護工具</summary>
        {!!snapshot?.cutoverAudit?.length && <div className="waca-cutover-summary">
          <h3>舊 WACA 數量切換稽核</h3>
          <p>已保存 {snapshot.cutoverAudit.length} 個商品規格的切換紀錄。切換前來源未確認的手動欄位合計{' '}
            {quantity(snapshot.cutoverAudit.reduce((sum, row) => sum + row.unverifiedPreCutoverManualQuantity, 0))} 件，
            僅供查帳，不參與後續 WACA 數量計算。</p>
        </div>}
        <h2><Link2 size={19} /> 補入買動漫 GP → G 原始證據</h2>
        <p>保存 GP → G 原始證據，即使 ERP 尚無 G 或商品已下架也保留；不會新增 ERP 商品。歷史檔可逐份補入。</p>
        <FileUploadButton accept=".xls,.xlsx" inputLabel="選擇買動漫商品匯出檔" label="補入買動漫對照檔"
          selectedFileName={pendingLinks?.fileName} disabled={busy || !snapshot} variant="outline"
          onFile={file => void handleMasterFile(file)} />
        {pendingLinks && <div className="waca-notice">
          {pendingLinks.fileName}：可保存 {pendingLinks.result.accepted} 筆（含 ERP 尚無 G 的證據），
          其中 ERP 無對應子編號 {pendingLinks.result.missingVariant} 筆，
          子編號不唯一 {pendingLinks.result.ambiguousVariant} 筆。
          <button className="btn btn-md btn-primary" disabled={busy} onClick={() => void confirmMasterLinks()}>確認保存對照</button>
        </div>}
        <p>目前已有 {masterState.links.length} 筆經買動漫原始資料驗證的主子對照。</p>
      </details>
    </section>}
    {tab === 'orders' && <section className="waca-panel"><h2>WACA 來源訂單</h2>
      {snapshot && !orders.length && <p>目前沒有 WACA 訂單。匯入 WACA Excel 後會顯示在這裡。</p>}
      <div className="waca-scroll"><table><thead><tr><th>訂單編號</th><th>購買日期</th><th>狀態</th><th>品項</th><th>有效已配對數量</th><th>操作</th></tr></thead><tbody>
        {orders.map(order => {
          const orderItems = itemsByOrder.get(order.key) ?? [];
          const counted = ['處理中', '完成付款'].includes(order.status)
            ? orderItems.filter(item => item.productVariantId).reduce((sum, item) => sum + item.quantity, 0) : 0;
          return <Fragment key={order.key}><tr>
            <td>{order.orderNumber}</td><td>{order.purchasedAt}</td><td>{order.status}</td><td>{orderItems.length}</td><td>{counted}</td>
            <td><button type="button" className="waca-detail-toggle" aria-expanded={expandedOrder === order.key}
              aria-label={`查看／管理 ${order.orderNumber}`} onClick={() => setExpandedOrder(expandedOrder === order.key ? null : order.key)}>查看／管理</button></td>
          </tr>{expandedOrder === order.key && <tr><td colSpan={6}>
            <OrderRecognitionManager order={order} items={orderItems} variants={variantById} enabled={countedSupported && !busy}
              batches={snapshot?.batches ?? []}
              driven={snapshot?.cutoverState?.mode === 'ORDER_DRIVEN_ACTIVE'}
              onWriteStateChange={value => { confirming.current = value; setBusy(value); }}
              onCommitted={async (saved, freshVariants) => {
                if (!refreshAuthoritative) throw new Error('WACA_TARGETED_REFRESH_UNAVAILABLE');
                const refreshed = await refreshAuthoritative(['products']);
                if (!refreshed || refreshed.conflicts.length) throw new Error('WACA_TARGETED_REFRESH_CONFLICT');
                const deadline = Date.now() + 10_000;
                while (syncRef.current.status !== 'fresh' || !syncRef.current.writeAllowed) {
                  if (Date.now() >= deadline) throw new Error('WACA_GLOBAL_SYNC_NOT_CONVERGED');
                  await new Promise(resolve => setTimeout(resolve, 25));
                }
                setSnapshot(saved); setVariants(freshVariants);
              }} />
          </td></tr>}</Fragment>;
        })}
      </tbody></table></div>
    </section>}
    {(tab === 'mappings' || visitedMappings) && <section hidden={tab !== 'mappings'}
      className={tab === 'mappings' ? 'waca-panel' : undefined}>{mappingsPanel}</section>}
    {tab === 'history' && <section className="waca-panel"><h2>WACA 匯入紀錄</h2>
      {snapshot && !importBatches.length && <p>目前沒有 WACA 匯入紀錄。</p>}
      <div className="waca-scroll"><table><thead><tr><th>匯入時間</th><th>檔案</th><th>訂單</th><th>商品列</th><th>新增</th><th>更新</th><th>未變更</th><th>取消／失敗</th><th>已配對</th><th>待處理</th><th>有效數量</th><th>數量對帳</th></tr></thead><tbody>
        {[...importBatches].reverse().map(batch => <tr key={batch.id}><td>{batch.importedAt}</td><td>{batch.fileName}</td>
          <td>{batch.result.ordersTotal}</td><td>{batch.result.productRows}</td><td>{batch.inserted}</td><td>{batch.updated}</td><td>{batch.unchanged}</td>
          <td>{batch.result.cancelledOrders + batch.result.failedOrders}</td><td>{batch.result.matched}</td>
          <td>{batch.result.unmatched + batch.result.multipleCandidates + batch.result.statusConflicts.length}</td>
          <td>{batch.result.effectiveQuantity}</td><td>{batch.reconciliation ? `${batch.reconciliation.status} ${batch.reconciliation.passed}/${batch.reconciliation.total}` : '未記錄'}</td></tr>)}
      </tbody></table></div>
    </section>}
    {tab === 'pending' && <section className="waca-panel"><h2>需要處理的項目</h2>
      <div className="waca-pending-card" role="status" aria-label="待處理來源摘要">
        <strong>累積待處理，不是本次新增筆數</strong>
        <p>未配對訂單列：{pendingItems.length} 列（{new Set(pendingItems.map(item => item.feature)).size} 種商品特徵）。</p>
        <p>有效數量摘要：{reconciliation?.issues.filter(issue => issue.reason === 'UNMATCHED_SOURCE').length ?? 0} 項，與上述訂單列重疊；
          其他對帳異常：{reconciliation?.issues.filter(issue => issue.reason !== 'UNMATCHED_SOURCE').length ?? 0} 項；狀態衝突：{conflicts.length} 筆。</p>
        <p>分頁數字是上述列示項目的合計，不是商品種類數，也不是最近匯入新增的錯誤數。</p>
        {latestBatch ? <>
          <p>最近已完成匯入：{latestBatch.fileName}</p>
          <p>該檔案：{latestBatch.result.ordersTotal} 張訂單、{latestBatch.result.productRows} 商品列；
            已配對：{latestBatch.result.matched} 列，待配對：{latestBatch.result.unmatched + latestBatch.result.multipleCandidates} 列，
            狀態衝突：{latestBatch.result.statusConflicts.length} 筆。</p>
          {latestBatch.result.unmatched + latestBatch.result.multipleCandidates === 0 && !latestBatch.result.statusConflicts.length
            && pendingItems.length > 0 && <p>最近檔案沒有未配對商品；下方保留的是歷史訂單待處理，不是這次匯入失敗。</p>}
        </> : <p>目前沒有已完成匯入紀錄，無法判定最近檔案的結果。</p>}
      </div>
      {reconciliation?.issues.map((issue, index) => <div className="waca-pending-card" key={`reconcile-${issue.variantId}-${issue.sku}-${index}`}>
        <strong>{displayNameForVariant(issue.variantId, issue.productTitle)}／{issue.variantTitle}</strong>
        <p>{issue.reason === 'UNMATCHED_SOURCE' ? 'WACA 商品編號' : 'SKU'}：{issue.sku}</p>{issue.reason === 'UNMATCHED_SOURCE'
          ? <p>尚未建立對應的商品主檔／規格；有效訂單商品數量 {issue.sourceQuantity} 件已保存為待處理，暫不計入 WACA 數量。商品主檔建立後系統會自動重新配對；也可在商品對照中人工確認，不需要先加入訂購紀錄表。</p>
          : <><p>來源訂單數量 {issue.sourceQuantity}，系統 WACA 數量 {issue.storedQuantity}，差異 {issue.difference > 0 ? '+' : ''}{issue.difference}。</p>
            <p>訂購紀錄表顯示 {issue.displayedQuantity}。請重新讀取後確認；若仍不一致，先不要繼續匯入。</p></>}
        <details className="waca-tech"><summary>查看技術資訊</summary>{issue.reason}／{issue.variantId}</details>
      </div>)}
      {pendingItems.map(item => <div className="waca-pending-card" key={item.key}>
        <strong>{item.productTitle}／{item.spec1} {item.spec2}</strong>
        <p>WACA 商品：{item.productCode}</p>
        <p>訂單 {item.orderKey.replace('WACA::', '')}，數量 {item.quantity}</p>
        <p>{resolutionText(item)}</p>
        {parentConfirmation(item)}
        {choicesFor(item).length ? <details className="waca-tech"><summary>查看可能規格與技術資訊</summary><ul>{choicesFor(item).map(choice => <li key={`${choice.childCode}::${choice.variantId}`}>
          {choice.mainCode || '直接 G'} → {choice.childCode}／買動漫規格 {choice.variantTitle || '未提供'}／
          ERP ProductVariant {choice.variantId || '不存在'}／證據 {choice.sourceFile || 'ERP G 編號'}
        </li>)}</ul></details> : <p>找不到可安全確認的規格，請在買動漫商品主檔檢查。</p>}
        <select aria-label={`處理 ${item.productCode} ${item.spec1}`} value={selectedVariant[item.feature] ?? ''} onChange={event => setSelectedVariant(previous => ({ ...previous, [item.feature]: event.target.value }))}>
          <option value="">選擇此商品的規格</option>
          {choicesFor(item).filter(choice => choice.variantId).map(choice => <option key={choice.variantId} value={choice.variantId}>{displayNameForVariant(choice.variantId, choice.productTitle)}／{choice.variantTitle}／{choice.childCode}</option>)}
        </select>
        <button className="btn btn-outline" disabled={busy || !selectedVariant[item.feature]} onClick={() => void manualMap(item)}>確認對照</button>
      </div>)}
      {countedPendingItems.length > 0 && <div className="waca-pending-card" data-testid="waca-counted-pending">
        <strong>待核對：已配對但尚未計入 WACA 數量的訂單（{countedPendingItems.length}）</strong>
        <p>這些訂單已保存，不會遺失；確認前不計入數量，也不會重複計入。</p>
        <div className="waca-scroll"><table><thead><tr><th>訂單</th><th>商品／規格</th><th>數量</th><th>已計入</th><th>原因</th><th>決定</th></tr></thead><tbody>
          {countedPendingItems.map(item => <tr key={item.key}><td>{item.orderKey.replace('WACA::', '')}<small>{repo?.orders.get(item.orderKey)?.purchasedAt}</small></td>
            <td>{displayNameForVariant(item.productVariantId, item.productTitle)}<small>{variantById.get(item.productVariantId ?? '')?.variant_name}／SKU {variantById.get(item.productVariantId ?? '')?.myacg_item_code}</small></td>
            <td>{item.quantity}</td><td>{item.countedQuantity ?? 0}</td><td>{REASON_LABEL[item.countedReason ?? 'PENDING_REVIEW'] ?? item.countedReason}</td>
            <td><button className="btn btn-outline" disabled={busy} onClick={() => void decidePending(item, 'COUNT_AS_NEW')}>計入（新訂單）</button>
              <button className="btn btn-outline" disabled={busy} onClick={() => void decidePending(item, 'BASELINE_INCLUDED')}>已含在 ERP1 歷史</button></td></tr>)}
        </tbody></table></div>
      </div>}
      {!pendingItems.length && !conflicts.length && !reconciliation?.issues.length && !countedPendingItems.length && <p>目前沒有需要處理的商品。</p>}
      {conflicts.map(({ batch, orderKey, rows }) => <div className="waca-pending-card" key={`${batch.id}::${orderKey}`}>
        <strong>狀態衝突：{orderKey.replace('WACA::', '')}</strong>
        <p>{batch.fileName}；同一匯入檔出現 {new Set(rows.map(row => row.orderStatus)).size} 種訂單狀態，尚未計入。</p>
        <select aria-label={`確認訂單狀態 ${orderKey}`} value={selectedStatus[orderKey] ?? ''} onChange={event => setSelectedStatus(previous => ({ ...previous, [orderKey]: event.target.value as WacaStatus }))}>
          <option value="">選擇正確狀態</option>
          {(['處理中', '完成付款', '取消', '失敗'] as const).map(status => <option key={status} value={status}>{status}</option>)}
        </select>
        <button className="btn btn-outline" disabled={busy || !selectedStatus[orderKey]}
          onClick={() => void resolveConflict(batch, orderKey, rows)}>確認狀態並重算</button>
      </div>)}
    </section>}
  </PageShell>;
}
