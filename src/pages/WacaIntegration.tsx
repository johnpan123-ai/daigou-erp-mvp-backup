import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileSpreadsheet, Link2, RefreshCw } from 'lucide-react';
import { PageHeader, PageShell } from '../components/layout/PageHeader';
import { FileUploadButton } from '../components/FileUploadButton';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';
import { parseMyAcgFile } from '../utils/myacgParser';
import { normalizeProductTitle, type InventoryItem, type ProductGroup, type ProductVariant } from '../lib/db';
import { productGroupDisplayName } from '../lib/productGroupDisplayName';
import {
  cloneWacaRepository, importWacaRows, normalizeWacaText,
  matchWacaItem, refreshWacaMasterStatus, setWacaMapping, wacaFeature, wacaOrderKey,
  type MasterVariant, type WacaImportResult, type WacaItem, type WacaRow, type WacaStatus,
} from '../waca/orderCore';
import {
  buildWacaMasterReference, linksFromMyAcgInventory, mergeMyAcgMasterLinks,
  type LinkImportResult, type MyAcgMasterLink,
} from '../waca/masterReference';
import {
  repositoryFromSnapshot, snapshotFromRepository,
  type NextWacaSnapshot, type WacaBatch,
} from '../waca/nextStorage';
import { parseWacaWorkbook } from '../waca/workbookParser';
import { reconcileWacaReadback } from '../waca/reconciliation';
import './WacaIntegration.css';

type Tab = 'import' | 'orders' | 'mappings' | 'history' | 'pending';
type PendingImport = {
  fileName: string;
  rows: WacaRow[];
  revision: number;
  importId: string;
  result: WacaImportResult;
  items: WacaItem[];
  links: MyAcgMasterLink[];
  afterQuantities: Map<string, number>;
};
type PendingLinks = { fileName: string; revision: number; result: LinkImportResult; links: MyAcgMasterLink[] };

const statusText: Record<string, string> = {
  MASTER_EVIDENCE_MISSING: '找不到對應商品',
  MASTER_MAPPING_MISSING: '找不到對應商品',
  MASTER_GROUP_LINK_MISSING: '商品群組需要確認',
  VARIANT_NOT_MATCHED: '規格需要確認',
  MULTIPLE_VARIANT_CANDIDATES: '找到多個可能規格',
  VARIANT_NOT_IN_ERP: '找不到對應商品',
  PRODUCT_NOT_IN_MASTER: '找不到對應商品',
  NAME_CONFLICT: '商品名稱需要確認',
};

const quantity = (value: number) => value.toLocaleString('zh-TW');
const isPending = (item: WacaItem) => !item.productVariantId;

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
  const [pendingLinks, setPendingLinks] = useState<PendingLinks | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<Record<string, string>>({});
  const [selectedStatus, setSelectedStatus] = useState<Record<string, WacaStatus>>({});
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [nextSnapshot, nextVariants, nextInventory, nextGroups] = await Promise.all([
      dataProvider.getNextWacaSnapshot(),
      dataProvider.getAuthoritativeWacaVariants(),
      dataProvider.getInventory(),
      dataProvider.getProductGroups(),
    ]);
    setSnapshot(nextSnapshot);
    setVariants(nextVariants);
    setInventory(nextInventory);
    setGroups(nextGroups);
  }, []);

  useEffect(() => {
    if (!['next', 'cloud', 'fallback'].includes(getProviderMode())) return;
    void Promise.resolve().then(load).catch(cause => setError(String(cause)));
  }, [load]);

  const masterState = useMemo(() => {
    if (!snapshot) return { links: [] as MyAcgMasterLink[], master: [] as MasterVariant[], error: '' };
    try {
      const fromInventory = linksFromMyAcgInventory(inventory, variants, 'NEXT_CURRENT_MYACG_CATALOG', '');
      const links = mergeMyAcgMasterLinks(fromInventory.links, snapshot.masterLinks);
      return { links, master: buildWacaMasterReference(variants, links), error: '' };
    } catch (cause) {
      return { links: snapshot.masterLinks, master: buildWacaMasterReference(variants, snapshot.masterLinks), error: String(cause) };
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
  const masterByCode = useMemo(() => {
    const byCode = new Map<string, MasterVariant[]>();
    for (const candidate of masterState.master) {
      if (!candidate.active) continue;
      const codes = new Set([normalizeWacaText(candidate.mainCode), normalizeWacaText(candidate.childCode)]);
      for (const code of codes) {
        if (!code) continue;
        const candidates = byCode.get(code) ?? [];
        candidates.push(candidate);
        byCode.set(code, candidates);
      }
    }
    return byCode;
  }, [masterState.master]);
  const evidenceByChildCode = useMemo(() => new Map(masterState.links.map(link => [link.childCode, link])), [masterState.links]);
  const explanationByFeature = useMemo(() => new Map(mappingItems.map(item => {
    const code = normalizeWacaText(item.productCode);
    const match = matchWacaItem({
      orderStatus: '', orderNumber: '', purchasedAt: '', productCode: item.productCode,
      productTitle: item.productTitle, spec1: item.spec1, spec2: item.spec2,
      specCode: item.specCode, quantity: item.quantity, subtotal: item.subtotal,
    }, masterByCode.get(code) ?? []);
    return [item.feature, match.diagnostic ? statusText[match.diagnostic] : '已找到安全候選'] as const;
  })), [mappingItems, masterByCode]);
  const latestBatch = snapshot?.batches.at(-1);
  const matchedFeatures = mappingItems.filter(item => item.productVariantId).length;
  const manualFeatures = mappingItems.filter(item => item.match === 'MANUAL_MATCH').length;
  const multipleFeatures = mappingItems.filter(item => item.diagnostic === 'MULTIPLE_VARIANT_CANDIDATES').length;
  const previewFeatures = useMemo(() => pendingImport
    ? [...new Map(pendingImport.items.map(item => [item.feature, item])).values()] : [], [pendingImport]);
  const previewGroups = useMemo(() => {
    if (!pendingImport) return [];
    const touched = new Set(pendingImport.items.map(item => item.productVariantId).filter((id): id is string => Boolean(id)));
    const touchedGroups = new Set(variants.filter(row => touched.has(row.id)).map(row => row.product_group_id || row.id));
    const skuSort = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    return [...touchedGroups].map(id => {
      const children = variants.filter(row => (row.product_group_id || row.id) === id).map(variant => {
        const before = snapshot?.cutoverAudit?.length ? (repo?.autoQuantities.get(variant.id) ?? 0) : 0;
        const after = pendingImport.afterQuantities.get(variant.id) ?? 0;
        return { variant, before, after, delta: after - before };
      }).sort((a, b) => {
        const left = a.variant.myacg_item_code?.trim();
        const right = b.variant.myacg_item_code?.trim();
        if (!left || !right) return Number(!left) - Number(!right)
          || a.variant.variant_name.localeCompare(b.variant.variant_name) || a.variant.id.localeCompare(b.variant.id);
        return skuSort.compare(left, right) || a.variant.id.localeCompare(b.variant.id);
      });
      const group = groupById.get(id);
      return { id, title: group ? productGroupDisplayName(group)
        : normalizeProductTitle(children[0]?.variant.product_title || '未命名商品群組'),
        children, increases: children.filter(row => row.delta > 0).length,
        decreases: children.filter(row => row.delta < 0).length,
        unchanged: children.filter(row => row.delta === 0).length };
    }).sort((a, b) => Number(b.increases + b.decreases > 0) - Number(a.increases + a.decreases > 0)
      || (b.increases + b.decreases) - (a.increases + a.decreases) || a.title.localeCompare(b.title));
  }, [pendingImport, variants, repo, groupById, snapshot]);
  const visiblePreviewGroups = showUnchanged ? previewGroups : previewGroups
    .filter(group => group.increases + group.decreases > 0)
    .map(group => ({ ...group, children: group.children.filter(row => row.delta !== 0) }));
  const changedPreviewVariants = previewGroups.reduce((sum, group) => sum + group.increases + group.decreases, 0);

  const run = (rows: WacaRow[], current: NextWacaSnapshot, importId: string, links = masterState.links) => {
    const currentRepo = repositoryFromSnapshot(current, variants);
    const candidate = cloneWacaRepository(currentRepo);
    const master = buildWacaMasterReference(variants, links);
    const result = importWacaRows(rows, candidate, master, importId);
    refreshWacaMasterStatus(candidate, master);
    return { candidate, result };
  };

  const handleWacaFile = async (file?: File) => {
    if (!file || !snapshot) return;
    setChosenFileName(file.name);
    setBusy(true); setError(''); setMessage(''); setPendingImport(null); setShowUnchanged(false);
    try {
      if (masterState.error) throw new Error(masterState.error);
      const parsed = parseWacaWorkbook(await file.arrayBuffer());
      const importId = crypto.randomUUID();
      const { candidate, result } = run(parsed.rows, snapshot, importId);
      const keys = new Set(parsed.rows.map(row => `${wacaOrderKey(row.orderNumber)}::${wacaFeature(row)}`));
      setPendingImport({
        fileName: file.name, rows: parsed.rows, revision: snapshot.revision, importId, result,
        items: [...candidate.items.values()].filter(item => keys.has(item.key)),
        links: masterState.links,
        afterQuantities: new Map(candidate.autoQuantities),
      });
    } catch (cause) { setChosenFileName(''); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const confirmImport = async () => {
    if (!pendingImport || !snapshot || pendingImport.result.errors.length) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const current = await dataProvider.getNextWacaSnapshot();
      if (current.revision !== pendingImport.revision) throw new Error('WACA 資料已變更，請重新預覽檔案。');
      await dataProvider.exportData();
      const { candidate, result } = run(pendingImport.rows, current, pendingImport.importId, pendingImport.links);
      const conflicts = new Set(result.statusConflicts);
      const batch: WacaBatch = {
        id: pendingImport.importId, fileName: pendingImport.fileName, importedAt: new Date().toISOString(),
        rows: pendingImport.rows.length, inserted: result.inserted, updated: result.updated,
        unchanged: result.unchanged, result,
        conflictRows: pendingImport.rows.filter(row => conflicts.has(wacaOrderKey(row.orderNumber))),
      };
      const next = snapshotFromRepository(current, candidate, [...current.batches, batch], pendingImport.links);
      await dataProvider.commitNextWacaSnapshot(next, current.revision, true);
      const saved = await dataProvider.getNextWacaSnapshot();
      const savedVariants = await dataProvider.getAuthoritativeWacaVariants();
      const checked = reconcileWacaReadback(saved, savedVariants);
      const recorded = { status: checked.status, passed: checked.passed, total: checked.total,
        effectiveQuantity: checked.effectiveQuantity, checkedAt: new Date().toISOString() };
      const recordedBatches = saved.batches.map(row => row.id === batch.id ? { ...row, reconciliation: recorded } : row);
      if (getProviderMode() === 'next') {
        await dataProvider.commitNextWacaSnapshot({ ...saved, batches: recordedBatches }, saved.revision, false);
      }
      const finalSnapshot = await dataProvider.getNextWacaSnapshot();
      const finalVariants = await dataProvider.getAuthoritativeWacaVariants();
      const finalCheck = reconcileWacaReadback(finalSnapshot, finalVariants);
      if (finalSnapshot.batches.at(-1)?.reconciliation?.status !== finalCheck.status) {
        throw new Error('匯入紀錄與數量對帳結果不一致，請重新讀取並檢查待處理。');
      }
      setPendingImport(null);
      setChosenFileName('');
      await load();
      const remaining = result.unmatched + result.multipleCandidates + result.statusConflicts.length;
      if (finalCheck.status === 'PASS' && remaining === 0) {
        setMessage(`WACA 更新完成：${finalCheck.passed} / ${finalCheck.total} 商品對帳一致，${finalCheck.effectiveQuantity} 件有效數量已更新，0 個需要處理。`);
      } else {
        setTab('pending');
        setError(`WACA 訂單已保存，但有 ${finalCheck.issues.length + remaining} 個項目需要確認。`);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const handleMasterFile = async (file?: File) => {
    if (!file || !snapshot) return;
    setBusy(true); setError(''); setMessage(''); setPendingLinks(null);
    try {
      const parsed = await parseMyAcgFile(file);
      const result = linksFromMyAcgInventory(parsed, variants, file.name, new Date().toISOString());
      const links = mergeMyAcgMasterLinks(masterState.links, result.links);
      setPendingLinks({ fileName: file.name, revision: snapshot.revision, result, links });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const confirmMasterLinks = async () => {
    if (!snapshot || !pendingLinks) return;
    setBusy(true); setError('');
    try {
      const current = await dataProvider.getNextWacaSnapshot();
      if (current.revision !== pendingLinks.revision) throw new Error('對照資料已變更，請重新選擇買動漫檔案。');
      await dataProvider.exportData();
      await dataProvider.commitNextWacaSnapshot({ ...current, masterLinks: pendingLinks.links }, current.revision, false);
      setPendingLinks(null);
      await load();
      setMessage(`已保存 ${pendingLinks.result.accepted} 筆買動漫 GP → G 對照證據。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const choicesFor = useCallback((item: WacaItem) => {
    return masterByCode.get(normalizeWacaText(item.productCode)) ?? [];
  }, [masterByCode]);

  const explanationFor = useCallback((item: WacaItem) => {
    return explanationByFeature.get(item.feature) ?? '規格需要確認';
  }, [explanationByFeature]);

  const manualMap = useCallback(async (item: WacaItem) => {
    if (!snapshot) return;
    const chosen = choicesFor(item).find(row => row.variantId === selectedVariant[item.feature]);
    if (!chosen || !chosen.variantId) { setError('請先選擇同一買動漫 GP 底下且 ERP 存在的子規格。'); return; }
    setBusy(true); setError('');
    try {
      const current = await dataProvider.getNextWacaSnapshot();
      if (current.revision !== snapshot.revision) throw new Error('WACA 資料已變更，請重新讀取。');
      await dataProvider.exportData();
      const candidate = repositoryFromSnapshot(current, variants);
      setWacaMapping(candidate, {
        feature: item.feature, myacgMainId: chosen.mainCode, myacgVariantId: chosen.childCode,
        productVariantId: chosen.variantId, method: 'MANUAL', confirmedAt: new Date().toISOString(),
        historicalProductTitle: item.productTitle, historicalVariantTitle: chosen.variantTitle,
        masterStatus: 'ACTIVE',
      });
      await dataProvider.commitNextWacaSnapshot(
        snapshotFromRepository(current, candidate, current.batches, masterState.links), current.revision, true,
      );
      await load();
      setMessage('商品對照已保存；所有受影響歷史訂單的 WACA 數量已重算。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [snapshot, choicesFor, selectedVariant, variants, masterState.links, load]);

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
    try {
      const current = await dataProvider.getNextWacaSnapshot();
      if (current.revision !== snapshot.revision) throw new Error('WACA 資料已變更，請重新讀取。');
      await dataProvider.exportData();
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
      await dataProvider.commitNextWacaSnapshot(
        snapshotFromRepository(current, candidate, batches, masterState.links), current.revision, true,
      );
      await load();
      setMessage(`${orderKey} 已按「${status}」重新計算。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  // Keep the expensive mapping table mounted after its first visit. Its element tree
  // only changes when source data, selection, or busy state changes—not on tab switches.
  const mappingsPanel = useMemo(() => <>
    <h2>WACA 商品對照</h2>
    <p>對照記錄會用於後續匯入；人工重配會回算已保存的歷史訂單。</p>
    <div className="waca-scroll"><table><thead><tr><th>WACA 商品／規格</th><th>ERP 對應商品／規格／SKU</th><th>狀態</th><th>人工確認</th></tr></thead><tbody>
      {mappingItems.map(item => {
        const mapping = repo?.mappings.get(item.feature);
        const choices = choicesFor(item);
        const evidence = mapping && evidenceByChildCode.get(mapping.myacgVariantId);
        const target = mapping ? variantById.get(mapping.productVariantId) : undefined;
        return <tr key={item.feature}><td>{displayNameForVariant(item.productVariantId, item.productTitle)}<small>{item.spec1} {item.spec2}</small>
            <details className="waca-tech"><summary>原始 WACA 資料</summary><small>{item.productTitle}／{item.productCode}</small></details></td>
          <td>{target ? <>{displayNameForVariant(target.id, target.product_title)}<small>{target.variant_name}／SKU {target.myacg_item_code}</small></> : statusText[item.diagnostic ?? ''] ?? '待對照'}</td>
          <td>{mapping ? `${mapping.method === 'AUTO' ? '已自動確認' : '人工確認'}${mapping.masterStatus === 'ACTIVE' ? '' : '／商品暫不可用'}` : '未確認'}
            {mapping && <details className="waca-tech"><summary>查看技術資訊</summary><small>GP {mapping.myacgMainId}／G {mapping.myacgVariantId}</small>
              {evidence && <small>來源：{evidence.sourceFile}</small>}</details>}</td>
          <td><small>{explanationFor(item)}</small><select aria-label={`對照 ${item.productCode} ${item.spec1}`} value={selectedVariant[item.feature] ?? ''} onChange={event => setSelectedVariant(previous => ({ ...previous, [item.feature]: event.target.value }))}>
            <option value="">選擇同 GP 規格</option>
            {choices.filter(choice => choice.variantId).map(choice => <option key={choice.variantId} value={choice.variantId}>{displayNameForVariant(choice.variantId, choice.productTitle)}／{choice.variantTitle}／{choice.childCode}</option>)}
          </select><button className="btn btn-outline" disabled={busy || !selectedVariant[item.feature]} onClick={() => void manualMap(item)}>保存</button></td>
        </tr>;
      })}
    </tbody></table></div>
  </>, [mappingItems, repo, choicesFor, evidenceByChildCode, variantById, displayNameForVariant,
    explanationFor, selectedVariant, busy, manualMap]);

  if (getProviderMode() !== 'next') return <PageShell><p>WACA 匯入目前只在 NEXT 4192 開放。</p></PageShell>;
  return <PageShell className="waca-page">
    <PageHeader className="waca-heading">
      <div><h1>WACA 匯入</h1><p>日常只需匯入一份 WACA 訂單 Excel。確認後會更新訂單、重算數量並自動對帳。</p></div>
      <button className="btn btn-md btn-outline" onClick={() => void load().catch(cause => setError(String(cause)))} disabled={busy}><RefreshCw size={16} /> 重新讀取</button>
    </PageHeader>
    {error && <div className="waca-notice waca-error" role="alert"><span className="badge badge-danger">需確認</span> {error}</div>}
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
            ['有效數量', pendingImport.result.effectiveQuantity], ['折扣忽略', pendingImport.result.discountIgnored],
            ['待處理', previewFeatures.filter(item => !item.productVariantId).length + pendingImport.result.statusConflicts.length],
            ['數量變動', changedPreviewVariants],
          ] as const).map(([label, value]) => <div key={label}><strong>{quantity(value)}</strong><span>{label}</span></div>)}
        </div>
        <p className="waca-equation">新增 {pendingImport.result.inserted}、更新 {pendingImport.result.updated}、未變更 {pendingImport.result.unchanged}；
          取消／失敗 {pendingImport.result.cancelledOrders + pendingImport.result.failedOrders} 張訂單不計入數量。</p>
        {pendingImport.result.errors.length > 0 && <p className="waca-danger">資料列錯誤：{pendingImport.result.errors.join('、')}</p>}
        <h3>商品數量變化</h3>
        <p>只顯示這次會改變數量的商品。點開商品群組可看各規格。</p>
        <label className="waca-show-unchanged"><input type="checkbox" checked={showUnchanged}
          onChange={event => setShowUnchanged(event.target.checked)} /> 顯示未變更商品</label>
        {!visiblePreviewGroups.length && <p className="waca-no-changes">這份檔案沒有商品數量變動。</p>}
        <div className="waca-group-list">{visiblePreviewGroups.map(group => <details className={`waca-group ${group.increases + group.decreases ? 'changed' : 'unchanged'}`} key={group.id}>
          <summary><strong>{group.title}</strong><span>新增 {group.increases}、減少 {group.decreases}、變動 {group.increases + group.decreases}
            {showUnchanged ? `、未變更 ${group.unchanged}` : ''}</span></summary>
          <div className="waca-scroll"><table><thead><tr><th>規格／SKU</th><th>原 WACA → 新 WACA</th><th>變化</th></tr></thead><tbody>
            {group.children.map(({ variant, before, after, delta }) => <tr key={variant.id}>
              <td><strong>{variant.variant_name || '標準規格'}</strong><small>SKU {variant.myacg_item_code}</small></td>
              <td className="waca-quantity-pair">{before} <span aria-hidden="true">→</span> {after}</td>
              <td className={delta > 0 ? 'waca-increase' : delta < 0 ? 'waca-decrease' : 'waca-unchanged'}>{delta > 0 ? `+${delta}` : delta}</td>
            </tr>)}
          </tbody></table></div>
        </details>)}</div>
        <details className="waca-tech"><summary>查看技術資訊與商品列明細</summary>
          <p>有效數量 {pendingImport.result.effectiveQuantity} = 已配對 {pendingImport.result.matchedEffectiveQuantity} + 待處理 {pendingImport.result.unmatchedPendingQuantity}</p>
          <div className="waca-scroll"><table><thead><tr><th>訂單</th><th>商品</th><th>規格</th><th>數量</th><th>結果</th></tr></thead><tbody>
            {pendingImport.items.map(item => <tr key={item.key}><td>{item.orderKey.replace('WACA::', '')}</td>
              <td>{displayNameForVariant(item.productVariantId, item.productTitle)}<small>原始 WACA：{item.productTitle}／{item.productCode}</small></td><td>{item.spec1} {item.spec2}</td><td>{item.quantity}</td>
              <td>{item.productVariantId ? '已配對' : statusText[item.diagnostic ?? ''] ?? '規格需要確認'}</td>
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
      <div className="waca-scroll"><table><thead><tr><th>匯入時間</th><th>檔案</th><th>訂單</th><th>商品列</th><th>新增</th><th>更新</th><th>未變更</th><th>取消／失敗</th><th>已配對</th><th>待處理</th><th>有效數量</th><th>數量對帳</th></tr></thead><tbody>
        {[...(snapshot?.batches ?? [])].reverse().map(batch => <tr key={batch.id}><td>{batch.importedAt}</td><td>{batch.fileName}</td>
          <td>{batch.result.ordersTotal}</td><td>{batch.result.productRows}</td><td>{batch.inserted}</td><td>{batch.updated}</td><td>{batch.unchanged}</td>
          <td>{batch.result.cancelledOrders + batch.result.failedOrders}</td><td>{batch.result.matched}</td>
          <td>{batch.result.unmatched + batch.result.multipleCandidates + batch.result.statusConflicts.length}</td>
          <td>{batch.result.effectiveQuantity}</td><td>{batch.reconciliation ? `${batch.reconciliation.status} ${batch.reconciliation.passed}/${batch.reconciliation.total}` : '未記錄'}</td></tr>)}
      </tbody></table></div>
    </section>}
    {tab === 'pending' && <section className="waca-panel"><h2>需要處理的項目</h2>
      {reconciliation?.issues.map((issue, index) => <div className="waca-pending-card" key={`reconcile-${issue.variantId}-${issue.sku}-${index}`}>
        <strong>{displayNameForVariant(issue.variantId, issue.productTitle)}／{issue.variantTitle}</strong>
        <p>SKU：{issue.sku}</p>{issue.reason === 'UNMATCHED_SOURCE'
          ? <p>此商品尚未對應訂購紀錄表；有效訂單 {issue.sourceQuantity} 件尚未計入 WACA 數量。請先確認商品對照。</p>
          : <><p>來源訂單數量 {issue.sourceQuantity}，系統 WACA 數量 {issue.storedQuantity}，差異 {issue.difference > 0 ? '+' : ''}{issue.difference}。</p>
            <p>訂購紀錄表顯示 {issue.displayedQuantity}。請重新讀取後確認；若仍不一致，先不要繼續匯入。</p></>}
        <details className="waca-tech"><summary>查看技術資訊</summary>{issue.reason}／{issue.variantId}</details>
      </div>)}
      {pendingItems.map(item => <div className="waca-pending-card" key={item.key}>
        <strong>{item.productTitle}／{item.spec1} {item.spec2}</strong>
        <p>WACA 商品：{item.productCode}</p>
        <p>訂單 {item.orderKey.replace('WACA::', '')}，數量 {item.quantity}</p>
        <p>{statusText[item.diagnostic ?? ''] ?? '待人工確認'}</p>
        {choicesFor(item).length ? <details className="waca-tech"><summary>查看可能規格與技術資訊</summary><ul>{choicesFor(item).map(choice => <li key={`${choice.childCode}::${choice.variantId}`}>
          {choice.mainCode || '直接 G'} → {choice.childCode}／買動漫規格 {choice.variantTitle || '未提供'}／
          ERP ProductVariant {choice.variantId || '不存在'}／證據 {choice.sourceFile || 'ERP G 編號'}
        </li>)}</ul></details> : <p>找不到可安全確認的規格，請在買動漫商品主檔檢查。</p>}
        <select aria-label={`處理 ${item.productCode} ${item.spec1}`} value={selectedVariant[item.feature] ?? ''} onChange={event => setSelectedVariant(previous => ({ ...previous, [item.feature]: event.target.value }))}>
          <option value="">選擇同 GP 規格</option>
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
