import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileSpreadsheet, Link2, RefreshCw } from 'lucide-react';
import { PageHeader, PageShell } from '../components/layout/PageHeader';
import { dataProvider } from '../providers/dataProvider';
import { getProviderMode } from '../providers/providerMode';
import { parseMyAcgFile } from '../utils/myacgParser';
import type { InventoryItem, ProductVariant } from '../lib/db';
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
};
type PendingLinks = { fileName: string; revision: number; result: LinkImportResult; links: MyAcgMasterLink[] };

const statusText: Record<string, string> = {
  MASTER_EVIDENCE_MISSING: '缺少買動漫 GP → G 原始證據',
  MASTER_MAPPING_MISSING: '舊版診斷；請補入買動漫 GP → G 證據並重匯',
  MASTER_GROUP_LINK_MISSING: '已有 GP → G，ERP 商品群組連結待補',
  VARIANT_NOT_MATCHED: '已找到 GP，但規格與候選 G 不符',
  MULTIPLE_VARIANT_CANDIDATES: '同一 GP 下有多個候選，待人工確認',
  VARIANT_NOT_IN_ERP: '買動漫已有 G，但 ERP 不存在此子品項',
  PRODUCT_NOT_IN_MASTER: '完整買動漫主檔無此商品',
  NAME_CONFLICT: '品名與買動漫商品不一致',
};

const quantity = (value: number) => value.toLocaleString('zh-TW');
const isPending = (item: WacaItem) => !item.productVariantId;

export default function WacaIntegration() {
  const [tab, setTab] = useState<Tab>('import');
  const [snapshot, setSnapshot] = useState<NextWacaSnapshot | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [pendingLinks, setPendingLinks] = useState<PendingLinks | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<Record<string, string>>({});
  const [selectedStatus, setSelectedStatus] = useState<Record<string, WacaStatus>>({});
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [nextSnapshot, nextVariants, nextInventory] = await Promise.all([
      dataProvider.getNextWacaSnapshot(),
      dataProvider.getProductVariants({ raw: true }),
      dataProvider.getInventory(),
    ]);
    setSnapshot(nextSnapshot);
    setVariants(nextVariants);
    setInventory(nextInventory);
  }, []);

  useEffect(() => {
    if (getProviderMode() !== 'next') return;
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
  const pendingItems = useMemo(() => items.filter(isPending), [items]);
  const variantById = useMemo(() => new Map(variants.map(row => [row.id, row])), [variants]);
  const mappingItems = useMemo(() => {
    const seen = new Set<string>();
    return items.filter(item => {
      if (seen.has(item.feature)) return false;
      seen.add(item.feature);
      return true;
    });
  }, [items]);
  const latestBatch = snapshot?.batches.at(-1);
  const matchedFeatures = mappingItems.filter(item => item.productVariantId).length;
  const manualFeatures = mappingItems.filter(item => item.match === 'MANUAL_MATCH').length;
  const multipleFeatures = mappingItems.filter(item => item.diagnostic === 'MULTIPLE_VARIANT_CANDIDATES').length;
  const previewFeatures = pendingImport ? [...new Map(pendingImport.items.map(item => [item.feature, item])).values()] : [];

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
    setBusy(true); setError(''); setMessage(''); setPendingImport(null);
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
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
      setPendingImport(null);
      await load();
      setMessage(`匯入完成：新增 ${result.inserted}、更新 ${result.updated}、未變更 ${result.unchanged}。請檢查待處理與訂購紀錄表。`);
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

  const choicesFor = (item: WacaItem) => {
    const code = normalizeWacaText(item.productCode);
    const scoped = masterState.master.filter(row => row.active && (
      normalizeWacaText(row.mainCode) === code || normalizeWacaText(row.childCode) === code
    ));
    return scoped;
  };

  const explanationFor = (item: WacaItem) => {
    const match = matchWacaItem({
      orderStatus: '', orderNumber: '', purchasedAt: '', productCode: item.productCode,
      productTitle: item.productTitle, spec1: item.spec1, spec2: item.spec2,
      specCode: item.specCode, quantity: item.quantity, subtotal: item.subtotal,
    }, masterState.master);
    return match.diagnostic ? statusText[match.diagnostic] : '已找到安全候選';
  };

  const manualMap = async (item: WacaItem) => {
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
  };

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

  if (getProviderMode() !== 'next') return <PageShell><p>WACA 匯入目前只在 NEXT 4192 開放。</p></PageShell>;
  return <PageShell className="waca-page">
    <PageHeader className="waca-heading">
      <div><h1>WACA 訂單整合</h1><p>上傳訂單快照、核對買動漫商品規格，確認後才更新本機 WACA 數量。</p></div>
      <button className="btn btn-secondary" onClick={() => void load().catch(cause => setError(String(cause)))} disabled={busy}><RefreshCw size={16} /> 重新讀取</button>
    </PageHeader>
    {error && <div className="waca-notice waca-error" role="alert">{error}</div>}
    {message && <div className="waca-notice" role="status">{message}</div>}
    {masterState.error && <div className="waca-notice waca-error">{masterState.error}</div>}
    <nav className="waca-tabs" aria-label="WACA 功能">
      {([
        ['import', 'WACA 匯入'], ['orders', '來源訂單'], ['mappings', '商品對照'],
        ['history', '匯入紀錄'], ['pending', `待處理 ${pendingItems.length + conflicts.length}`],
      ] as const).map(([key, label]) =>
        <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
    </nav>
    <div className="waca-metrics" aria-label="WACA 目前驗收摘要">
      {([
        ['商品特徵', mappingItems.length], ['已配對特徵', matchedFeatures],
        ['人工確認特徵', manualFeatures], ['待處理特徵', mappingItems.length - matchedFeatures],
        ['多候選特徵', multipleFeatures], ['最近一批折扣忽略', latestBatch?.result.discountIgnored ?? 0],
      ] as const).map(([label, value]) => <div key={label}><strong>{quantity(value)}</strong><span>{label}</span></div>)}
    </div>
    {tab === 'import' && <section className="waca-panel">
      <h2><FileSpreadsheet size={19} /> 上傳 WACA 訂單 Excel</h2>
      <p>先預覽解析、商品配對和數量變化；按「確認匯入」前不寫入資料。</p>
      <input type="file" accept=".xlsx,.xls" aria-label="選擇 WACA Excel" disabled={busy || !snapshot}
        onChange={event => { void handleWacaFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
      {pendingImport && <>
        <h3>匯入預覽：{pendingImport.fileName}</h3>
        <div className="waca-metrics">
          {([
            ['商品特徵', previewFeatures.length],
            ['可自動配對特徵', previewFeatures.filter(item => item.match === 'AUTO_MATCH').length],
            ['待人工確認特徵', previewFeatures.filter(item => item.match === 'MANUAL_REVIEW').length],
            ['未配對特徵', previewFeatures.filter(item => item.match === 'UNMATCHED').length],
            ['訂單', pendingImport.result.ordersTotal], ['有效訂單', pendingImport.result.effectiveOrders],
            ['取消', pendingImport.result.cancelledOrders], ['失敗', pendingImport.result.failedOrders],
            ['商品列', pendingImport.result.productRows], ['有效商品數量', pendingImport.result.effectiveQuantity],
            ['折扣忽略', pendingImport.result.discountIgnored], ['新增', pendingImport.result.inserted],
            ['更新', pendingImport.result.updated], ['未變更', pendingImport.result.unchanged],
            ['已配對', pendingImport.result.matched], ['未配對', pendingImport.result.unmatched],
            ['多候選', pendingImport.result.multipleCandidates], ['主檔證據缺失', pendingImport.result.mappingMissing],
            ['狀態衝突', pendingImport.result.statusConflicts.length],
          ] as const).map(([label, value]) => <div key={label}><strong>{quantity(value)}</strong><span>{label}</span></div>)}
        </div>
        <p className="waca-equation">有效商品數量 {quantity(pendingImport.result.effectiveQuantity)} =
          已配對 {quantity(pendingImport.result.matchedEffectiveQuantity)} +
          待處理 {quantity(pendingImport.result.unmatchedPendingQuantity)}
        </p>
        {pendingImport.result.errors.length > 0 && <p className="waca-danger">資料列錯誤：{pendingImport.result.errors.join('、')}</p>}
        <h3>各規格 WACA 數量變化</h3>
        <div className="waca-scroll"><table><thead><tr><th>買動漫子編號</th><th>品項</th><th>前</th><th>後</th></tr></thead><tbody>
          {pendingImport.result.quantityChanges.map(row => <tr key={row.variantId}>
            <td>{variantById.get(row.variantId)?.myacg_item_code ?? row.variantId}</td>
            <td>{variantById.get(row.variantId)?.variant_name ?? ''}</td><td>{row.before}</td><td>{row.after}</td>
          </tr>)}
        </tbody></table></div>
        <h3>商品列配對結果</h3>
        <div className="waca-scroll"><table><thead><tr><th>訂單</th><th>WACA 編號</th><th>商品／規格</th><th>數量</th><th>結果</th></tr></thead><tbody>
          {pendingImport.items.map(item => <tr key={item.key}><td>{item.orderKey.replace('WACA::', '')}</td>
            <td>{item.productCode}</td><td>{item.productTitle}<small>{item.spec1} {item.spec2}</small></td>
            <td>{item.quantity}</td><td>{item.productVariantId ? variantById.get(item.productVariantId)?.myacg_item_code : statusText[item.diagnostic ?? ''] ?? '待人工確認'}</td>
          </tr>)}
        </tbody></table></div>
        <button className="btn btn-primary" disabled={busy || pendingImport.result.errors.length > 0}
          onClick={() => void confirmImport()}>確認匯入</button>
      </>}
      <div className="waca-master-import">
        <h2><Link2 size={19} /> 補入買動漫 GP → G 原始證據</h2>
        <p>保存 GP → G 原始證據，即使 ERP 尚無 G 或商品已下架也保留；不會新增 ERP 商品。歷史檔可逐份補入。</p>
        <input type="file" accept=".xls,.xlsx" aria-label="選擇買動漫商品匯出檔" disabled={busy || !snapshot}
          onChange={event => { void handleMasterFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        {pendingLinks && <div className="waca-notice">
          {pendingLinks.fileName}：可保存 {pendingLinks.result.accepted} 筆（含 ERP 尚無 G 的證據），
          其中 ERP 無對應子編號 {pendingLinks.result.missingVariant} 筆，
          子編號不唯一 {pendingLinks.result.ambiguousVariant} 筆。
          <button className="btn btn-primary" disabled={busy} onClick={() => void confirmMasterLinks()}>確認保存對照</button>
        </div>}
        <p>目前已有 {masterState.links.length} 筆經買動漫原始資料驗證的主子對照。</p>
      </div>
    </section>}
    {tab === 'orders' && <section className="waca-panel"><h2>WACA 來源訂單</h2>
      <div className="waca-scroll"><table><thead><tr><th>訂單編號</th><th>購買日期</th><th>狀態</th><th>品項</th><th>有效已配對數量</th></tr></thead><tbody>
        {orders.map(order => {
          const orderItems = items.filter(item => item.orderKey === order.key);
          const counted = ['處理中', '完成付款'].includes(order.status)
            ? orderItems.filter(item => item.productVariantId).reduce((sum, item) => sum + item.quantity, 0) : 0;
          return <tr key={order.key} className="waca-click-row" onClick={() => setExpandedOrder(expandedOrder === order.key ? null : order.key)}>
            <td>{order.orderNumber}{expandedOrder === order.key && <div className="waca-order-lines">
              {orderItems.map(item => <p key={item.key}>{item.productCode} {item.productTitle} / {item.spec1} {item.spec2} × {item.quantity} {item.productVariantId ? variantById.get(item.productVariantId)?.myacg_item_code : statusText[item.diagnostic ?? '']}</p>)}
            </div>}</td><td>{order.purchasedAt}</td><td>{order.status}</td><td>{orderItems.length}</td><td>{counted}</td>
          </tr>;
        })}
      </tbody></table></div>
    </section>}
    {tab === 'mappings' && <section className="waca-panel"><h2>WACA 商品對照</h2>
      <p>對照記錄會用於後續匯入；人工重配會回算已保存的歷史訂單。</p>
      <div className="waca-scroll"><table><thead><tr><th>WACA 商品</th><th>買動漫 GP / G</th><th>方式／主檔狀態</th><th>人工調整</th></tr></thead><tbody>
        {mappingItems.map(item => {
          const mapping = repo?.mappings.get(item.feature);
          const choices = choicesFor(item);
          const evidence = mapping && masterState.links.find(link => link.childCode === mapping.myacgVariantId);
          return <tr key={item.feature}><td>{item.productCode}<small>{item.productTitle}／{item.spec1} {item.spec2}</small></td>
            <td>{mapping ? `${mapping.myacgMainId} / ${mapping.myacgVariantId}` : statusText[item.diagnostic ?? ''] ?? '待對照'}</td>
            <td>{mapping ? `${mapping.method === 'AUTO' ? '自動' : '人工'}／${mapping.masterStatus === 'ACTIVE' ? 'ERP 規格可用' : 'ERP 規格暫缺'}` : '未確認'}
              {evidence && <small>GP → G 證據：{evidence.sourceFile}</small>}</td>
            <td><small>{explanationFor(item)}</small><select aria-label={`對照 ${item.productCode} ${item.spec1}`} value={selectedVariant[item.feature] ?? ''} onChange={event => setSelectedVariant(previous => ({ ...previous, [item.feature]: event.target.value }))}>
              <option value="">選擇同 GP 規格</option>
              {choices.filter(choice => choice.variantId).map(choice => <option key={choice.variantId} value={choice.variantId}>{choice.childCode}／{choice.variantTitle}／ERP {choice.variantId}</option>)}
            </select><button className="btn btn-secondary" disabled={busy || !selectedVariant[item.feature]} onClick={() => void manualMap(item)}>保存</button></td>
          </tr>;
        })}
      </tbody></table></div>
    </section>}
    {tab === 'history' && <section className="waca-panel"><h2>WACA 匯入紀錄</h2>
      <div className="waca-scroll"><table><thead><tr><th>匯入時間</th><th>檔案</th><th>商品列</th><th>新增</th><th>更新</th><th>未變更</th><th>狀態衝突</th></tr></thead><tbody>
        {[...(snapshot?.batches ?? [])].reverse().map(batch => <tr key={batch.id}><td>{batch.importedAt}</td><td>{batch.fileName}</td>
          <td>{batch.rows}</td><td>{batch.inserted}</td><td>{batch.updated}</td><td>{batch.unchanged}</td><td>{batch.conflictRows?.length ?? 0}</td></tr>)}
      </tbody></table></div>
    </section>}
    {tab === 'pending' && <section className="waca-panel"><h2>未配對與狀態衝突</h2>
      {pendingItems.map(item => <div className="waca-pending-card" key={item.key}>
        <strong>{item.productCode}／{item.spec1} {item.spec2}</strong>
        <p>WACA 品名：{item.productTitle}</p>
        <p>訂單 {item.orderKey.replace('WACA::', '')}，數量 {item.quantity}</p>
        <p>{statusText[item.diagnostic ?? ''] ?? '待人工確認'}</p>
        <p>候選範圍與原因：{explanationFor(item)}</p>
        {choicesFor(item).length ? <ul>{choicesFor(item).map(choice => <li key={`${choice.childCode}::${choice.variantId}`}>
          {choice.mainCode || '直接 G'} → {choice.childCode}／買動漫規格 {choice.variantTitle || '未提供'}／
          ERP ProductVariant {choice.variantId || '不存在'}／證據 {choice.sourceFile || 'ERP G 編號'}
        </li>)}</ul> : <p>沒有同 GP 的買動漫候選 G；需補入正式主檔證據。</p>}
        <select aria-label={`處理 ${item.productCode} ${item.spec1}`} value={selectedVariant[item.feature] ?? ''} onChange={event => setSelectedVariant(previous => ({ ...previous, [item.feature]: event.target.value }))}>
          <option value="">選擇同 GP 規格</option>
          {choicesFor(item).filter(choice => choice.variantId).map(choice => <option key={choice.variantId} value={choice.variantId}>{choice.childCode}／{choice.variantTitle}／ERP {choice.variantId}</option>)}
        </select>
        <button className="btn btn-secondary" disabled={busy || !selectedVariant[item.feature]} onClick={() => void manualMap(item)}>確認對照</button>
      </div>)}
      {!pendingItems.length && !conflicts.length && <p>目前沒有未配對商品或訂單狀態衝突。</p>}
      {conflicts.map(({ batch, orderKey, rows }) => <div className="waca-pending-card" key={`${batch.id}::${orderKey}`}>
        <strong>狀態衝突：{orderKey.replace('WACA::', '')}</strong>
        <p>{batch.fileName}；同一匯入檔出現 {new Set(rows.map(row => row.orderStatus)).size} 種訂單狀態，尚未計入。</p>
        <select aria-label={`確認訂單狀態 ${orderKey}`} value={selectedStatus[orderKey] ?? ''} onChange={event => setSelectedStatus(previous => ({ ...previous, [orderKey]: event.target.value as WacaStatus }))}>
          <option value="">選擇正確狀態</option>
          {(['處理中', '完成付款', '取消', '失敗'] as const).map(status => <option key={status} value={status}>{status}</option>)}
        </select>
        <button className="btn btn-secondary" disabled={busy || !selectedStatus[orderKey]}
          onClick={() => void resolveConflict(batch, orderKey, rows)}>確認狀態並重算</button>
      </div>)}
    </section>}
  </PageShell>;
}
