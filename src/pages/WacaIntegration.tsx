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
import { commitAndVerifyWaca, commitAndVerifyWacaRematch } from '../waca/confirmFlow';
import { useCloudResourceSync, useGlobalSyncControl } from '../contexts/CloudRealtimeSyncContext';
import './WacaIntegration.css';

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
};
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
          const wanted = snapshotFromRepository(nextSnapshot, candidate, nextSnapshot.batches, mergedLinks);
          const verified = await commitAndVerifyWacaRematch({ provider: dataProvider,
            current: nextSnapshot, candidate: wanted, cloud: getProviderMode() !== 'next' });
          nextSnapshot = verified.snapshot;
          nextVariants = verified.variants;
          setMessage(result.autoResolved
            ? `商品主檔更新後已自動配對 ${result.autoResolved} 筆歷史待處理資料，WACA 數量已重新計算。`
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
  }, [setError]);

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
  const latestBatch = snapshot?.batches.at(-1);
  const matchedFeatures = mappingItems.filter(item => item.productVariantId).length;
  const manualFeatures = mappingItems.filter(item => item.match === 'MANUAL_MATCH').length;
  const multipleFeatures = mappingItems.filter(item => item.diagnostic === 'MULTIPLE_VARIANT_CANDIDATES').length;
  const rebaselinePreview = snapshot?.cutoverState?.mode === 'ORDER_REBASELINE_REQUIRED'
    || snapshot?.cutoverState?.mode === 'LEGACY_QUANTITY_ACTIVE';
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
  const previewGroups = useMemo(() => {
    if (!pendingImport) return [];
    const touched = new Set([...pendingImport.items.map(item => item.productVariantId),
      ...pendingImport.result.quantityChanges.map(change => change.variantId)].filter((id): id is string => Boolean(id)));
    const touchedGroups = new Set(variants.filter(row => touched.has(row.id)).map(row => row.product_group_id || row.id));
    for (const groupId of previewUnresolvedByGroup.keys()) touchedGroups.add(groupId);
    const variantsByGroup = new Map<string, ProductVariant[]>();
    for (const variant of variants) {
      const groupId = variant.product_group_id || variant.id;
      variantsByGroup.set(groupId, [...(variantsByGroup.get(groupId) ?? []), variant]);
    }
    const skuSort = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    return [...touchedGroups].map(id => {
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
        increases: children.filter(row => row.comparison.difference > 0).length,
        decreases: children.filter(row => row.comparison.difference < 0).length,
        unchanged: children.filter(row => row.comparison.difference === 0).length };
    }).sort((a, b) => Number(b.increases + b.decreases > 0) - Number(a.increases + a.decreases > 0)
      || (b.increases + b.decreases) - (a.increases + a.decreases) || a.title.localeCompare(b.title));
  }, [pendingImport, variants, groupById, previewUnresolvedByGroup]);
  const visiblePreviewGroups = previewGroups.map(group => ({ ...group, children: group.children.filter(row =>
    isWacaPreviewVariantVisible(row.comparison, showUnchanged, showOnlyBaselineDifferences)) }))
    .filter(group => group.children.length > 0 || group.unresolved.length > 0);
  const changedPreviewVariants = previewGroups.reduce((sum, group) => sum
    + group.children.filter(row => row.comparison.ledgerBeforeQuantity !== row.comparison.ledgerAfterQuantity).length, 0);

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
    try {
      if (masterState.error) throw new Error(masterState.error);
      const parsed = parseWacaWorkbook(await file.arrayBuffer());
      const importId = crypto.randomUUID();
      const { currentRepo, candidate, result } = run(parsed.rows, snapshot, importId);
      const keys = new Set(parsed.rows.map(row => `${wacaOrderKey(row.orderNumber)}::${wacaFeature(row)}`));
      const comparisonByVariant = buildWacaPreviewComparisons(
        variants, currentRepo, candidate, snapshot.cutoverState?.mode,
      );
      setPendingImport({
        fileName: file.name, rows: parsed.rows, revision: snapshot.revision, importId, result,
        items: [...candidate.items.values()].filter(item => keys.has(`${item.orderKey}::${item.feature}`)),
        candidateOrders: [...candidate.orders.values()],
        links: masterState.links,
        comparisonByVariant,
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
      const next = snapshotFromRepository(current, candidate, [...current.batches, batch], pendingImport.links);
      const cloud = getProviderMode() !== 'next';
      const { snapshot: finalSnapshot, variants: finalVariants, checked: finalCheck } = await commitAndVerifyWaca({
        provider: dataProvider, current, candidate: next, requestId: batch.id, cloud,
        onStage: value => { stage = value; if (value === 'readback') performance.mark('waca-confirm:readback'); },
      });
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
        setMessage(`WACA 訂單已保存，已配對商品的數量已更新；${pendingFeatures} 個商品／規格保留為待處理。商品主檔建立後，系統會自動重新配對並更新數量，不必重傳 WACA Excel。`);
      } else {
        setMessage(`WACA 更新完成：${finalCheck.passed} / ${finalCheck.total} 商品對帳一致，${finalCheck.effectiveQuantity} 件有效數量已更新，0 個需要處理。`);
      }
      if (!integrityIssues.length && !result.statusConflicts.length) setCompletion({
        orders: new Set(pendingImport.rows.map(row => wacaOrderKey(row.orderNumber))).size,
        variants: result.quantityChanges.length, pending: pendingFeatures,
      });
    } catch (cause) { setMessage(''); setError(classifyWacaError(cause, stage, pendingImport.importId)); }
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
    } catch (cause) { setError(classifyWacaError(cause, stage)); }
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
      await dataProvider.commitNextWacaSnapshot(
        snapshotFromRepository(current, candidate, current.batches, masterState.links), current.revision, true,
      );
      stage = 'readback';
      await load();
      setMessage('商品對照已保存；所有受影響歷史訂單的 WACA 數量已重算。');
    } catch (cause) { setError(classifyWacaError(cause, stage)); }
    finally { setBusy(false); }
  }, [snapshot, choicesFor, selectedVariant, selectedParent, variants, masterState.links, masterIndex, load, setError]);

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
      await dataProvider.commitNextWacaSnapshot(
        snapshotFromRepository(current, candidate, batches, masterState.links), current.revision, true,
      );
      stage = 'readback';
      await load();
      setMessage(`${orderKey} 已按「${status}」重新計算。`);
    } catch (cause) { setError(classifyWacaError(cause, stage)); }
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
    {snapshot?.cutoverState?.mode === 'ORDER_REBASELINE_REQUIRED' &&
      <div className="waca-notice" role="status">目前顯示的是舊備份當時的 WACA 數量。請匯入完整 WACA 歷史訂單；確認更新後，系統會重新計算並取代舊數量。</div>}
    {masterState.error && <div className="waca-notice waca-error">{masterState.error}</div>}
    <nav className="waca-tabs" aria-label="WACA 功能">
      {([
        ['import', 'WACA 匯入'], ['orders', '來源訂單'], ['mappings', '商品對照'],
        ['history', '匯入紀錄'], ['pending', `待處理 ${pendingItems.length + conflicts.length + (reconciliation?.issues.length ?? 0)}`],
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
        <div className="waca-group-list">{visiblePreviewGroups.map(group => <details className={`waca-group ${group.increases + group.decreases ? 'changed' : 'unchanged'}`} key={group.id}>
          <summary><strong>{group.title}</strong><span>增加 {group.increases}、減少 {group.decreases}、差異 {group.increases + group.decreases}
            {showUnchanged ? `、一致 ${group.unchanged}` : ''}{group.unresolved.length ? `、待處理 ${group.unresolved.length}` : ''}</span></summary>
          {!!group.children.length && <div className="waca-scroll"><table><thead><tr><th>規格／SKU</th>
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
        </details>)}</div>
        <details className="waca-resolution-details"><summary>查看每筆商品的配對理由（含待處理）</summary>
          <p>有效數量 {pendingImport.result.effectiveQuantity} = 已配對 {pendingImport.result.matchedEffectiveQuantity} + 待處理 {pendingImport.result.unmatchedPendingQuantity}</p>
          <div className="waca-scroll"><table><thead><tr><th>訂單</th><th>商品</th><th>規格</th><th>數量</th><th>結果</th></tr></thead><tbody>
            {pendingImport.items.map(item => <tr key={item.key}><td>{item.orderKey.replace('WACA::', '')}</td>
              <td>{displayNameForVariant(item.productVariantId, item.productTitle)}<small>原始 WACA：{item.productTitle}／{item.productCode}</small></td><td>{item.spec1} {item.spec2}</td><td>{item.quantity}</td>
              <td>{resolutionText(item)}{item.productVariantId && <small>SKU {variantById.get(item.productVariantId)?.myacg_item_code}</small>}</td>
            </tr>)}
          </tbody></table></div>
        </details>
        <button className="btn btn-md btn-primary" disabled={busy || pendingImport.result.errors.length > 0}
          onClick={() => void confirmImport()}>確認更新</button>
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
      <div className="waca-scroll"><table><thead><tr><th>訂單編號</th><th>購買日期</th><th>狀態</th><th>品項</th><th>有效已配對數量</th></tr></thead><tbody>
        {orders.map(order => {
          const orderItems = itemsByOrder.get(order.key) ?? [];
          const counted = ['處理中', '完成付款'].includes(order.status)
            ? orderItems.filter(item => item.productVariantId).reduce((sum, item) => sum + item.quantity, 0) : 0;
          return <tr key={order.key} className="waca-click-row" onClick={() => setExpandedOrder(expandedOrder === order.key ? null : order.key)}>
            <td>{order.orderNumber}{expandedOrder === order.key && <div className="waca-order-lines">
              {orderItems.map(item => <p key={item.key}>{displayNameForVariant(item.productVariantId, item.productTitle)}／{item.spec1} {item.spec2} × {item.quantity}
                {item.productVariantId ? `／SKU ${variantById.get(item.productVariantId)?.myacg_item_code}` : `／${statusText[item.diagnostic ?? '']}`}
                <details className="waca-tech"><summary>原始資料</summary>{item.productTitle}／{item.productCode}</details></p>)}
            </div>}</td><td>{order.purchasedAt}</td><td>{order.status}</td><td>{orderItems.length}</td><td>{counted}</td>
          </tr>;
        })}
      </tbody></table></div>
    </section>}
    {(tab === 'mappings' || visitedMappings) && <section hidden={tab !== 'mappings'}
      className={tab === 'mappings' ? 'waca-panel' : undefined}>{mappingsPanel}</section>}
    {tab === 'history' && <section className="waca-panel"><h2>WACA 匯入紀錄</h2>
      {snapshot && !snapshot.batches.length && <p>目前沒有 WACA 匯入紀錄。</p>}
      <div className="waca-scroll"><table><thead><tr><th>匯入時間</th><th>檔案</th><th>訂單</th><th>商品列</th><th>新增</th><th>更新</th><th>未變更</th><th>取消／失敗</th><th>已配對</th><th>待處理</th><th>有效數量</th><th>數量對帳</th></tr></thead><tbody>
        {[...(snapshot?.batches ?? [])].reverse().map(batch => <tr key={batch.id}><td>{batch.importedAt}</td><td>{batch.fileName}</td>
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
      {!pendingItems.length && !conflicts.length && !reconciliation?.issues.length && <p>目前沒有需要處理的商品。</p>}
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
