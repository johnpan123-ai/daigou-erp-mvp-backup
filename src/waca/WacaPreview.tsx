import { useState } from 'react';
import {
  createWacaRepository, importWacaRows, isEffectiveWacaStatus, matchWacaItem, normalizeWacaText, setWacaMapping, wacaFeature,
  type MasterVariant, type WacaImportResult, type WacaRepository, type WacaRow,
} from './orderCore';
import { parseWacaWorkbook } from './workbookParser';
import { buildWacaMasterReference, type ErpVariantReference } from './masterReference';

type View = 'upload' | 'result' | 'orders' | 'mapping' | 'unmatched' | 'conflicts' | 'history';
const views: Array<{ key: View; label: string }> = [
  { key: 'upload', label: '匯入預覽' }, { key: 'result', label: '結果摘要' },
  { key: 'orders', label: '訂單明細' }, { key: 'mapping', label: '商品對照' },
  { key: 'unmatched', label: '未配對' }, { key: 'conflicts', label: '狀態衝突' },
  { key: 'history', label: '匯入紀錄' },
];

export function WacaPreview() {
  const [repo, setRepo] = useState(createWacaRepository);
  const [view, setView] = useState<View>('upload');
  const [wacaFile, setWacaFile] = useState<File | null>(null);
  const [myacgFile, setMyacgFile] = useState<File | null>(null);
  const [snapshotFile, setSnapshotFile] = useState<File | null>(null);
  const [master, setMaster] = useState<MasterVariant[]>([]);
  const [rows, setRows] = useState<WacaRow[]>([]);
  const [result, setResult] = useState<WacaImportResult | null>(null);
  const [error, setError] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [manualSearch, setManualSearch] = useState('');
  const orders = [...repo.orders.values()];
  const items = [...repo.items.values()];
  const unmatched = items.filter(item => item.match === 'UNMATCHED' || item.match === 'MANUAL_REVIEW');

  const analyze = async () => {
    if (!wacaFile) return;
    setError('');
    try {
      const parsed = parseWacaWorkbook(await wacaFile.arrayBuffer());
      let reference: MasterVariant[] = [];
      if (myacgFile && snapshotFile) {
        const snapshot = JSON.parse(await snapshotFile.text()) as { data?: { productVariants?: ErpVariantReference[] } };
        if (!Array.isArray(snapshot.data?.productVariants)) throw new Error('ERP_SNAPSHOT_VARIANTS_MISSING');
        reference = buildWacaMasterReference(await myacgFile.arrayBuffer(), snapshot.data.productVariants);
      }
      setMaster(reference);
      setRows(parsed.rows);
      const draft: WacaRepository = {
        orders: new Map(repo.orders), items: new Map(repo.items), mappings: new Map(repo.mappings),
        manualAdjustments: new Map(repo.manualAdjustments), autoQuantities: new Map(repo.autoQuantities),
        importHistory: [...repo.importHistory],
      };
      const next = importWacaRows(parsed.rows, draft, reference, `local-${draft.importHistory.length + 1}`);
      setResult(next);
      setRepo(draft);
      setView('result');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法讀取檔案');
    }
  };

  const remap = (feature: string, variantId: string) => {
    const candidate = master.find(item => item.variantId === variantId);
    if (!candidate) return;
    const item = items.find(value => value.feature === feature);
    if (!item) return;
    const draft: WacaRepository = {
      orders: new Map(repo.orders), items: new Map([...repo.items].map(([key, value]) => [key, { ...value }])),
      mappings: new Map(repo.mappings), manualAdjustments: new Map(repo.manualAdjustments),
      autoQuantities: new Map(repo.autoQuantities), importHistory: [...repo.importHistory],
    };
    setWacaMapping(draft, {
      feature, myacgMainId: candidate.mainCode, myacgVariantId: candidate.childCode,
      productVariantId: candidate.variantId, method: 'MANUAL', confirmedAt: `local-confirmation-${draft.importHistory.length}`,
      historicalProductTitle: item.productTitle, historicalVariantTitle: candidate.variantTitle,
      masterStatus: 'ACTIVE',
    });
    setRepo(draft);
    setResult(previous => {
      if (!previous) return previous;
      const currentItems = [...draft.items.values()];
      const effectiveItems = currentItems.filter(value => {
        const order = draft.orders.get(value.orderKey);
        return order && isEffectiveWacaStatus(order.status);
      });
      return {
        ...previous,
        matched: currentItems.filter(value => value.productVariantId).length,
        unmatched: currentItems.filter(value => value.match === 'UNMATCHED').length,
        multipleCandidates: currentItems.filter(value => value.match === 'MANUAL_REVIEW').length,
        matchedEffectiveQuantity: effectiveItems.filter(value => value.productVariantId).reduce((sum, value) => sum + value.quantity, 0),
        unmatchedPendingQuantity: effectiveItems.filter(value => !value.productVariantId).reduce((sum, value) => sum + value.quantity, 0),
      };
    });
  };

  return <main className="waca-workspace">
    <header className="waca-header">
      <div><span className="waca-eyebrow">小河馬訂購紀錄表 2.0 · 獨立研發預覽</span><h1>WACA 訂單整合</h1><p>只在此瀏覽器記憶體內分析。這個頁面沒有連接 ERP、Supabase 或 Cloudflare 寫入端點。</p></div>
      <span className="waca-safety">ISOLATED · 0 LIVE WRITE</span>
    </header>
    <nav className="waca-tabs" aria-label="WACA 預覽功能">{views.map(item =>
      <button type="button" key={item.key} aria-current={view === item.key ? 'page' : undefined} onClick={() => setView(item.key)}>{item.label}</button>
    )}</nav>
    {error && <p className="waca-error" role="alert">{error}</p>}

    {view === 'upload' && <section className="waca-card">
      <h2>選擇本機檔案</h2><p>WACA 訂單為必選；買動漫主檔與 ERP 快照一同選擇後，才會執行有 UUID 的安全配對。缺少主檔時一律保留未配對。</p>
      <div className="waca-upload-grid">
        <label>WACA 訂單 Excel<input type="file" accept=".xlsx,.xls" onChange={event => setWacaFile(event.target.files?.[0] ?? null)} /></label>
        <label>買動漫商品匯出<input type="file" accept=".xls,.xlsx" onChange={event => setMyacgFile(event.target.files?.[0] ?? null)} /></label>
        <label>ERP 2.0 JSON 快照<input type="file" accept=".json" onChange={event => setSnapshotFile(event.target.files?.[0] ?? null)} /></label>
      </div>
      <button type="button" className="waca-primary" disabled={!wacaFile} onClick={() => { void analyze(); }}>在記憶體中預覽匯入</button>
    </section>}

    {view === 'result' && <section className="waca-card">
      <h2>匯入結果摘要</h2>{!result ? <p>尚未匯入。先至「匯入預覽」選擇檔案。</p> : <>
        <div className="waca-stats">{[
          ['訂單', result.ordersTotal], ['有效訂單', result.effectiveOrders], ['取消', result.cancelledOrders],
          ['失敗', result.failedOrders], ['商品列', result.productRows], ['折扣忽略', result.discountIgnored],
          ['配對', result.matched], ['未配對', result.unmatched], ['多候選', result.multipleCandidates],
          ['狀態衝突', result.statusConflicts.length],
        ].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
        <p className="waca-reconcile">有效數量 {result.effectiveQuantity} = 已配對 {result.matchedEffectiveQuantity} + 待處理 {result.unmatchedPendingQuantity}</p>
        <p>新增 {result.inserted} · 更新 {result.updated} · 不變 {result.unchanged}。相同檔案重新分析不會累加 WACA 數量。</p>
      </>}
    </section>}

    {view === 'orders' && <section className="waca-card"><h2>WACA 訂單明細</h2>
      <div className="waca-two-column"><div className="waca-list">{orders.map(order =>
        <button type="button" key={order.key} className={selectedOrder === order.key ? 'selected' : ''} onClick={() => setSelectedOrder(order.key)}>
          <strong>{order.orderNumber}</strong><span>{order.status}</span><small>{order.purchasedAt}</small>
        </button>
      )}</div><div className="waca-detail">{selectedOrder ? items.filter(item => item.orderKey === selectedOrder).map(item =>
        <article key={item.key}><strong>{item.productTitle}</strong><span>{item.spec1} {item.spec2}</span><small>數量 {item.quantity} · {item.match}</small></article>
      ) : <p>選擇一張訂單查看品項。</p>}</div></div>
    </section>}

    {view === 'mapping' && <section className="waca-card"><h2>永久商品對照（隔離記憶體）</h2>
      <div className="waca-table-scroll"><table><thead><tr><th>WACA 商品</th><th>買動漫主編號</th><th>子編號</th><th>ERP Variant</th><th>方式</th><th>主檔狀態</th></tr></thead><tbody>
        {[...repo.mappings.values()].map(mapping => <tr key={mapping.feature}><td>{JSON.parse(mapping.feature)[1]}</td><td>{mapping.myacgMainId}</td><td>{mapping.myacgVariantId}</td><td>{mapping.productVariantId}</td><td>{mapping.method}</td><td>{mapping.masterStatus}</td></tr>)}
      </tbody></table></div>
    </section>}

    {view === 'unmatched' && <section className="waca-card"><h2>待人工確認</h2><p>0 或多個候選都不會自動取第一筆；選擇僅影響此隔離預覽的彙總。</p>
      <label className="waca-manual-search">人工搜尋主檔（只供人工選擇）<input value={manualSearch} onChange={event => setManualSearch(event.target.value)} placeholder="主編號、子編號或商品名稱" /></label>
      <div className="waca-review-list">{unmatched.map(item => {
        const source = rows.find(row => wacaFeature(row) === item.feature);
        const match = source ? matchWacaItem(source, master) : null;
        const term = normalizeWacaText(manualSearch);
        const manualCandidates = term.length >= 2 ? master.filter(candidate =>
          [candidate.mainCode, candidate.childCode, candidate.productTitle, candidate.variantTitle]
            .some(value => normalizeWacaText(value).includes(term)),
        ).slice(0, 20) : [];
        const choices = [...new Map([...(match?.candidates ?? []), ...manualCandidates].map(candidate => [candidate.variantId, candidate])).values()];
        return <article key={item.key}><div><strong>{item.productTitle}</strong><p>{item.productCode} · {item.spec1} {item.spec2}</p><small>{item.diagnostic || item.match} · 候選 {match?.candidates.length ?? 0}</small></div>
          <select aria-label={`選擇 ${item.productTitle} 的商品對照`} value="" onChange={event => remap(item.feature, event.target.value)}><option value="">人工選擇候選</option>{choices.map(candidate => <option key={candidate.variantId} value={candidate.variantId}>{candidate.mainCode} / {candidate.childCode} · {candidate.variantTitle}</option>)}</select>
        </article>;
      })}</div>
    </section>}

    {view === 'conflicts' && <section className="waca-card"><h2>訂單狀態衝突</h2>{result?.statusConflicts.length ? result.statusConflicts.map(key => <p key={key}>{key}：同檔案狀態不一致，未更新此訂單。</p>) : <p>目前沒有狀態衝突。</p>}</section>}
    {view === 'history' && <section className="waca-card"><h2>本次瀏覽器匯入紀錄</h2>{repo.importHistory.map(record => <p key={record.id}>{record.id} · {record.rows} 列 · 新增 {record.inserted} / 更新 {record.updated} / 不變 {record.unchanged}</p>)}</section>}
  </main>;
}
