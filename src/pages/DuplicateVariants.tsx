import { useState, useEffect, useMemo } from 'react';
import { dataProvider } from '../providers/dataProvider';
import type {
  ProductVariant, ProductGroup, ProductCategory,
  PurchaseBatch, PurchaseBatchItem, PrivateOrderItem, SalesOrderItem
} from '../lib/db';
import { RefreshCw, ChevronDown, ChevronRight, AlertTriangle, Trash2, CheckCircle2, Layers } from 'lucide-react';
import { useRole } from '../auth/useRole';

// 與 src/lib/db.ts computeVariantDedupe() 相同的去重 key：
// 同 key 的列會被讀取端自動合併（UI 看不到），因此「疑似重複」的定義是
// key 不同、但（同群組＋同 SKU）或（同群組＋完整規格文字相同）的列。
const dedupeKeyOf = (v: ProductVariant): string => {
  if (v.source === 'manual') return `unique::${v.id}`;
  const sku = (v.myacg_item_code || '').trim().toUpperCase();
  const groupId = (v.product_group_id || '').trim();
  if (!sku || !groupId) return `unique::${v.id}`;
  const spec = (v.raw_variant_name || v.variant_name || '').trim();
  const title = (v.product_title || '').trim();
  return `${groupId}::${sku}::${spec}::${title}`;
};

const norm = (t: string | undefined | null): string =>
  (t || '').trim().toLowerCase().replace(/\s+/g, ' ');

interface RowInfo {
  v: ProductVariant;
  createdAt: string | null;
  categoryTitle: string | null;
  batchItemCount: number;
  purchasedQty: number;
  batchNames: string[];
  privateCount: number;
  privateQty: number;
  salesByVid: number;
  salesBySku: number;
  salesQtyBySku: number;
  manual: { myacg: number; waca: number; priv: number; purchased: number };
  auto: { myacg: number; effMyacg: number; waca: number };
  hasAssoc: boolean;
  weight: number;
}

interface DupSet {
  key: string;
  groupId: string;
  groupTitle: string;
  rows: RowInfo[];
  suggestedKeepId: string;
  matchReason: string;
}

export default function DuplicateVariants() {
  const { canEdit } = useRole();
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [batches, setBatches] = useState<PurchaseBatch[]>([]);
  const [batchItems, setBatchItems] = useState<PurchaseBatchItem[]>([]);
  const [privateItems, setPrivateItems] = useState<PrivateOrderItem[]>([]);
  const [salesItems, setSalesItems] = useState<SalesOrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [keepChoice, setKeepChoice] = useState<Record<string, string>>({});
  const [deletingSetKey, setDeletingSetKey] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [vars, gs, cats, bs, bis, pois, sois] = await Promise.all([
        dataProvider.getProductVariants(),
        dataProvider.getProductGroups(),
        dataProvider.getProductCategories(),
        dataProvider.getPurchaseBatches(),
        dataProvider.getPurchaseBatchItems(),
        dataProvider.getPrivateOrderItems(),
        dataProvider.getSalesOrderItems()
      ]);
      setVariants(vars);
      setGroups(gs);
      setCategories(cats);
      setBatches(bs);
      setBatchItems(bis);
      setPrivateItems(pois);
      setSalesItems(sois);
    } catch (err) {
      console.error('[DuplicateVariants] load failed:', err);
      alert('載入資料失敗：' + ((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const dupSets = useMemo<DupSet[]>(() => {
    const gById = new Map(groups.map(g => [g.id, g]));
    const cById = new Map(categories.map(c => [c.id, c]));
    const batchById = new Map(batches.map(b => [b.id, b]));

    const bucket = <T,>(items: T[], keyFn: (t: T) => string | undefined | null): Map<string, T[]> => {
      const m = new Map<string, T[]>();
      for (const it of items) {
        const k = keyFn(it);
        if (!k) continue;
        const arr = m.get(k);
        if (arr) arr.push(it); else m.set(k, [it]);
      }
      return m;
    };
    const biByVid = bucket(batchItems, x => x.product_variant_id);
    const poiByVid = bucket(privateItems, x => x.product_variant_id);
    const soiByVid = bucket(salesItems, x => x.product_variant_id);
    const soiBySku = bucket(salesItems, x => (x.myacg_item_code || '').trim().toUpperCase());

    const effGroup = (v: ProductVariant): string | null =>
      v.product_group_id ||
      (v.product_category_id ? cById.get(v.product_category_id)?.product_group_id : null) ||
      null;
    const fullSpec = (v: ProductVariant): string => {
      const raw = norm(v.raw_variant_name);
      if (raw) return raw;
      const cat = v.product_category_id ? cById.get(v.product_category_id)?.title : '';
      return norm(`${cat || ''} ${v.variant_name || ''}`);
    };

    // 候選集合：(a) 同群組＋同 SKU、(b) 同群組＋完整規格文字相同
    const setsMap = new Map<string, Map<string, ProductVariant>>();
    const add = (k: string, v: ProductVariant) => {
      let m = setsMap.get(k);
      if (!m) { m = new Map(); setsMap.set(k, m); }
      m.set(v.id, v);
    };
    for (const v of variants) {
      const g = effGroup(v);
      if (!g) continue;
      const sku = (v.myacg_item_code || '').trim().toUpperCase();
      if (sku) add(`sku::${g}::${sku}`, v);
      const fs = fullSpec(v);
      if (fs) add(`spec::${g}::${fs}`, v);
    }
    const rawSets: { reason: string; rows: ProductVariant[] }[] = [];
    for (const [k, m] of setsMap.entries()) {
      const arr = [...m.values()];
      if (arr.length < 2) continue;
      if (new Set(arr.map(dedupeKeyOf)).size < 2) continue; // 讀取端已合併，UI 只會顯示一筆
      rawSets.push({ reason: k.startsWith('sku::') ? '同 SKU' : '同規格名', rows: arr });
    }

    // 合併有交集的候選集合（同一批實體重複可能同時命中兩種 key）
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; }
      return x;
    };
    for (const s of rawSets) for (const v of s.rows) if (!parent.has(v.id)) parent.set(v.id, v.id);
    for (const s of rawSets) {
      for (let i = 1; i < s.rows.length; i++) {
        const a = find(s.rows[0].id), b = find(s.rows[i].id);
        if (a !== b) parent.set(b, a);
      }
    }
    const reasonById = new Map<string, Set<string>>();
    for (const s of rawSets) for (const v of s.rows) {
      if (!reasonById.has(v.id)) reasonById.set(v.id, new Set());
      reasonById.get(v.id)!.add(s.reason);
    }
    const vById = new Map(variants.map(v => [v.id, v]));
    const mergedSets = new Map<string, ProductVariant[]>();
    for (const id of parent.keys()) {
      const root = find(id);
      const arr = mergedSets.get(root);
      const v = vById.get(id)!;
      if (arr) arr.push(v); else mergedSets.set(root, [v]);
    }

    const toRowInfo = (v: ProductVariant): RowInfo => {
      const bis = biByVid.get(v.id) || [];
      const pois = poiByVid.get(v.id) || [];
      const soisVid = soiByVid.get(v.id) || [];
      const soisSku = soiBySku.get((v.myacg_item_code || '').trim().toUpperCase()) || [];
      const manual = {
        myacg: v.myacg_manual_adjustment ?? 0,
        waca: v.waca_manual_adjustment ?? 0,
        priv: v.private_manual_adjustment ?? 0,
        purchased: v.purchased_manual_adjustment ?? 0
      };
      const auto = {
        myacg: v.myacg_auto_quantity ?? 0,
        effMyacg: v.effective_myacg_quantity ?? 0,
        waca: v.waca_auto_quantity ?? 0
      };
      const purchasedQty = bis.reduce((s, b) => s + (b.quantity || 0), 0);
      const hasAssoc =
        bis.length > 0 || pois.length > 0 || soisVid.length > 0 ||
        manual.myacg !== 0 || manual.waca !== 0 || manual.priv !== 0 || manual.purchased !== 0 ||
        auto.myacg > 0 || auto.effMyacg > 0 || auto.waca > 0;
      const weight =
        bis.length * 100 + purchasedQty * 10 + pois.length * 100 +
        soisVid.length * 50 + soisSku.length * 20 +
        Math.abs(manual.myacg) + Math.abs(manual.waca) + Math.abs(manual.priv) + Math.abs(manual.purchased) +
        auto.myacg + auto.effMyacg + auto.waca;
      return {
        v,
        createdAt: (v as { created_at?: string }).created_at || null,
        categoryTitle: v.product_category_id ? (cById.get(v.product_category_id)?.title ?? '(分類不存在)') : null,
        batchItemCount: bis.length,
        purchasedQty,
        batchNames: [...new Set(bis.map(bi => batchById.get(bi.purchase_batch_id)?.name || bi.purchase_batch_id))].slice(0, 5),
        privateCount: pois.length,
        privateQty: pois.reduce((s, p) => s + (p.quantity || 0), 0),
        salesByVid: soisVid.length,
        salesBySku: soisSku.length,
        salesQtyBySku: soisSku.reduce((s, x) => s + (x.quantity || 0), 0),
        manual, auto, hasAssoc, weight
      };
    };

    const result: DupSet[] = [];
    for (const arr of mergedSets.values()) {
      if (arr.length < 2) continue;
      const rows = arr.map(toRowInfo).sort((x, y) =>
        (y.weight - x.weight) ||
        ((Date.parse(y.v.updated_at || '') || 0) - (Date.parse(x.v.updated_at || '') || 0)));
      const gid = effGroup(arr[0]) || '';
      const g = gById.get(gid);
      const reasons = new Set<string>();
      for (const r of rows) for (const re of (reasonById.get(r.v.id) || [])) reasons.add(re);
      result.push({
        key: rows.map(r => r.v.id).sort().join('|'),
        groupId: gid,
        groupTitle: g?.normalized_title || g?.title || '(未知群組)',
        rows,
        suggestedKeepId: rows[0].v.id,
        matchReason: [...reasons].join('＋')
      });
    }
    result.sort((a, b) =>
      a.groupTitle.localeCompare(b.groupTitle, 'ja') ||
      norm(a.rows[0].v.raw_variant_name || a.rows[0].v.variant_name).localeCompare(norm(b.rows[0].v.raw_variant_name || b.rows[0].v.variant_name), 'ja'));
    return result;
  }, [variants, groups, categories, batches, batchItems, privateItems, salesItems]);

  const totalRows = dupSets.reduce((s, x) => s + x.rows.length, 0);

  const toggleExpand = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleDelete = async (set: DupSet) => {
    if (!canEdit()) {
      alert('目前的帳號權限不可刪除品項。');
      return;
    }
    const keepId = keepChoice[set.key] ?? set.suggestedKeepId;
    const keepRow = set.rows.find(r => r.v.id === keepId);
    const targets = set.rows.filter(r => r.v.id !== keepId);
    if (!keepRow || targets.length === 0) return;

    const blocked = targets.filter(t => t.hasAssoc);
    if (blocked.length > 0) {
      alert(
        '無法刪除：以下品項仍有關聯資料（採購批次／私下登記／訂單／手動調整），' +
        '請先在原頁面轉移或清空後再回來刪除：\n\n' +
        blocked.map(t => `・${t.v.variant_name || t.v.raw_variant_name}（SKU: ${t.v.myacg_item_code || '無'}）`).join('\n')
      );
      return;
    }

    const msg =
      `【${set.groupTitle}】\n\n` +
      `✅ 保留：${keepRow.v.raw_variant_name || keepRow.v.variant_name}\n` +
      `　　SKU: ${keepRow.v.myacg_item_code || '無'}｜ID: ${keepRow.v.id}\n\n` +
      `🗑 將 soft delete 以下 ${targets.length} 筆（可於 Supabase 還原 deleted_at）：\n` +
      targets.map(t =>
        `・${t.v.raw_variant_name || t.v.variant_name || '(無規格名)'}\n` +
        `　SKU: ${t.v.myacg_item_code || '無'}｜ID: ${t.v.id}`
      ).join('\n') +
      '\n\n確定執行？（此組僅刪除以上列出的品項，不影響其他組）';
    if (!window.confirm(msg)) return;

    setDeletingSetKey(set.key);
    try {
      for (const t of targets) {
        await dataProvider.deleteProductVariant(t.v.id);
      }
      await loadData();
    } catch (err) {
      console.error('[DuplicateVariants] delete failed:', err);
      alert('刪除失敗：' + ((err as Error).message || err));
      await loadData();
    } finally {
      setDeletingSetKey(null);
    }
  };

  const fmtTime = (t: string | null | undefined) => {
    if (!t) return '-';
    const d = new Date(t);
    if (isNaN(d.getTime())) return t;
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const assocSummary = (r: RowInfo): string => {
    const parts: string[] = [];
    if (r.batchItemCount > 0) parts.push(`採購批次×${r.batchItemCount}（已購${r.purchasedQty}）`);
    if (r.privateCount > 0) parts.push(`私下登記×${r.privateCount}（${r.privateQty}個）`);
    if (r.salesByVid > 0) parts.push(`訂單(依ID)×${r.salesByVid}`);
    if (r.salesBySku > 0) parts.push(`訂單(依SKU)×${r.salesBySku}（${r.salesQtyBySku}個）`);
    const m = r.manual;
    if (m.myacg || m.waca || m.priv || m.purchased) parts.push(`手動調整 m${m.myacg}/w${m.waca}/p${m.priv}/pu${m.purchased}`);
    const a = r.auto;
    if (a.myacg || a.effMyacg || a.waca) parts.push(`自動需求 myacg${a.effMyacg || a.myacg}/waca${a.waca}`);
    return parts.length > 0 ? parts.join('｜') : '無任何關聯';
  };

  return (
    <div style={{ padding: '16px', maxWidth: '1100px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
        <Layers size={22} style={{ color: '#0f766e' }} />
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a', margin: 0 }}>重複品項管理</h1>
        <button
          className="btn"
          onClick={loadData}
          disabled={loading}
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '6px 12px' }}
        >
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          重新整理
        </button>
      </div>
      <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '12px' }}>
        判定條件：同一商品群組內「SKU 相同」或「完整規格文字相同」、但未被系統自動合併的品項。
        每組須手動選擇保留哪一筆並逐組確認後，才會對其餘品項做 soft delete（設 deleted_at，可還原）。無批次刪除。
      </div>

      <div style={{
        display: 'flex', gap: '16px', padding: '10px 14px', marginBottom: '16px',
        backgroundColor: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: '8px',
        fontSize: '13px', color: '#134e4a', flexWrap: 'wrap'
      }}>
        <span>疑似重複：<b>{dupSets.length}</b> 組</span>
        <span>涉及品項：<b>{totalRows}</b> 筆</span>
        <span>刪除候選全部零關聯的組數：<b>{dupSets.filter(s => s.rows.slice(1).every(r => !r.hasAssoc)).length}</b></span>
      </div>

      {loading && <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>載入中…</div>}

      {!loading && dupSets.length === 0 && (
        <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
          <CheckCircle2 size={36} style={{ color: '#16a34a', marginBottom: '8px' }} />
          <div>沒有偵測到重複品項 🎉</div>
        </div>
      )}

      {!loading && dupSets.map((set, idx) => {
        const isOpen = expanded.has(set.key);
        const keepId = keepChoice[set.key] ?? set.suggestedKeepId;
        const targets = set.rows.filter(r => r.v.id !== keepId);
        const anyBlocked = targets.some(t => t.hasAssoc);
        const specLabel = set.rows[0].v.raw_variant_name || `${set.rows[0].categoryTitle || ''} ${set.rows[0].v.variant_name}`.trim();
        return (
          <div key={set.key} style={{
            border: '1px solid #e2e8f0', borderRadius: '8px', marginBottom: '10px',
            backgroundColor: '#ffffff', overflow: 'hidden'
          }}>
            <div
              onClick={() => toggleExpand(set.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px',
                cursor: 'pointer', backgroundColor: isOpen ? '#f8fafc' : '#ffffff'
              }}
            >
              {isOpen ? <ChevronDown size={16} style={{ flexShrink: 0, color: '#64748b' }} /> : <ChevronRight size={16} style={{ flexShrink: 0, color: '#64748b' }} />}
              <span style={{ fontSize: '12px', color: '#94a3b8', flexShrink: 0 }}>#{idx + 1}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {set.groupTitle}
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {specLabel}｜{set.rows.length} 筆｜{set.matchReason}
                </div>
              </div>
              {anyBlocked ? (
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#b45309', backgroundColor: '#fef3c7', padding: '2px 8px', borderRadius: '10px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <AlertTriangle size={12} /> 需先轉移關聯
                </span>
              ) : (
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#15803d', backgroundColor: '#dcfce7', padding: '2px 8px', borderRadius: '10px', flexShrink: 0 }}>
                  可安全刪除
                </span>
              )}
            </div>

            {isOpen && (
              <div style={{ borderTop: '1px solid #e2e8f0', padding: '12px 14px' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                    <thead>
                      <tr style={{ color: '#64748b', textAlign: 'left' }}>
                        <th style={{ padding: '6px 8px' }}>保留</th>
                        <th style={{ padding: '6px 8px' }}>SKU</th>
                        <th style={{ padding: '6px 8px' }}>分類</th>
                        <th style={{ padding: '6px 8px' }}>規格名</th>
                        <th style={{ padding: '6px 8px' }}>raw_variant_name</th>
                        <th style={{ padding: '6px 8px' }}>source</th>
                        <th style={{ padding: '6px 8px' }}>建立</th>
                        <th style={{ padding: '6px 8px' }}>更新</th>
                        <th style={{ padding: '6px 8px' }}>關聯資料</th>
                      </tr>
                    </thead>
                    <tbody>
                      {set.rows.map(r => {
                        const isKeep = r.v.id === keepId;
                        return (
                          <tr key={r.v.id} style={{
                            borderTop: '1px solid #f1f5f9',
                            backgroundColor: isKeep ? '#f0fdf4' : undefined
                          }}>
                            <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                <input
                                  type="radio"
                                  name={`keep_${set.key}`}
                                  checked={isKeep}
                                  onChange={() => setKeepChoice(prev => ({ ...prev, [set.key]: r.v.id }))}
                                />
                                {r.v.id === set.suggestedKeepId && (
                                  <span style={{ fontSize: '10px', fontWeight: 600, color: '#0369a1', backgroundColor: '#e0f2fe', padding: '1px 6px', borderRadius: '8px' }}>建議</span>
                                )}
                              </label>
                            </td>
                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{r.v.myacg_item_code || '(空)'}</td>
                            <td style={{ padding: '6px 8px' }}>{r.categoryTitle || '-'}</td>
                            <td style={{ padding: '6px 8px' }}>{r.v.variant_name || '-'}</td>
                            <td style={{ padding: '6px 8px', color: r.v.raw_variant_name ? undefined : '#dc2626' }}>
                              {r.v.raw_variant_name || '（空白）'}
                            </td>
                            <td style={{ padding: '6px 8px' }}>{r.v.source || 'catalog'}</td>
                            <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmtTime(r.createdAt)}</td>
                            <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmtTime(r.v.updated_at)}</td>
                            <td style={{ padding: '6px 8px', color: r.hasAssoc ? '#0f766e' : '#94a3b8' }}>
                              {assocSummary(r)}
                              {r.batchNames.length > 0 && (
                                <div style={{ fontSize: '11px', color: '#64748b' }}>批次：{r.batchNames.join('、')}</div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: '12px', color: '#64748b', wordBreak: 'break-all' }}>
                    保留 ID：<span style={{ fontFamily: 'monospace' }}>{keepId}</span>
                  </div>
                  <button
                    onClick={() => handleDelete(set)}
                    disabled={deletingSetKey !== null || anyBlocked || !canEdit()}
                    style={{
                      marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px',
                      padding: '7px 14px', fontSize: '13px', fontWeight: 600,
                      color: '#ffffff', backgroundColor: (anyBlocked || !canEdit()) ? '#cbd5e1' : '#dc2626',
                      border: 'none', borderRadius: '6px',
                      cursor: (deletingSetKey !== null || anyBlocked || !canEdit()) ? 'not-allowed' : 'pointer'
                    }}
                  >
                    <Trash2 size={14} />
                    {deletingSetKey === set.key
                      ? '刪除中…'
                      : anyBlocked
                        ? '未保留筆有關聯，不可刪除'
                        : `Soft Delete 未保留的 ${targets.length} 筆`}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
