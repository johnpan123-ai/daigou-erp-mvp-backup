import { useState } from 'react';
import type { PurchaseBatch, PurchaseBatchItem, ProductVariant, ProductCategory, ProductGroup } from '../lib/db';
import { dataProvider, StaleDataError } from '../providers/dataProvider';
import { ChevronRight, ChevronDown, Trash2, Edit2, Copy } from 'lucide-react';
import { useViewport } from '../contexts/ViewportContext';

interface PurchaseBatchTabProps {
  batches: PurchaseBatch[];
  batchItems: PurchaseBatchItem[];
  variants: ProductVariant[];
  categoryMap: Map<string, ProductCategory>;
  groups?: ProductGroup[];
  onRefresh: () => void;
  onEditBatch: (batch: PurchaseBatch) => void;
  getDisplayProductName: (v: ProductVariant) => string;
  canWrite?: boolean;
  isDaili?: boolean;
}

export default function PurchaseBatchTab({ batches, batchItems, variants, groups = [], onRefresh, onEditBatch, getDisplayProductName, canWrite, isDaili = false }: PurchaseBatchTabProps) {
  const { isMobile } = useViewport();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'>('date_desc');
  const currencySymbol = isDaili ? 'NT$ ' : '¥ ';

  const toggleExpand = (id: string) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };

  const handleDeleteBatch = async (batch: PurchaseBatch) => {
    if (!window.confirm(`確定刪除此採購批次？底下明細也會一起刪除。`)) return;
    
    try {
      const allBatches = await dataProvider.getPurchaseBatches();
      const allItems = await dataProvider.getPurchaseBatchItems();
      
      await dataProvider.savePurchaseBatches(allBatches.filter(b => b.id !== batch.id));
      await dataProvider.savePurchaseBatchItems(allItems.filter(i => i.purchase_batch_id !== batch.id));
      
      onRefresh();
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        onRefresh();
        return;
      }
      throw err;
    }
  };

  const handleCopyBatchLedger = async (batch: PurchaseBatch) => {
    const items = batchItems.filter(i => i.purchase_batch_id === batch.id);
    if (items.length === 0) {
      alert('此批次無任何採購商品！');
      return;
    }

    const ledgerMap = new Map<string, { name: string; quantity: number; cost: number }>();
    const groupMap = new Map((groups || []).map(g => [g.id, g]));
    
    for (const item of items) {
      const variant = variantMap.get(item.product_variant_id);
      if (!variant) continue;

      const g = variant.product_group_id ? groupMap.get(variant.product_group_id) : null;
      const groupTitle = g?.normalized_title
        || g?.title
        || variant.product_title
        || '未命名商品';
      const varName = variant.variant_name || '';
      const displayName = varName ? `${groupTitle}-${varName}` : groupTitle;

      const costVal = item.cost ?? 0;
      const key = `${displayName}_${costVal}`;
      const existing = ledgerMap.get(key);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        ledgerMap.set(key, {
          name: displayName,
          quantity: item.quantity,
          cost: costVal
        });
      }
    }

    const tsvRows = Array.from(ledgerMap.values()).map(row => {
      return `${row.name}\t${row.quantity}\t\t${row.cost}`;
    });

    const tsvString = tsvRows.join('\n');

    try {
      await navigator.clipboard.writeText(tsvString);
      alert('已複製本批次帳目（TSV 格式）至剪貼簿！');
    } catch (err) {
      console.error('Failed to copy ledger:', err);
      alert('複製失敗，瀏覽器可能不支援或無剪貼簿寫入權限。');
    }
  };

  const variantMap = new Map(variants.map(v => [v.id, v]));

  const sortedBatches = [...batches].sort((a, b) => {
    const itemsA = batchItems.filter(i => i.purchase_batch_id === a.id);
    const itemsB = batchItems.filter(i => i.purchase_batch_id === b.id);
    const costA = itemsA.reduce((sum, i) => sum + (i.quantity * i.cost), 0);
    const costB = itemsB.reduce((sum, i) => sum + (i.quantity * i.cost), 0);

    if (sortBy === 'date_desc') {
      return b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at);
    } else if (sortBy === 'date_asc') {
      return a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at);
    } else if (sortBy === 'amount_desc') {
      return costB - costA;
    } else if (sortBy === 'amount_asc') {
      return costA - costB;
    }
    return 0;
  });

  if (batches.length === 0) {
    return <div style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>目前沒有採購批次紀錄。</div>;
  }

  return (
    <div style={{ padding: '16px', backgroundColor: '#f8fafc', flex: 1, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>排序方式:</span>
          <select 
            className="input" 
            style={{ width: '200px', height: '32px', fontSize: '13px', padding: '0 8px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
            value={sortBy}
            onChange={e => setSortBy(e.target.value as any)}
          >
            <option value="date_desc">採購日期（新 → 舊）</option>
            <option value="date_asc">採購日期（舊 → 新）</option>
            <option value="amount_desc">總金額（高 → 低）</option>
            <option value="amount_asc">總金額（低 → 高）</option>
          </select>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {sortedBatches.map(batch => {
          const items = batchItems.filter(i => i.purchase_batch_id === batch.id);
          const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
          const totalCost = items.reduce((sum, i) => sum + (i.quantity * i.cost), 0);
          const isExpanded = expandedIds.has(batch.id);

          return (
            <div key={batch.id} style={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' }}>
              {/* Batch Header */}
              {isMobile ? (
                <div 
                  style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', cursor: 'pointer', backgroundColor: isExpanded ? '#f1f5f9' : '#fff' }}
                  onClick={() => toggleExpand(batch.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {isExpanded ? <ChevronDown size={18} className="text-muted"/> : <ChevronRight size={18} className="text-muted"/>}
                      <div style={{ fontWeight: 600, color: '#0f172a', fontSize: '15px' }}>{batch.name}</div>
                    </div>
                    <div style={{ fontSize: '13px', color: '#64748b', backgroundColor: '#e2e8f0', padding: '2px 8px', borderRadius: '12px' }}>{batch.date}</div>
                  </div>
                  {batch.note && <div style={{ fontSize: '13px', color: '#64748b', fontStyle: 'italic', paddingLeft: '26px' }}>({batch.note})</div>}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: '26px', fontSize: '14px', borderTop: '1px dashed #e2e8f0', paddingTop: '8px' }}>
                    <div style={{ display: 'flex', gap: '12px' }}>
                      <div><span style={{ color: '#94a3b8' }}>款:</span> <span style={{ fontWeight: 500 }}>{items.length}</span></div>
                      <div><span style={{ color: '#94a3b8' }}>件:</span> <span style={{ fontWeight: 600, color: '#2563eb' }}>{totalQty}</span></div>
                      <div><span style={{ color: '#94a3b8' }}>金:</span> <span style={{ fontWeight: 600, color: '#059669' }}>{currencySymbol}{totalCost.toLocaleString()}</span></div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }} onClick={e => e.stopPropagation()}>
                      {canWrite && (
                        <button className="btn btn-ghost" style={{ padding: '4px', color: '#2563eb' }} onClick={() => handleCopyBatchLedger(batch)} title="複製本批次帳目">
                          <Copy size={16} />
                        </button>
                      )}
                      <button className="btn btn-ghost" style={{ padding: '4px', color: '#64748b' }} onClick={() => onEditBatch(batch)} title="編輯批次與明細">
                        <Edit2 size={16} />
                      </button>
                      <button className="btn btn-ghost" style={{ padding: '4px', color: '#ef4444' }} onClick={() => handleDeleteBatch(batch)} title="刪除批次">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div 
                  style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', backgroundColor: isExpanded ? '#f1f5f9' : '#fff' }}
                  onClick={() => toggleExpand(batch.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    {isExpanded ? <ChevronDown size={18} className="text-muted"/> : <ChevronRight size={18} className="text-muted"/>}
                    <div style={{ fontWeight: 600, color: '#0f172a', fontSize: '15px' }}>{batch.name}</div>
                    <div style={{ fontSize: '13px', color: '#64748b', backgroundColor: '#e2e8f0', padding: '2px 8px', borderRadius: '12px' }}>{batch.date}</div>
                    {batch.note && <div style={{ fontSize: '13px', color: '#64748b', fontStyle: 'italic' }}>({batch.note})</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '24px', fontSize: '14px' }}>
                    <div><span style={{ color: '#94a3b8' }}>款數:</span> <span style={{ fontWeight: 500 }}>{items.length} 款</span></div>
                    <div><span style={{ color: '#94a3b8' }}>總件數:</span> <span style={{ fontWeight: 600, color: '#2563eb' }}>{totalQty} 件</span></div>
                    <div style={{ width: '150px', textAlign: 'right' }}><span style={{ color: '#94a3b8' }}>總金額:</span> <span style={{ fontWeight: 600, color: '#059669' }}>{currencySymbol}{totalCost.toLocaleString()}</span></div>
                    
                    <div style={{ display: 'flex', gap: '8px' }} onClick={e => e.stopPropagation()}>
                      {canWrite && (
                        <button className="btn btn-ghost" style={{ padding: '4px', color: '#2563eb' }} onClick={() => handleCopyBatchLedger(batch)} title="複製本批次帳目">
                          <Copy size={16} />
                        </button>
                      )}
                      <button className="btn btn-ghost" style={{ padding: '4px', color: '#64748b' }} onClick={() => onEditBatch(batch)} title="編輯批次與明細">
                        <Edit2 size={16} />
                      </button>
                      <button className="btn btn-ghost" style={{ padding: '4px', color: '#ef4444' }} onClick={() => handleDeleteBatch(batch)} title="刪除批次">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Items List */}
              {isExpanded && (
                <div style={{ padding: '16px', borderTop: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
                  {isMobile ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {items.sort((a, b) => {
                        const idxA = variants.findIndex(v => v.id === a.product_variant_id);
                        const idxB = variants.findIndex(v => v.id === b.product_variant_id);
                        return idxA - idxB;
                      }).map(item => {
                        const variant = variantMap.get(item.product_variant_id);
                        return (
                          <div key={item.id} style={{ 
                            padding: '12px', 
                            border: '1px solid #e2e8f0', 
                            borderRadius: '8px', 
                            backgroundColor: '#f8fafc',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                            boxShadow: '0 1px 2px rgba(0,0,0,0.02)'
                          }}>
                            {/* 第一行：商品名稱 */}
                            <div style={{ 
                              fontWeight: 600, 
                              color: '#1e293b', 
                              fontSize: '13px', 
                              lineHeight: '1.4', 
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis'
                            }}>
                              {variant ? getDisplayProductName(variant) : '未知商品'}
                            </div>
                            
                            {/* 第二行：數量、成本/金額、小計 */}
                            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#475569' }}>
                              <span style={{ backgroundColor: '#e2e8f0', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                數量: <strong style={{ color: '#0f172a' }}>{item.quantity}</strong>
                              </span>
                              <span style={{ backgroundColor: '#e0f2fe', color: '#0369a1', padding: '2px 6px', borderRadius: '4px' }}>
                                成本: <strong>{currencySymbol}{item.cost.toLocaleString()}</strong>
                              </span>
                              <span style={{ backgroundColor: '#dcfce7', color: '#15803d', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>
                                小計: <strong>{currencySymbol}{(item.quantity * item.cost).toLocaleString()}</strong>
                              </span>
                            </div>
                            
                            {/* 第三行：備註 */}
                            {item.note && (
                              <div style={{ fontSize: '12px', color: '#64748b', backgroundColor: '#fff', padding: '6px 8px', borderRadius: '4px', borderLeft: '3px solid #cbd5e1', wordBreak: 'break-word' }}>
                                <strong>備註：</strong>{item.note}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {items.length === 0 && (
                        <div style={{ padding: '16px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>無明細</div>
                      )}
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: '40%' }} />
                        <col style={{ width: '10%' }} />
                        <col style={{ width: '12%' }} />
                        <col style={{ width: '12%' }} />
                        <col style={{ width: '16%' }} />
                        <col style={{ width: '10%' }} />
                      </colgroup>
                      <thead>
                        <tr style={{ color: '#64748b', borderBottom: '1px solid #e2e8f0' }}>
                          <th style={{ padding: '8px', textAlign: 'left' }}>商品名稱</th>
                          <th style={{ padding: '8px', textAlign: 'center' }}>數量</th>
                          <th style={{ padding: '8px', textAlign: 'right' }}>成本</th>
                          <th style={{ padding: '8px', textAlign: 'right' }}>小計</th>
                          <th style={{ padding: '8px', textAlign: 'left' }}>備註</th>
                          <th style={{ padding: '8px', textAlign: 'center' }}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.sort((a, b) => {
                          const idxA = variants.findIndex(v => v.id === a.product_variant_id);
                          const idxB = variants.findIndex(v => v.id === b.product_variant_id);
                          return idxA - idxB;
                        }).map(item => {
                          const variant = variantMap.get(item.product_variant_id);
                          return (
                            <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '8px', color: '#0f172a', wordBreak: 'break-word' }}>{variant ? getDisplayProductName(variant) : '未知商品'}</td>
                              <td style={{ padding: '8px', textAlign: 'center', fontWeight: 500 }}>{item.quantity}</td>
                              <td style={{ padding: '8px', textAlign: 'right', color: '#64748b' }}>{currencySymbol}{item.cost.toLocaleString()}</td>
                              <td style={{ padding: '8px', textAlign: 'right', fontWeight: 500 }}>{currencySymbol}{(item.quantity * item.cost).toLocaleString()}</td>
                              <td style={{ padding: '8px', color: '#64748b', wordBreak: 'break-word' }}>{item.note}</td>
                              <td style={{ padding: '8px', textAlign: 'center' }}>
                                {/* inline item edit removed, use whole document edit from batch header */}
                              </td>
                            </tr>
                          );
                        })}
                        {items.length === 0 && (
                          <tr><td colSpan={6} style={{ padding: '16px', textAlign: 'center', color: '#94a3b8' }}>無明細</td></tr>
                        )}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
