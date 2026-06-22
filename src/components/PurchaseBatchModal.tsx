import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { dataProvider, StaleDataError } from '../providers/dataProvider';
import { calculateVariantDemandAndPurchased } from '../lib/db';
import type { ProductGroup, ProductVariant, PurchaseBatch, PurchaseBatchItem, InventoryItem, PrivateOrderItem } from '../lib/db';

interface PurchaseBatchModalProps {
  show: boolean;
  onClose: () => void;
  group: ProductGroup;
  variants: ProductVariant[];
  inventory: InventoryItem[];
  salesOrderItems: any[];
  privateOrderItems: PrivateOrderItem[];
  purchaseBatchItems: PurchaseBatchItem[];
  purchaseBatches: PurchaseBatch[];
  editingBatchId: string | null;
  onSaveSuccess: () => void;
  onStale?: () => void;
}

const cleanDailiTitle = (title: string): string => {
  if (!title) return '';
  let res = title;
  const keywords = [
    '【小河馬日本代購】',
    '【小河馬代購】',
    '小河馬日本代購',
    '小河馬代購',
    '預購',
    '現貨',
    '日本代購',
    '現地代購',
    '代理版',
    '代理',
    '日版',
    '再版',
    '預約'
  ];
  keywords.forEach(kw => {
    res = res.replaceAll(kw, '');
  });
  res = res.replace(/\d{2,4}年\d{1,2}月/g, '');
  res = res.replace(/\s+/g, ' ').trim();
  return res;
};

export default function PurchaseBatchModal({
  show,
  onClose,
  group,
  variants,
  inventory,
  salesOrderItems,
  privateOrderItems,
  purchaseBatchItems,
  purchaseBatches,
  editingBatchId,
  onSaveSuccess,
  onStale
}: PurchaseBatchModalProps) {
  const [onlyShowShortage, setOnlyShowShortage] = useState<boolean>(false);
  const [batchForm, setBatchForm] = useState({ name: '', date: '', note: '' });
  const [batchLines, setBatchLines] = useState<{ variant_id: string; quantity: number; cost: number | string; note: string }[]>([]);
  const initializedRef = useRef<string | null>(null);

  const isDaili = group?.listing_type === '代理版';

  const variantDefaultJpyCosts = useMemo(() => {
    try {
      const stored = localStorage.getItem('variant_default_jpy_costs');
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  }, []);

  const variantDefaultTwdCosts = useMemo(() => {
    try {
      const stored = localStorage.getItem('variant_default_twd_costs');
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  }, []);

  const getVariantDefaultJpyCost = (v: ProductVariant): number | undefined | null => {
    return (v.default_jpy_cost !== undefined && v.default_jpy_cost !== null) 
      ? v.default_jpy_cost 
      : variantDefaultJpyCosts[v.id];
  };

  const getVariantDefaultTwdCost = (v: ProductVariant): number | undefined | null => {
    return (v.default_twd_cost !== undefined && v.default_twd_cost !== null) 
      ? v.default_twd_cost 
      : variantDefaultTwdCosts[v.id];
  };

  const batchMap = useMemo(() => new Map(purchaseBatches.map(b => [b.id, b])), [purchaseBatches]);

  const getLatestBatchCost = (variantId: string): number | null => {
    const items = purchaseBatchItems.filter(item => item.product_variant_id === variantId && item.cost > 0);
    if (items.length === 0) return null;
    
    items.sort((a, b) => {
      const batchA = batchMap.get(a.purchase_batch_id);
      const batchB = batchMap.get(b.purchase_batch_id);
      if (!batchA || !batchB) return 0;
      const dateCompare = (batchA.date || '').localeCompare(batchB.date || '');
      if (dateCompare !== 0) return dateCompare;
      return (batchA.created_at || '').localeCompare(batchB.created_at || '');
    });
    return items[items.length - 1].cost;
  };

  const getVariantDemands = (v: ProductVariant) => {
    const res = calculateVariantDemandAndPurchased(
      v,
      privateOrderItems,
      purchaseBatchItems,
      inventory,
      salesOrderItems
    );
    return {
      myacgDemand: res.myacg,
      wacaDemand: res.waca,
      privateDemand: res.privateOrder,
      totalDemand: res.myacg + res.waca + res.privateOrder,
      purchased: res.purchased,
      gap: res.gap
    };
  };

  const getVariantShortageForModal = (v: ProductVariant) => {
    const { totalDemand } = getVariantDemands(v);
    const purchased = purchaseBatchItems
      .filter(pbi => pbi.product_variant_id === v.id && pbi.purchase_batch_id !== editingBatchId)
      .reduce((sum, item) => sum + item.quantity, 0);

    return totalDemand - purchased;
  };

  const getDisplayProductName = (v: ProductVariant): string => {
    const variantName = (v.variant_name || '').trim();
    const productTitle = group?.normalized_title || group?.title || '';
    
    if (isDaili) {
      if (variantName && variantName !== '單品' && variantName !== '一箱') {
        return variantName;
      }
      const targetTitle = v.product_title || productTitle;
      const cleaned = cleanDailiTitle(targetTitle);
      if (cleaned) {
        return cleaned;
      }
      return targetTitle;
    } else {
      return variantName || v.myacg_item_code || '';
    }
  };

  useEffect(() => {
    console.log(`[Modal Init useEffect] show=${show}, editingBatchId=${editingBatchId}, initializedRef=${initializedRef.current}`);
    if (!show) {
      initializedRef.current = null;
      return;
    }

    const initKey = `${group?.id || ''}_${editingBatchId || 'new'}`;
    if (initializedRef.current === initKey) {
      console.log(`[Modal Init useEffect] Skipping initialization, key matched: ${initKey}`);
      return;
    }
    console.log(`[Modal Init useEffect] Running initialization, key: ${initKey}`);
    initializedRef.current = initKey;

    setOnlyShowShortage(false);
    if (editingBatchId) {
      const batch = purchaseBatches.find(b => b.id === editingBatchId);
      if (batch) {
        setBatchForm({ name: batch.name, date: batch.date, note: batch.note || '' });
        setBatchLines(variants.map(v => {
          const existing = purchaseBatchItems.find(i => i.product_variant_id === v.id && i.purchase_batch_id === batch.id);
          return {
            variant_id: v.id,
            quantity: existing ? existing.quantity : 0,
            cost: existing ? existing.cost : 0,
            note: existing?.note || ''
          };
        }));
      }
    } else {
      setBatchForm({ name: '', date: new Date().toISOString().slice(0, 10), note: '' });
      setBatchLines(variants.map(v => {
        const defCost = isDaili ? getVariantDefaultTwdCost(v) : getVariantDefaultJpyCost(v);
        const latCost = getLatestBatchCost(v.id);
        const initialCost = (defCost !== undefined && defCost !== null) ? defCost : (latCost || 0);
        return { variant_id: v.id, quantity: 0, cost: initialCost, note: '' };
      }));
    }
  }, [show, editingBatchId, group, variants, purchaseBatches, purchaseBatchItems, isDaili]);

  const updateBatchLine = (index: number, field: string, value: any) => {
    const newLines = [...batchLines];
    newLines[index] = { ...newLines[index], [field]: value };
    setBatchLines(newLines);
  };

  const handleAddBatchSubmit = async () => {
    const validLines = batchLines.filter(l => l.quantity > 0);
    if (!group || !batchForm.name.trim() || validLines.length === 0) return;
    
    try {
      const allBatches = await dataProvider.getPurchaseBatches();
      const allBatchItems = await dataProvider.getPurchaseBatchItems();

      if (editingBatchId) {
        const idx = allBatches.findIndex(b => b.id === editingBatchId);
        if (idx !== -1) {
          allBatches[idx] = { ...allBatches[idx], name: batchForm.name, date: batchForm.date, note: batchForm.note };
        }
        const newItems = allBatchItems.filter(i => i.purchase_batch_id !== editingBatchId);
        const updatedItems: PurchaseBatchItem[] = validLines.map(line => ({
          id: crypto.randomUUID(),
          purchase_batch_id: editingBatchId,
          product_variant_id: line.variant_id,
          quantity: line.quantity,
          cost: typeof line.cost === 'string' ? (parseFloat(line.cost) || 0) : (line.cost || 0),
          note: line.note
        }));
        await dataProvider.savePurchaseBatches(allBatches);
        await dataProvider.savePurchaseBatchItems([...newItems, ...updatedItems]);
      } else {
        const newBatchId = crypto.randomUUID();
        const newBatch: PurchaseBatch = {
          id: newBatchId,
          product_group_id: group.id,
          name: batchForm.name,
          date: batchForm.date,
          note: batchForm.note,
          created_at: new Date().toISOString()
        };

        const newItems: PurchaseBatchItem[] = validLines.map(line => ({
          id: crypto.randomUUID(),
          purchase_batch_id: newBatchId,
          product_variant_id: line.variant_id,
          quantity: line.quantity,
          cost: typeof line.cost === 'string' ? (parseFloat(line.cost) || 0) : (line.cost || 0),
          note: line.note
        }));

        await dataProvider.savePurchaseBatches([...allBatches, newBatch]);
        await dataProvider.savePurchaseBatchItems([...allBatchItems, ...newItems]);
      }
      
      onClose();
      onSaveSuccess();
    } catch (err) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        onStale?.();
        onClose();
        return;
      }
      throw err;
    }
  };

  const batchTotal = batchLines.reduce((sum, line) => {
    const q = line?.quantity || 0;
    const c = typeof line?.cost === 'string' ? (parseFloat(line?.cost) || 0) : (line?.cost || 0);
    return sum + (q * c);
  }, 0);

  if (!show) return null;

  return (
    <div id="purchase-batch-modal" style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="card" style={{ width: '600px', maxHeight: '90vh', overflowY: 'auto', backgroundColor: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', padding: '16px', borderBottom: '1px solid #e5e7eb' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>{editingBatchId ? '編輯採購批次' : '新增採購批次'}</h2>
          <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={onClose}><X size={20} /></button>
        </div>
        
        <div style={{ padding: '16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>批次名稱 *</label>
              <input className="input" type="text" value={batchForm.name} onChange={e => setBatchForm({...batchForm, name: e.target.value})} placeholder="例如：2023-11-20 安利美特採購" style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>採購日期</label>
              <input className="input" type="date" value={batchForm.date} onChange={e => setBatchForm({...batchForm, date: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>備註</label>
              <input className="input" type="text" value={batchForm.note} onChange={e => setBatchForm({...batchForm, note: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontWeight: 600, fontSize: '14px', color: '#1e293b' }}>採購明細</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#475569', cursor: 'pointer', userSelect: 'none' }}>
              <input 
                type="checkbox" 
                checked={onlyShowShortage} 
                onChange={e => setOnlyShowShortage(e.target.checked)} 
                style={{ cursor: 'pointer' }}
              />
              <span>只顯示有缺口商品</span>
            </label>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>
            <thead>
              <tr style={{ backgroundColor: '#f8fafc', color: '#64748b' }}>
                <th style={{ padding: '8px', textAlign: 'left', fontWeight: 500 }}>商品規格</th>
                <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>缺口</th>
                <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>數量</th>
                <th style={{ padding: '8px', textAlign: 'right', fontWeight: 500, width: '120px' }}>{isDaili ? '成本（台幣）' : '實支單價（日幣）'}</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const rows: React.ReactNode[] = [];
                let hasAnyVisible = false;
                
                variants.forEach((v, idx) => {
                  const shortage = getVariantShortageForModal(v);
                  const isHidden = onlyShowShortage && shortage <= 0;
                  if (isHidden) return;
                  
                  hasAnyVisible = true;
                  const lineData = batchLines[idx];
                  
                  rows.push(
                    <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '8px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ fontWeight: 600, color: '#1e293b' }}>
                            {getDisplayProductName(v)}
                          </div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                            SKU: {v.myacg_item_code}
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '8px', textAlign: 'center' }}>
                        {(() => {
                          const remainingGap = shortage - (lineData?.quantity || 0);
                          if (remainingGap > 0) {
                            return (
                              <span style={{
                                backgroundColor: '#FEE2E2',
                                color: '#DC2626',
                                border: '1px solid #fecaca',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '12px',
                                fontWeight: 600,
                                whiteSpace: 'nowrap'
                              }}>
                                缺 {remainingGap}
                              </span>
                            );
                          } else if (remainingGap === 0) {
                            return (
                              <span style={{
                                backgroundColor: '#DCFCE7',
                                color: '#16a34a',
                                border: '1px solid #bbf7d0',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '12px',
                                fontWeight: 600,
                                whiteSpace: 'nowrap'
                              }}>
                                已補齊
                              </span>
                            );
                          } else {
                            return (
                              <span style={{
                                backgroundColor: '#FFEDD5',
                                color: '#EA580C',
                                border: '1px solid #fed7aa',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '12px',
                                fontWeight: 600,
                                whiteSpace: 'nowrap'
                              }}>
                                多買 {Math.abs(remainingGap)}
                              </span>
                            );
                          }
                        })()}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'center' }}>
                        <input 
                          className="input" 
                          type="text" 
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={lineData?.quantity === 0 ? '' : (lineData?.quantity || '')} 
                          onChange={e => {
                            const val = e.target.value.replace(/[^0-9]/g, '');
                            updateBatchLine(idx, 'quantity', val === '' ? 0 : parseInt(val));
                          }} 
                          style={{ width: '100%', padding: '4px 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px' }} 
                        />
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                          {!isDaili && <span style={{ color: '#64748b' }}>¥</span>}
                          <input 
                            className="input" 
                            type="text" 
                            inputMode="decimal"
                            pattern="[0-9]*\.?[0-9]*" 
                            value={lineData?.cost === 0 ? '' : (lineData?.cost ?? '')} 
                            onChange={e => {
                              const valStr = e.target.value.replace(/[^0-9.]/g, '');
                              const parts = valStr.split('.');
                              const cleanVal = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : valStr;
                              updateBatchLine(idx, 'cost', cleanVal);
                            }} 
                            style={{ width: '80px', padding: '4px 8px', textAlign: 'right', border: '1px solid #cbd5e1', borderRadius: '4px' }} 
                          />
                        </div>
                      </td>
                    </tr>
                  );
                });
                
                if (!hasAnyVisible) {
                  return (
                    <tr>
                      <td colSpan={4} style={{ padding: '16px', textAlign: 'center', color: '#64748b' }}>
                        目前無任何缺口商品
                      </td>
                    </tr>
                  );
                }
                
                return rows;
              })()}
            </tbody>
          </table>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px', borderTop: '1px solid #e5e7eb', paddingTop: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
                本批次合計：<span style={{ color: '#2563eb', fontSize: '15px', fontWeight: 700 }}>{isDaili ? 'NT$ ' : '¥ '}{batchTotal.toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-outline" style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1', cursor: 'pointer' }} onClick={onClose}>取消</button>
                <button className="btn btn-primary" style={{ padding: '8px 16px', borderRadius: '6px', backgroundColor: '#2563eb', color: '#fff', cursor: 'pointer' }} onClick={handleAddBatchSubmit} disabled={!batchForm.name.trim()}>儲存</button>
              </div>
            </div>
            {(() => {
              let completedItemsCount = 0;
              let remainingShortageItemsCount = 0;
              let excessItemsCount = 0;

              variants.forEach((v, idx) => {
                const originalShortage = getVariantShortageForModal(v);
                const inputQty = batchLines[idx]?.quantity || 0;
                const remainingGap = originalShortage - inputQty;

                if (originalShortage > 0 && remainingGap <= 0) {
                  completedItemsCount++;
                }
                if (remainingGap > 0) {
                  remainingShortageItemsCount++;
                }
                if (remainingGap < 0) {
                  excessItemsCount++;
                }
              });

              return (
                <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                  <span>已補齊：<strong style={{ color: '#16a34a' }}>{completedItemsCount}</strong> 個規格</span>
                  <span>尚有缺口：<strong style={{ color: '#dc2626' }}>{remainingShortageItemsCount}</strong> 個規格</span>
                  {excessItemsCount > 0 && (
                    <span>超買：<strong style={{ color: '#ea580c' }}>{excessItemsCount}</strong> 個規格</span>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
