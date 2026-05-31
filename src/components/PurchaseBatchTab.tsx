import { useState } from 'react';
import type { PurchaseBatch, PurchaseBatchItem, ProductVariant, ProductCategory } from '../lib/db';
import { db } from '../lib/db';
import { ChevronRight, ChevronDown, Trash2, Edit2 } from 'lucide-react';

interface PurchaseBatchTabProps {
  batches: PurchaseBatch[];
  batchItems: PurchaseBatchItem[];
  variants: ProductVariant[];
  categoryMap: Map<string, ProductCategory>;
  onRefresh: () => void;
  onEditBatch: (batch: PurchaseBatch) => void;
}

export default function PurchaseBatchTab({ batches, batchItems, variants, categoryMap, onRefresh, onEditBatch }: PurchaseBatchTabProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };

  const handleDeleteBatch = async (batch: PurchaseBatch) => {
    if (!window.confirm(`確定刪除此採購批次？底下明細也會一起刪除。`)) return;
    
    const allBatches = await db.getPurchaseBatches();
    const allItems = await db.getPurchaseBatchItems();
    
    await db.savePurchaseBatches(allBatches.filter(b => b.id !== batch.id));
    await db.savePurchaseBatchItems(allItems.filter(i => i.purchase_batch_id !== batch.id));
    
    onRefresh();
  };

  const variantMap = new Map(variants.map(v => [v.id, v]));

  const formatVariantOption = (v: ProductVariant) => {
    let catTitle = '';
    if (v.product_category_id) {
      const cat = categoryMap.get(v.product_category_id);
      if (cat) catTitle = cat.title;
    }
    
    if (!catTitle || catTitle === '單品') {
      return v.variant_name;
    } else {
      return `${catTitle} - ${v.variant_name}`;
    }
  };

  if (batches.length === 0) {
    return <div style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>目前沒有採購批次紀錄。</div>;
  }

  return (
    <div style={{ padding: '16px', backgroundColor: '#f8fafc', flex: 1, overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {batches.map(batch => {
          const items = batchItems.filter(i => i.purchase_batch_id === batch.id);
          const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
          const totalCost = items.reduce((sum, i) => sum + (i.quantity * i.cost), 0);
          const isExpanded = expandedIds.has(batch.id);

          return (
            <div key={batch.id} style={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' }}>
              {/* Batch Header */}
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
                  <div><span style={{ color: '#94a3b8' }}>款數:</span> <span style={{ fontWeight: 500 }}>{items.length}</span></div>
                  <div><span style={{ color: '#94a3b8' }}>總數:</span> <span style={{ fontWeight: 600, color: '#2563eb' }}>{totalQty}</span></div>
                  <div style={{ width: '100px', textAlign: 'right' }}><span style={{ color: '#94a3b8' }}>總金額:</span> <span style={{ fontWeight: 600, color: '#059669' }}>¥ {totalCost.toLocaleString()}</span></div>
                  
                  <div style={{ display: 'flex', gap: '8px' }} onClick={e => e.stopPropagation()}>
                    <button className="btn btn-ghost" style={{ padding: '4px', color: '#64748b' }} onClick={() => onEditBatch(batch)} title="編輯批次與明細">
                      <Edit2 size={16} />
                    </button>
                    <button className="btn btn-ghost" style={{ padding: '4px', color: '#ef4444' }} onClick={() => handleDeleteBatch(batch)} title="刪除批次">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Items List */}
              {isExpanded && (
                <div style={{ padding: '16px', borderTop: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ color: '#64748b', borderBottom: '1px solid #e2e8f0' }}>
                        <th style={{ padding: '8px', textAlign: 'left' }}>商品名稱</th>
                        <th style={{ padding: '8px', textAlign: 'right', width: '80px' }}>數量</th>
                        <th style={{ padding: '8px', textAlign: 'right', width: '100px' }}>成本</th>
                        <th style={{ padding: '8px', textAlign: 'right', width: '120px' }}>小計</th>
                        <th style={{ padding: '8px', textAlign: 'left', width: '150px' }}>備註</th>
                        <th style={{ padding: '8px', textAlign: 'center', width: '80px' }}>操作</th>
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
                            <td style={{ padding: '8px', color: '#0f172a' }}>{variant ? formatVariantOption(variant) : '未知商品'}</td>
                            <td style={{ padding: '8px', textAlign: 'right', fontWeight: 500 }}>{item.quantity}</td>
                            <td style={{ padding: '8px', textAlign: 'right', color: '#64748b' }}>¥ {item.cost.toLocaleString()}</td>
                            <td style={{ padding: '8px', textAlign: 'right', fontWeight: 500 }}>¥ {(item.quantity * item.cost).toLocaleString()}</td>
                            <td style={{ padding: '8px', color: '#64748b' }}>{item.note}</td>
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
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
