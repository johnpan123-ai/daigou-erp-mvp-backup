import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getBaseSku, calculateFinalMyacgDemand, calculateVariantDemandAndPurchased } from '../lib/db';
import { dataProvider, StaleDataError } from '../providers/dataProvider';
import type { 
  ProductGroup, ProductVariant, InventoryItem, ProductCategory,
  PurchaseBatch, PurchaseBatchItem, PrivateOrder, PrivateOrderItem 
} from '../lib/db';
import { ChevronRight, ChevronDown, Plus, X, ArrowLeft, Search, AlertTriangle, Package, CheckSquare, RefreshCw, DollarSign, Copy, Trash2, Edit2 } from 'lucide-react';
import PurchaseBatchTab from '../components/PurchaseBatchTab';
import PrivateOrderTab from '../components/PrivateOrderTab';
import { useViewport } from '../contexts/ViewportContext';
import PurchaseBatchModal from '../components/PurchaseBatchModal';


const HighlightText = ({ text, highlight }: { text: string | undefined | null; highlight: string }) => {
  if (!text) return null;
  if (!highlight.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
  return (
    <>
      {parts.map((part, i) => 
        part.toLowerCase() === highlight.toLowerCase() ? (
          <span key={i} style={{ backgroundColor: '#fef08a', padding: '0 2px', borderRadius: '2px', color: '#854d0e' }}>{part}</span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
};

const renderStatusBadge = (needToBuy: number, excessBuy: number, totalDemand: number) => {
  if (needToBuy > 0) {
    return (
      <span style={{
        backgroundColor: '#FEE2E2',
        color: '#DC2626',
        border: '1px solid #fecaca',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 600,
        display: 'inline-block'
      }}>
        待採購 {needToBuy}
      </span>
    );
  }
  if (excessBuy > 0) {
    return (
      <span style={{
        backgroundColor: '#fff7ed',
        color: '#c2410c',
        border: '1px solid #ffedd5',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 600,
        display: 'inline-block'
      }}>
        多買 {excessBuy}
      </span>
    );
  }
  if (totalDemand === 0) {
    return (
      <span style={{
        backgroundColor: '#EFF6FF',
        color: '#2563EB',
        border: '1px solid #dbeafe',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 600,
        display: 'inline-block'
      }}>
        無需求
      </span>
    );
  }
  return (
    <span style={{
      backgroundColor: '#f0fdf4',
      color: '#166534',
      border: '1px solid #dcfce7',
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '12px',
      fontWeight: 600,
      display: 'inline-block'
    }}>
      完成
    </span>
  );
};

const ScrollWrapper = ({ children, isMobile }: { children: React.ReactNode; isMobile: boolean }) => {
  if (isMobile) {
    return (
      <div className="mobile-scroll-wrapper" style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {children}
      </div>
    );
  }
  return <>{children}</>;
};

interface MobilePurchaseBatchTabProps {
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

function MobilePurchaseBatchTab({
  batches,
  batchItems,
  variants,
  categoryMap,
  groups = [],
  onRefresh,
  onEditBatch,
  getDisplayProductName,
  canWrite = false,
  isDaili = false
}: MobilePurchaseBatchTabProps) {
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
    const variantMap = new Map(variants.map(v => [v.id, v]));
    
    for (const item of items) {
      const variant = variantMap.get(item.product_variant_id);
      if (!variant) continue;

      const g = variant.product_group_id ? groupMap.get(variant.product_group_id) : null;
      const groupTitle = g?.normalized_title
        || g?.title
        || variant.product_title
        || '未命名商品';
      
      const cat = variant.product_category_id ? categoryMap.get(variant.product_category_id) : null;
      const catTitle = (cat && cat.title && cat.title !== '單品') ? cat.title : '';
      const displayProdName = getDisplayProductName(variant);
      let restName = displayProdName;
      if (catTitle && !displayProdName.includes(catTitle)) {
        restName = `${catTitle} - ${displayProdName}`;
      }
      const displayName = `${groupTitle} - ${restName}`.replace(/\s*-\s*/g, '-');

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

  const handleCopyBatchName = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(name);
      alert('已複製批次名稱');
    } catch (err) {
      console.error('Failed to copy batch name:', err);
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
    <div style={{ padding: '12px', backgroundColor: '#f8fafc', flex: 1, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b' }}>排序:</span>
          <select 
            className="input" 
            style={{ width: '150px', height: '28px', fontSize: '12px', padding: '0 8px', border: '1px solid #cbd5e1', borderRadius: '4px' }}
            value={sortBy}
            onChange={e => setSortBy(e.target.value as any)}
          >
            <option value="date_desc">日期（新 → 舊）</option>
            <option value="date_asc">日期（舊 → 新）</option>
            <option value="amount_desc">金額（高 → 低）</option>
            <option value="amount_asc">金額（低 → 高）</option>
          </select>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {sortedBatches.map(batch => {
          const items = batchItems.filter(i => i.purchase_batch_id === batch.id);
          const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
          const totalCost = items.reduce((sum, i) => sum + (i.quantity * i.cost), 0);
          const isExpanded = expandedIds.has(batch.id);

          return (
            <div key={batch.id} style={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden', padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              
              {/* Line 1: Name and Date */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 600, color: '#0f172a', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>{batch.name}</span>
                  <button 
                    onClick={(e) => handleCopyBatchName(e, batch.name)}
                    title="複製批次名稱"
                    style={{
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      color: '#64748b',
                      padding: '2px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '4px',
                      transition: 'all 0.2s',
                    }}
                  >
                    <Copy size={13} />
                  </button>
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  {batch.date}
                </div>
              </div>

              {/* Line 2: Items count and Total Cost */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '2px 0' }}>
                <div style={{ fontSize: '13px', color: '#334155', fontWeight: 500 }}>
                  {totalQty}件商品
                </div>
                <div style={{ fontSize: '14px', color: '#0f172a', fontWeight: 600 }}>
                  {currencySymbol}{totalCost.toLocaleString()}
                </div>
              </div>

              {/* Line 3: Actions row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f1f5f9', paddingTop: '6px', marginTop: '2px' }}>
                <div 
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#2563eb', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}
                  onClick={() => toggleExpand(batch.id)}
                >
                  {isExpanded ? '▼ 收合明細' : '▶ 查看明細'}
                </div>
                <div style={{ display: 'flex', gap: '12px' }}>
                  {canWrite && (
                    <button className="btn btn-ghost" style={{ padding: '2px', color: '#2563eb' }} onClick={() => handleCopyBatchLedger(batch)} title="複製本批次帳目">
                      <Copy size={15} />
                    </button>
                  )}
                  <button className="btn btn-ghost" style={{ padding: '2px', color: '#64748b' }} onClick={() => onEditBatch(batch)} title="編輯批次與明細">
                    <Edit2 size={15} />
                  </button>
                  <button className="btn btn-ghost" style={{ padding: '2px', color: '#ef4444' }} onClick={() => handleDeleteBatch(batch)} title="刪除批次">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div style={{ borderTop: '1px dashed #e2e8f0', marginTop: '6px', paddingTop: '6px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {items.sort((a, b) => {
                    const idxA = variants.findIndex(v => v.id === a.product_variant_id);
                    const idxB = variants.findIndex(v => v.id === b.product_variant_id);
                    return idxA - idxB;
                  }).map(item => {
                    const variant = variantMap.get(item.product_variant_id);
                    return (
                      <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: '1px', borderBottom: '1px solid #f8fafc', paddingBottom: '4px' }}>
                        <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '13px' }}>
                          {variant ? getDisplayProductName(variant) : '未知商品'}
                        </div>
                        <div style={{ fontSize: '12px', color: '#64748b' }}>
                          數量 {item.quantity}
                        </div>
                      </div>
                    );
                  })}
                  {items.length === 0 && (
                    <div style={{ fontSize: '12px', color: '#94a3b8', textAlign: 'center', padding: '4px' }}>無明細</div>
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

export default function PurchaseManagement() {
  const { isMobile } = useViewport();

  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const getVariantDemands = (v: ProductVariant) => {
    const inventoryList = Array.from(inventoryMap.values());
    const res = calculateVariantDemandAndPurchased(
      v,
      privateOrderItems,
      purchaseBatchItems,
      inventoryList,
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

  const [editMode, setEditMode] = useState<boolean>(() => {
    return localStorage.getItem('purchase_management_edit_mode') === 'true';
  });
  const [canWrite, setCanWrite] = useState<boolean>(false);

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
  const [isStale, setIsStale] = useState<boolean>(false);

  useEffect(() => {
    const unsubscribe = dataProvider.onStaleChange(setIsStale);
    setIsStale(dataProvider.checkIsStaleLive());
    return unsubscribe;
  }, []);

  const handleReloadData = async () => {
    await loadData();
  };

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [exchangeRate, setExchangeRate] = useState<number>(() => {
    const val = localStorage.getItem('erp_exchange_rate');
    return val ? parseFloat(val) : 0.23;
  });
  const [exchangeRateInput, setExchangeRateInput] = useState<string>(() => {
    const val = localStorage.getItem('erp_exchange_rate');
    return val || '0.23';
  });

  useEffect(() => {
    setExchangeRateInput(exchangeRate ? String(exchangeRate) : '');
  }, [exchangeRate]);

  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => {
        setToastMessage(null);
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const toggleEditMode = () => {
    const nextVal = !editMode;
    setEditMode(nextVal);
    localStorage.setItem('purchase_management_edit_mode', String(nextVal));
    setToastMessage(nextVal ? '已進入編輯模式，可修改數量' : '已鎖定數量欄位，避免誤觸');
  };

  const [group, setGroup] = useState<ProductGroup | null>(null);
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const originalValuesRef = useRef<Record<string, string>>({});

  const [tempJpyCosts, setTempJpyCosts] = useState<Record<string, string>>({});
  const [tempTwdCosts, setTempTwdCosts] = useState<Record<string, string>>({});

  const handleCommitJpyCost = async (variantId: string, valStr: string) => {
    const v = variants.find(x => x.id === variantId);
    const dbCost = v ? (v.default_jpy_cost ?? '') : '';
    if (String(dbCost) === valStr) {
      setTempJpyCosts(prev => {
        const copy = { ...prev };
        delete copy[variantId];
        return copy;
      });
      return;
    }
    await handleUpdateDefaultJpyCost(variantId, valStr);
    setTempJpyCosts(prev => {
      const copy = { ...prev };
      delete copy[variantId];
      return copy;
    });
  };

  const handleCommitTwdCost = async (variantId: string, valStr: string) => {
    const v = variants.find(x => x.id === variantId);
    const dbCost = v ? (v.default_twd_cost ?? '') : '';
    if (String(dbCost) === valStr) {
      setTempTwdCosts(prev => {
        const copy = { ...prev };
        delete copy[variantId];
        return copy;
      });
      return;
    }
    await handleUpdateDefaultTwdCost(variantId, valStr);
    setTempTwdCosts(prev => {
      const copy = { ...prev };
      delete copy[variantId];
      return copy;
    });
  };

  const getVariantDefaultJpyCostInputVal = (v: ProductVariant): string => {
    if (tempJpyCosts[v.id] !== undefined) {
      return tempJpyCosts[v.id];
    }
    const defCost = (v.default_jpy_cost !== undefined && v.default_jpy_cost !== null) 
      ? v.default_jpy_cost 
      : variantDefaultJpyCosts[v.id];
    return defCost !== undefined && defCost !== null ? String(defCost) : '';
  };

  const getVariantDefaultTwdCostInputVal = (v: ProductVariant): string => {
    if (tempTwdCosts[v.id] !== undefined) {
      return tempTwdCosts[v.id];
    }
    const defCost = (v.default_twd_cost !== undefined && v.default_twd_cost !== null) 
      ? v.default_twd_cost 
      : variantDefaultTwdCosts[v.id];
    return defCost !== undefined && defCost !== null ? String(defCost) : '';
  };

  const catalogSortedIds = useMemo(() => {
    const catalogVars = variants.filter(v => v.source !== 'manual');
    catalogVars.sort((a, b) => {
      return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '', undefined, { numeric: true, sensitivity: 'base' });
    });
    return catalogVars.map(v => v.id);
  }, [variants]);

  const getSortVal = useCallback((x: ProductVariant) => {
    if (x.source === 'manual') {
      return x.sort_order ?? 999999;
    } else {
      const catIdx = catalogSortedIds.indexOf(x.id);
      return catIdx !== -1 ? catIdx * 10 : 999999;
    }
  }, [catalogSortedIds]);

  const handleManualFieldFocus = (id: string, field: 'variant_name' | 'myacg_item_code', currentVal: string) => {
    const key = `${id}_${field}`;
    if (originalValuesRef.current[key] === undefined) {
      originalValuesRef.current[key] = currentVal || '';
    }
  };

  const handleManualFieldChange = (id: string, field: 'variant_name' | 'myacg_item_code', newVal: string) => {
    setVariants(prev => prev.map(v => {
      if (v.id === id) {
        return { ...v, [field]: newVal };
      }
      return v;
    }));
  };

  const handleManualFieldBlur = async (id: string, field: 'variant_name' | 'myacg_item_code', finalVal: string) => {
    const key = `${id}_${field}`;
    const origVal = originalValuesRef.current[key] ?? '';
    const trimmedFinal = (finalVal || '').trim();
    const trimmedOrig = (origVal || '').trim();

    if (trimmedFinal !== trimmedOrig) {
      console.log(`[Manual Variant Update] Save field ${field} for variant ${id}: "${trimmedOrig}" -> "${trimmedFinal}"`);
      try {
        await dataProvider.updateProductVariantPatch(id, { [field]: trimmedFinal });
        originalValuesRef.current[key] = trimmedFinal;
      } catch (err: any) {
        console.error('Failed to update manual variant field:', err);
        alert(`更新規格欄位失敗：${err.message || err}`);
        setVariants(prev => prev.map(v => {
          if (v.id === id) {
            return { ...v, [field]: origVal };
          }
          return v;
        }));
      }
    }
    delete originalValuesRef.current[key];
  };

  const handleAddNewVariant = async () => {
    if (!id || !canWrite) return;

    const existingSortOrders = variants.map(v => getSortVal(v));
    const maxSortOrder = existingSortOrders.length > 0 ? Math.max(...existingSortOrders) : -1;
    const newSortOrder = maxSortOrder + 1;

    const newVar: ProductVariant = {
      id: crypto.randomUUID(),
      product_group_id: id,
      product_category_id: undefined,
      variant_name: '',
      myacg_item_code: '',
      myacg_auto_quantity: 0,
      effective_myacg_quantity: 0,
      myacg_manual_adjustment: 0,
      waca_auto_quantity: 0,
      waca_manual_adjustment: 0,
      private_manual_adjustment: null,
      purchased_manual_adjustment: null,
      note: '',
      sort_order: newSortOrder,
      catalog_missing: false,
      source: 'manual',
      source_type: 'manual',
      product_title: group?.title || '',
      default_jpy_cost: null,
      default_twd_cost: null
    };

    try {
      await dataProvider.saveProductVariants([newVar]);
      await loadData();
      setToastMessage('已成功手動新增規格');
    } catch (err: any) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      console.error('Failed to save manual variant:', err);
      alert(`新增規格失敗：${err.message || err}`);
    }
  };

  const handleMoveVariant = async (variantId: string, direction: 'up' | 'down') => {
    if (!canWrite) return;
    const idx = variants.findIndex(v => v.id === variantId);
    if (idx === -1) return;

    let newSortOrder = 0;
    if (direction === 'up') {
      if (idx === 0) return; // already at top
      const prev = variants[idx - 1];
      const wPrev = getSortVal(prev);
      if (idx === 1) {
        newSortOrder = wPrev - 1;
      } else {
        const prevPrev = variants[idx - 2];
        const wPrevPrev = getSortVal(prevPrev);
        newSortOrder = (wPrevPrev + wPrev) / 2;
      }
    } else {
      if (idx === variants.length - 1) return; // already at bottom
      const next = variants[idx + 1];
      const wNext = getSortVal(next);
      if (idx === variants.length - 2) {
        newSortOrder = wNext + 1;
      } else {
        const nextNext = variants[idx + 2];
        const wNextNext = getSortVal(nextNext);
        newSortOrder = (wNext + wNextNext) / 2;
      }
    }

    try {
      const target = variants[idx];
      await dataProvider.saveProductVariants([{ ...target, sort_order: newSortOrder }]);
      await loadData();
      setToastMessage('已成功移動規格位置');
    } catch (err: any) {
      if (err instanceof StaleDataError) {
        alert(err.message);
        setIsStale(true);
        await loadData();
        return;
      }
      console.error('Failed to move variant:', err);
      alert(`移動規格失敗：${err.message || err}`);
    }
  };

  const handleDeleteVariant = async (variantId: string) => {
    if (!canWrite) return;
    const target = variants.find(v => v.id === variantId);
    if (!target || target.source !== 'manual') {
      alert('只能刪除手動建立的規格！');
      return;
    }

    if (window.confirm('確定刪除此手動規格？此操作不會刪除買動漫原始資料，但會移除此 ERP 手動建立規格。')) {
      try {
        await dataProvider.deleteProductVariant(variantId);
        await loadData();
        setToastMessage('已成功刪除手動規格');
      } catch (err: any) {
        console.error('Failed to delete variant:', err);
        alert(`刪除規格失敗：${err.message || err}`);
      }
    }
  };

  const [inventoryMap, setInventoryMap] = useState<Map<string, InventoryItem>>(new Map());
  const [categoryMap, setCategoryMap] = useState<Map<string, ProductCategory>>(new Map());

  const [variantDefaultJpyCosts, setVariantDefaultJpyCosts] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem('variant_default_jpy_costs');
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  });

  const handleUpdateDefaultJpyCost = async (variantId: string, valStr: string) => {
    if (!canWrite) return;
    const val = valStr === '' ? null : parseInt(valStr);
    
    const updated = { ...variantDefaultJpyCosts };
    if (val === null || isNaN(val) || val <= 0) {
      delete updated[variantId];
    } else {
      updated[variantId] = val;
    }
    setVariantDefaultJpyCosts(updated);
    localStorage.setItem('variant_default_jpy_costs', JSON.stringify(updated));

    await dataProvider.updateProductVariantPatch(variantId, {
      default_jpy_cost: val,
      updated_at: new Date().toISOString()
    });
    
    setVariants(variants.map(v => v.id === variantId ? { ...v, default_jpy_cost: val } : v));
  };

  const [variantDefaultTwdCosts, setVariantDefaultTwdCosts] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem('variant_default_twd_costs');
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  });

  const handleUpdateDefaultTwdCost = async (variantId: string, valStr: string) => {
    if (!canWrite) return;
    const val = valStr === '' ? null : parseInt(valStr);

    const updated = { ...variantDefaultTwdCosts };
    if (val === null || isNaN(val) || val <= 0) {
      delete updated[variantId];
    } else {
      updated[variantId] = val;
    }
    setVariantDefaultTwdCosts(updated);
    localStorage.setItem('variant_default_twd_costs', JSON.stringify(updated));

    await dataProvider.updateProductVariantPatch(variantId, {
      default_twd_cost: val,
      updated_at: new Date().toISOString()
    });
    
    setVariants(variants.map(v => v.id === variantId ? { ...v, default_twd_cost: val } : v));
  };

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

  const getDisplayProductName = (v: ProductVariant): string => {
    const variantName = (v.variant_name || '').trim();
    const productTitle = group?.normalized_title || group?.title || '';
    const isDaili = group?.listing_type === '代理版';
    
    if (isDaili) {
      // 1. variant_name (unless blank, null, undefined, 單品, 一箱)
      if (variantName && variantName !== '單品' && variantName !== '一箱') {
        return variantName;
      }
      // Use variant specific product_title first for proxy version fallback
      const targetTitle = v.product_title || productTitle;
      // 2. cleanDailiTitle(targetTitle)
      const cleaned = cleanDailiTitle(targetTitle);
      if (cleaned) {
        return cleaned;
      }
      // 3. targetTitle
      if (targetTitle) {
        return targetTitle;
      }
      // 4. group.title
      if (group?.title) {
        return group.title;
      }
      // 5. SKU
      return v.myacg_item_code || '未命名規格';
    } else {
      // Standard Product (Category - Variant)
      if (v.product_category_id) {
        const cat = categoryMap.get(v.product_category_id);
        if (cat && cat.title && cat.title !== '單品') {
          return `${cat.title} - ${variantName || '單品'}`;
        }
      }
      if (variantName) {
        return variantName;
      }
      if (productTitle) {
        return productTitle;
      }
      return v.myacg_item_code || '未命名規格';
    }
  };
  
  // Data for calculation
  const [salesOrderItems, setSalesOrderItems] = useState<any[]>([]);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [manualExpandedGroups, setManualExpandedGroups] = useState<Set<string>>(new Set());


  const toggleManualGroup = (title: string) => {
    const newSet = new Set(manualExpandedGroups);
    if (newSet.has(title)) newSet.delete(title);
    else newSet.add(title);
    setManualExpandedGroups(newSet);
  };

  const [filterMode, setFilterMode] = useState<'all' | 'abnormal'>('all');

  const [sortMode, setSortMode] = useState<'catalog' | 'shortage'>('catalog');

  const [privateOrders, setPrivateOrders] = useState<PrivateOrder[]>([]);
  const [privateOrderItems, setPrivateOrderItems] = useState<PrivateOrderItem[]>([]);
  const [purchaseBatches, setPurchaseBatches] = useState<PurchaseBatch[]>([]);
  const [purchaseBatchItems, setPurchaseBatchItems] = useState<PurchaseBatchItem[]>([]);
  
  // UI States
  const [activeTab, setActiveTab] = useState<'worksheet' | 'purchase_batches' | 'private_orders'>('worksheet');

  const [showPrivateOrderModal, setShowPrivateOrderModal] = useState(false);
  const [editingPoId, setEditingPoId] = useState<string | null>(null);
  const [poForm, setPoForm] = useState({ customer_name: '', contact: '', note: '' });
  const [poLines, setPoLines] = useState<{ variant_id: string, quantity: number, amount: number | string, note: string }[]>([]);

  // Modal: Purchase Batch
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  // Bulk master cost setting state
  const [bulkMasterPrice, setBulkMasterPrice] = useState<string>('');
  const [bulkMasterCategory, setBulkMasterCategory] = useState<string>('');
  const [isApplyingMasterCost, setIsApplyingMasterCost] = useState<boolean>(false);

  useEffect(() => {
    loadData();
  }, [id]);


  const loadData = async () => {
    if (!id) return;
    const allGroups = await dataProvider.getProductGroups();
    const g = allGroups.find(x => x.id === id);
    if (!g) {
      navigate('/purchase-records');
      return;
    }
    setGroup(g);
    setGroups(allGroups);

    const allVars = await dataProvider.getProductVariants();
    const allCats = await dataProvider.getProductCategories();
    const catMap = new Map(allCats.map(c => [c.id, c]));
    setCategoryMap(catMap);

    const groupCatIds = new Set(allCats.filter(c => c.product_group_id === id).map(c => c.id));
    const groupVars = allVars.filter(v => v.product_group_id === id || (v.product_category_id && groupCatIds.has(v.product_category_id)));
    
    // Sort groupVars: Catalog variants sorted by SKU, manual variants placed by sort_order
    const catalogVars = groupVars.filter(v => v.source !== 'manual');
    catalogVars.sort((a, b) => {
      return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '', undefined, { numeric: true, sensitivity: 'base' });
    });
    const tempCatalogIds = catalogVars.map(v => v.id);
    
    groupVars.sort((a, b) => {
      const getVal = (x: ProductVariant) => {
        if (x.source === 'manual') {
          return x.sort_order ?? 999999;
        } else {
          const catIdx = tempCatalogIds.indexOf(x.id);
          return catIdx !== -1 ? catIdx * 10 : 999999;
        }
      };
      const valA = getVal(a);
      const valB = getVal(b);
      if (valA !== valB) return valA - valB;
      return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '', undefined, { numeric: true, sensitivity: 'base' });
    });

    const writePermission = await dataProvider.canWriteCloud();
    setCanWrite(writePermission);

    // Sync legacy costs to variants and update cost state maps
    const jpyCosts = { ...variantDefaultJpyCosts };
    const twdCosts = { ...variantDefaultTwdCosts };
    let needsSync = false;

    const updatedGroupVars = groupVars.map(v => {
      let updatedJpy = v.default_jpy_cost;
      let updatedTwd = v.default_twd_cost;
      let variantChanged = false;

      // Hydrate local state if variant has database cost
      if (v.default_jpy_cost !== undefined && v.default_jpy_cost !== null) {
        jpyCosts[v.id] = v.default_jpy_cost;
      } else {
        // Fallback to local storage cost if database column is null/empty
        const localJpy = jpyCosts[v.id];
        if (localJpy !== undefined && localJpy !== null) {
          updatedJpy = localJpy;
          variantChanged = true;
        }
      }

      if (v.default_twd_cost !== undefined && v.default_twd_cost !== null) {
        twdCosts[v.id] = v.default_twd_cost;
      } else {
        const localTwd = twdCosts[v.id];
        if (localTwd !== undefined && localTwd !== null) {
          updatedTwd = localTwd;
          variantChanged = true;
        }
      }

      if (variantChanged) {
        needsSync = true;
        return {
          ...v,
          default_jpy_cost: updatedJpy,
          default_twd_cost: updatedTwd
        };
      }
      return v;
    });

    setVariantDefaultJpyCosts(jpyCosts);
    setVariantDefaultTwdCosts(twdCosts);
    localStorage.setItem('variant_default_jpy_costs', JSON.stringify(jpyCosts));
    localStorage.setItem('variant_default_twd_costs', JSON.stringify(twdCosts));

    if (needsSync && writePermission) {
      console.log('[Default Cost Sync] Migrating legacy local storage costs to cloud...');
      if (allVars && allVars.length > 0) {
        const updatedAllVars = allVars.map(av => {
          const match = updatedGroupVars.find(gv => gv.id === av.id);
          if (match && (match.default_jpy_cost !== av.default_jpy_cost || match.default_twd_cost !== av.default_twd_cost)) {
            return {
              ...av,
              default_jpy_cost: match.default_jpy_cost,
              default_twd_cost: match.default_twd_cost
            };
          }
          return av;
        });
        try {
          await dataProvider.saveProductVariants(updatedAllVars);
        } catch (err) {
          if (err instanceof StaleDataError) {
            console.warn('[Cost Sync] Stale data detected during load cost sync.');
            setIsStale(true);
          } else {
            throw err;
          }
        }
      }
    }

    setVariants(updatedGroupVars);

    const inventory = await dataProvider.getInventory();
    const invMap = new Map(inventory.map(i => [i.myacg_item_code, i]));
    setInventoryMap(invMap);

    // Fetch new architecture data
    const allPrivateOrders = await dataProvider.getPrivateOrders();
    const allPrivateOrderItems = await dataProvider.getPrivateOrderItems();
    const groupPrivateOrders = allPrivateOrders.filter(po => po.product_group_id === id);
    const groupPoIds = new Set(groupPrivateOrders.map(po => po.id));
    const groupPrivateOrderItems = allPrivateOrderItems.filter(poi => groupPoIds.has(poi.private_order_id));
    
    setPrivateOrders(groupPrivateOrders);
    setPrivateOrderItems(groupPrivateOrderItems);

    const allBatches = await dataProvider.getPurchaseBatches();
    const allBatchItems = await dataProvider.getPurchaseBatchItems();
    const groupBatches = allBatches.filter(b => b.product_group_id === id);
    const groupBatchIds = new Set(groupBatches.map(b => b.id));
    const groupBatchItems = allBatchItems.filter(bi => groupBatchIds.has(bi.purchase_batch_id));

    
    setPurchaseBatches(groupBatches);
    setPurchaseBatchItems(groupBatchItems);

    const allSOI = await dataProvider.getSalesOrderItems();
    const groupSOI = allSOI.filter(i => {
      const iCode = i.myacg_item_code;
      return groupVars.some(v => 
        v.myacg_item_code === iCode || 
        (getBaseSku(v.myacg_item_code) === getBaseSku(iCode) && 
         (v.myacg_item_code === getBaseSku(v.myacg_item_code) || iCode === getBaseSku(iCode)))
      );
    });

    setSalesOrderItems(groupSOI);
    dataProvider.registerFreshLoad();
  };


  const handleUpdatePlatformDemand = async (vId: string, platform: 'myacg' | 'waca', totalValue: number) => {
    if (isNaN(totalValue) || totalValue < 0) totalValue = 0;
    const allVars = await dataProvider.getProductVariants();
    const target = allVars.find(v => v.id === vId);
    if (target) {
      let patch: Partial<ProductVariant> = {};
      if (platform === 'myacg') {
        const myacgQty = calculateFinalMyacgDemand(target.myacg_item_code, Array.from(inventoryMap.values()), salesOrderItems);
        const rawAuto = (target.effective_myacg_quantity !== null && target.effective_myacg_quantity !== undefined && target.effective_myacg_quantity >= 0)
          ? target.effective_myacg_quantity
          : ((target.myacg_auto_quantity !== null && target.myacg_auto_quantity !== undefined && target.myacg_auto_quantity >= 0)
            ? target.myacg_auto_quantity
            : (myacgQty >= 0 ? myacgQty : 0));
        const auto = rawAuto >= 0 ? rawAuto : 0;
        const manualAdj = totalValue - auto;
        patch = { myacg_manual_adjustment: manualAdj };
      } else {
        const auto = (target.waca_auto_quantity !== null && target.waca_auto_quantity !== undefined && target.waca_auto_quantity >= 0)
          ? target.waca_auto_quantity
          : 0;
        const manualAdj = totalValue - auto;
        patch = { waca_manual_adjustment: manualAdj };
      }
      patch.updated_at = new Date().toISOString();
      await dataProvider.updateProductVariantPatch(vId, patch);
      setVariants(variants.map(v => v.id === vId ? { ...v, ...patch } : v));
    }
  };

  const handleCopyAllGroupPurchasedLedger = async () => {
    if (purchaseBatchItems.length === 0) {
      alert('本商品無任何採購紀錄，無法複製。');
      return;
    }

    const ledgerMap = new Map<string, { name: string; quantity: number; cost: number }>();
    const groupMap = new Map(groups.map(g => [g.id, g]));
    
    for (const item of purchaseBatchItems) {
      const variant = variants.find(v => v.id === item.product_variant_id);
      if (!variant) continue;

      const g = variant.product_group_id ? groupMap.get(variant.product_group_id) : null;
      const groupTitle = g?.normalized_title
        || g?.title
        || group?.normalized_title
        || group?.title
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
      alert('已複製本商品全部已採購帳目（TSV 格式）至剪貼簿！');
    } catch (err) {
      console.error('Failed to copy ledger:', err);
      alert('複製失敗，瀏覽器可能不支援或無剪貼簿寫入權限。');
    }
  };

  // --- Modal Logic: Private Order ---
  const openPrivateOrderModal = () => {
    setEditingPoId(null);
    setPoForm({ customer_name: '', contact: '', note: '' });
    setPoLines(variants.map(v => ({ variant_id: v.id, quantity: 0, amount: 0, note: '' })));
    setShowPrivateOrderModal(true);
  };

  const handleEditOrder = (order: PrivateOrder) => {
    setEditingPoId(order.id);
    setPoForm({ customer_name: order.customer_name, contact: order.contact || '', note: order.note || '' });
    
    // Group existing items in this order by variant_id to detect duplicates
    const orderItemsByVariant: Record<string, PrivateOrderItem[]> = {};
    privateOrderItems.forEach(item => {
      if (item.private_order_id === order.id) {
        if (!orderItemsByVariant[item.product_variant_id]) {
          orderItemsByVariant[item.product_variant_id] = [];
        }
        orderItemsByVariant[item.product_variant_id].push(item);
      }
    });

    // Detect duplicates and print warning if any exist
    const duplicatesList: string[] = [];
    Object.entries(orderItemsByVariant).forEach(([variantId, items]) => {
      if (items.length > 1) {
        const variant = variants.find(v => v.id === variantId);
        const name = variant ? `${variant.product_title} - ${variant.variant_name} (${variant.myacg_item_code || '無條碼/代碼'})` : variantId;
        duplicatesList.push(`${name}: 重複 ${items.length} 筆`);
      }
    });

    if (duplicatesList.length > 0) {
      console.warn(`[Private Order Duplicate Warning] 偵測到重複私下登記項目：\n` + duplicatesList.join('\n'));
    }

    setPoLines(variants.map(v => {
      const items = orderItemsByVariant[v.id] || [];
      const existing = items[0];
      return {
        variant_id: v.id,
        quantity: existing ? existing.quantity : 0,
        amount: existing ? existing.amount : 0,
        note: existing?.note || ''
      };
    }));
    setShowPrivateOrderModal(true);
  };

  const updatePoLine = (index: number, field: string, value: any) => {
    const newLines = [...poLines];
    newLines[index] = { ...newLines[index], [field]: value };
    setPoLines(newLines);
  };

  const handleAddPrivateOrderSubmit = async () => {
    const validLines = poLines.filter(l => l.quantity > 0);
    if (!group || !poForm.customer_name.trim() || validLines.length === 0) return;
    
    const allPOs = await dataProvider.getPrivateOrders();
    const allPOItems = await dataProvider.getPrivateOrderItems();

    if (editingPoId) {
      const idx = allPOs.findIndex(o => o.id === editingPoId);
      if (idx !== -1) {
        allPOs[idx] = { ...allPOs[idx], customer_name: poForm.customer_name, contact: poForm.contact, note: poForm.note };
      }
      
      const originalPoItems = allPOItems.filter(i => i.private_order_id === editingPoId);
      const idsToDelete: string[] = [];
      const updatedItems: PrivateOrderItem[] = [];
      
      // Group originalPoItems by variant_id
      const originalPoItemsByVariant: Record<string, PrivateOrderItem[]> = {};
      originalPoItems.forEach(item => {
        if (!originalPoItemsByVariant[item.product_variant_id]) {
          originalPoItemsByVariant[item.product_variant_id] = [];
        }
        originalPoItemsByVariant[item.product_variant_id].push(item);
      });
      
      validLines.forEach(line => {
        const existingItems = originalPoItemsByVariant[line.variant_id] || [];
        if (existingItems.length > 0) {
          const keptId = existingItems[0].id;
          updatedItems.push({
            id: keptId,
            private_order_id: editingPoId,
            product_variant_id: line.variant_id,
            quantity: line.quantity,
            amount: typeof line.amount === 'string' ? (parseFloat(line.amount) || 0) : (line.amount || 0),
            note: line.note
          });
          if (existingItems.length > 1) {
            for (let i = 1; i < existingItems.length; i++) {
              idsToDelete.push(existingItems[i].id);
            }
          }
        } else {
          updatedItems.push({
            id: crypto.randomUUID(),
            private_order_id: editingPoId,
            product_variant_id: line.variant_id,
            quantity: line.quantity,
            amount: typeof line.amount === 'string' ? (parseFloat(line.amount) || 0) : (line.amount || 0),
            note: line.note
          });
        }
      });
      
      const validVariantIds = new Set(validLines.map(l => l.variant_id));
      originalPoItems.forEach(item => {
        if (!validVariantIds.has(item.product_variant_id)) {
          idsToDelete.push(item.id);
        }
      });
      
      if (idsToDelete.length > 0) {
        await dataProvider.deletePrivateOrderItems(idsToDelete);
      }
      
      const freshAllPOItems = await dataProvider.getPrivateOrderItems();
      const otherPOItems = freshAllPOItems.filter(i => i.private_order_id !== editingPoId);
      
      await dataProvider.savePrivateOrders(allPOs);
      await dataProvider.savePrivateOrderItems([...otherPOItems, ...updatedItems]);
    } else {
      const newPoId = crypto.randomUUID();
      const newPo: PrivateOrder = {
        id: newPoId,
        product_group_id: group.id,
        customer_name: poForm.customer_name,
        contact: poForm.contact,
        note: poForm.note,
        created_at: new Date().toISOString().slice(0, 10)
      };

      const newItems: PrivateOrderItem[] = validLines.map(line => ({
        id: crypto.randomUUID(),
        private_order_id: newPoId,
        product_variant_id: line.variant_id,
        quantity: line.quantity,
        amount: typeof line.amount === 'string' ? (parseFloat(line.amount) || 0) : (line.amount || 0),
        note: line.note
      }));
      
      await dataProvider.savePrivateOrders([...allPOs, newPo]);
      await dataProvider.savePrivateOrderItems([...allPOItems, ...newItems]);
    }
    
    setShowPrivateOrderModal(false);
    await loadData();
  };

  // --- Modal Logic: Purchase Batch ---
  const openBatchModal = () => {
    setEditingBatchId(null);
    setShowBatchModal(true);
  };

  const handleEditBatch = (batch: PurchaseBatch) => {
    setEditingBatchId(batch.id);
    setShowBatchModal(true);
  };

  const handleApplyMasterCostToAll = async () => {
    if (isApplyingMasterCost) return;
    const val = bulkMasterPrice === '' ? null : parseInt(bulkMasterPrice);
    if (val === null || isNaN(val) || val < 0) {
      alert('請輸入有效的單價金額！');
      return;
    }
    
    const costField = isDaili ? 'default_twd_cost' : 'default_jpy_cost';
    const costState = isDaili ? variantDefaultTwdCosts : variantDefaultJpyCosts;
    const setCostState = isDaili ? setVariantDefaultTwdCosts : setVariantDefaultJpyCosts;
    const lsKey = isDaili ? 'variant_default_twd_costs' : 'variant_default_jpy_costs';

    if (!confirm(`確定要將本群組全部共 ${variants.length} 個規格的預設單價設為 ${isDaili ? 'NT$' : '¥'} ${val} 嗎？`)) {
      return;
    }

    setIsApplyingMasterCost(true);
    try {
      const patches = variants.map(v => ({
        id: v.id,
        patch: {
          [costField]: val,
          updated_at: new Date().toISOString()
        }
      }));

      await dataProvider.updateProductVariantPatchBulk(patches);

      const updatedCosts = { ...costState };
      variants.forEach(v => {
        updatedCosts[v.id] = val;
      });
      setCostState(updatedCosts);
      localStorage.setItem(lsKey, JSON.stringify(updatedCosts));
      setVariants(variants.map(v => ({ ...v, [costField]: val })));
      setBulkMasterPrice('');
      alert('已成功更新所有規格預設單價！');
    } catch (err: any) {
      console.error('批量更新失敗：', err);
      alert(`更新失敗！資料已回復到更新前的狀態。`);
    } finally {
      setIsApplyingMasterCost(false);
    }
  };

  const handleApplyMasterCostToCategory = async () => {
    if (isApplyingMasterCost) return;
    if (!bulkMasterCategory) {
      alert('請先選擇分類！');
      return;
    }
    const val = bulkMasterPrice === '' ? null : parseInt(bulkMasterPrice);
    if (val === null || isNaN(val) || val < 0) {
      alert('請輸入有效的單價金額！');
      return;
    }

    const targetVariants = variants.filter(v => {
      const catTitle = parsedVariantsMap.get(v.id)?.categoryTitle || '';
      return catTitle === bulkMasterCategory;
    });

    if (targetVariants.length === 0) {
      alert('此分類下無任何商品規格！');
      return;
    }

    const costField = isDaili ? 'default_twd_cost' : 'default_jpy_cost';
    const costState = isDaili ? variantDefaultTwdCosts : variantDefaultJpyCosts;
    const setCostState = isDaili ? setVariantDefaultTwdCosts : setVariantDefaultJpyCosts;
    const lsKey = isDaili ? 'variant_default_twd_costs' : 'variant_default_jpy_costs';

    if (!confirm(`確定要將分類「${bulkMasterCategory}」下共 ${targetVariants.length} 個規格的預設單價設為 ${isDaili ? 'NT$' : '¥'} ${val} 嗎？`)) {
      return;
    }

    setIsApplyingMasterCost(true);
    try {
      const patches = targetVariants.map(v => ({
        id: v.id,
        patch: {
          [costField]: val,
          updated_at: new Date().toISOString()
        }
      }));

      await dataProvider.updateProductVariantPatchBulk(patches);

      const updatedCosts = { ...costState };
      targetVariants.forEach(v => {
        updatedCosts[v.id] = val;
      });
      setCostState(updatedCosts);
      localStorage.setItem(lsKey, JSON.stringify(updatedCosts));
      
      const targetIds = new Set(targetVariants.map(v => v.id));
      setVariants(variants.map(v => targetIds.has(v.id) ? { ...v, [costField]: val } : v));
      setBulkMasterPrice('');
      alert(`已成功更新分類「${bulkMasterCategory}」下的預設單價！`);
    } catch (err: any) {
      console.error('分類批量更新失敗：', err);
      alert(`更新失敗！資料已回復到更新前的狀態。`);
    } finally {
      setIsApplyingMasterCost(false);
    }
  };

  if (!group) return <div className="p-xl text-center text-muted">載入中...</div>;

  // Grouping Variants by Category or Single Item
  // KPI Calculations
  let totalShortage = 0;
  let totalExcess = 0;
  let totalPurchased = 0;
  let totalDemand = 0;
  let jpyNeedToBuy = 0;
  let jpyPurchased = 0;

  // Daili specific metric variables
  let dailiTotalOrderAmount = 0;
  let dailiNeedToBuyCost = 0;
  let dailiPurchasedCost = 0;

  const isDaili = group?.listing_type === '代理版';

  const batchMap = new Map(purchaseBatches.map(b => [b.id, b]));

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

  variants.forEach(v => {
    const { totalDemand: vTotalDemand, purchased: vPurchased } = getVariantDemands(v);
    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
    totalDemand += vTotalDemand;
    totalPurchased += vPurchased;
    
    const needToBuy = Math.max(vTotalDemand - vPurchased, 0);
    const excessBuy = Math.max(vPurchased - vTotalDemand, 0);

    totalShortage += needToBuy;
    totalExcess += excessBuy;

    // JPY Standard
    const defaultCost = getVariantDefaultJpyCost(v);
    const latestCost = getLatestBatchCost(v.id);
    const activeCost = (defaultCost !== undefined && defaultCost !== null) ? defaultCost : (latestCost || 0);
    jpyNeedToBuy += needToBuy * activeCost;
    jpyPurchased += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);

    // Daili TWD
    const invItem = inventoryMap.get(v.myacg_item_code);
    const finalPrice = invItem?.final_price ?? 0;
    dailiTotalOrderAmount += vTotalDemand * finalPrice;

    const defaultTwdCost = getVariantDefaultTwdCost(v);
    const latestTwdCost = getLatestBatchCost(v.id);
    const activeTwdCost = (defaultTwdCost !== undefined && defaultTwdCost !== null) ? defaultTwdCost : (latestTwdCost || 0);
    dailiNeedToBuyCost += needToBuy * activeTwdCost;
    dailiPurchasedCost += vBatchItems.reduce((sum, item) => sum + (item.quantity * (item.cost || 0)), 0);
  });

  const jpyTotalDemand = jpyNeedToBuy + jpyPurchased;

  const dailiTotalCost = dailiNeedToBuyCost + dailiPurchasedCost;
  const dailiGrossProfit = dailiTotalOrderAmount - dailiTotalCost;



  let totalOrdersAmount = 0;
  salesOrderItems.forEach(i => {
    if (i.order_status !== '已取消' && i.order_status !== 'CANCELED') {
      if (typeof i.amount === 'number') {
        totalOrdersAmount += i.amount;
      } else {
        totalOrdersAmount += (i.quantity * (i.price || 0));
      }
    }
  });



  const compareNatural = (a: string, b: string) => {
    return (a || '').localeCompare(b || '', undefined, { numeric: true, sensitivity: 'base' });
  };

  interface ParsedVariant {
    categoryTitle: string | null;
    variantDisplayName: string;
  }

  const parseVariantFallback = (v: ProductVariant, categoryMap: Map<string, ProductCategory>): ParsedVariant => {
    // Rule 1: product_category_id exists
    if (v.product_category_id) {
      const cat = categoryMap.get(v.product_category_id);
      if (cat) {
        return {
          categoryTitle: cat.title,
          variantDisplayName: v.variant_name
        };
      }
    }

    // Rule 2: parse from variant_name or raw_variant_name
    const name = (v.variant_name || v.raw_variant_name || '').trim();
    
    // Check pattern "分類名稱 - 分類名稱 角色名" or "分類名稱 - 角色名"
    if (name.includes(' - ')) {
      const parts = name.split(' - ');
      const prefix = parts[0].trim();
      let rest = parts.slice(1).join(' - ').trim();
      if (rest.startsWith(prefix)) {
        let sub = rest.slice(prefix.length).trim();
        // Remove any leading dash/separator
        if (sub.startsWith('-') || sub.startsWith('_') || sub.startsWith('—')) {
          sub = sub.slice(1).trim();
        }
        return {
          categoryTitle: prefix,
          variantDisplayName: sub || rest
        };
      }
      return {
        categoryTitle: prefix,
        variantDisplayName: rest
      };
    }

    // Check pattern with whitespace: "分類名稱 角色名"
    const whitespaceRegex = /\s+/;
    if (whitespaceRegex.test(name)) {
      const parts = name.split(whitespaceRegex);
      const prefix = parts[0].trim();
      const rest = parts.slice(1).join(' ').trim();
      if (prefix && rest) {
        return {
          categoryTitle: prefix,
          variantDisplayName: rest
        };
      }
    }

    // Fallback: no category parsed
    return {
      categoryTitle: null,
      variantDisplayName: name
    };
  };

  // Pre-parse variants locally for UI fallback grouping
  const parsedVariantsMap = new Map<string, ParsedVariant>();
  variants.forEach(v => {
    parsedVariantsMap.set(v.id, parseVariantFallback(v, categoryMap));
  });

  const categoryCountMap = new Map<string, number>();
  variants.forEach(v => {
    const parsed = parsedVariantsMap.get(v.id);
    if (parsed && parsed.categoryTitle) {
      categoryCountMap.set(parsed.categoryTitle, (categoryCountMap.get(parsed.categoryTitle) || 0) + 1);
    }
  });

  const getVariantDisplayLabel = (v: ProductVariant) => {
    const dispName = (parsedVariantsMap.get(v.id)?.variantDisplayName || v.variant_name || '').trim();
    if (dispName) return dispName;

    const isSingleVariant = variants.length === 1;
    const hasNoCategory = !v.product_category_id;

    if (isSingleVariant || hasNoCategory) {
      return group?.normalized_title || group?.title || '單品';
    }

    return '單品';
  };

  const renderMobileVariantCard = (v: ProductVariant) => {
    const { myacgDemand, wacaDemand, privateDemand } = getVariantDemands(v);
    const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);

    const title = isDaili ? getDisplayProductName(v) : getVariantDisplayLabel(v);

    return (
      <div 
        key={v.id} 
        style={{ 
          padding: '10px 12px', 
          backgroundColor: '#fff',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          boxSizing: 'border-box'
        }}
      >
        {/* Title */}
        <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>
          <HighlightText text={title} highlight={searchTerm} />
        </div>

        {/* Sources */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>來源：</span>
          <div style={{ display: 'flex', gap: '16px' }}>
            <span style={{ fontSize: '12px', color: '#334155' }}>
              買動漫 <span style={{ fontWeight: 700, color: myacgDemand > 0 ? '#2563eb' : '#64748b' }}>{myacgDemand}</span>
            </span>
            <span style={{ fontSize: '12px', color: '#334155' }}>
              WACA <span style={{ fontWeight: 700, color: wacaDemand > 0 ? '#2563eb' : '#64748b' }}>{wacaDemand}</span>
            </span>
            <span style={{ fontSize: '12px', color: '#334155' }}>
              私下 <span style={{ fontWeight: 700, color: privateDemand > 0 ? '#2563eb' : '#64748b' }}>{privateDemand}</span>
            </span>
          </div>
        </div>

        {/* Batches */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>批次：</span>
          {vBatchItems.length === 0 ? (
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>無</span>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              {vBatchItems.map(pbi => {
                const batch = batchMap.get(pbi.purchase_batch_id);
                let displayDate = batch?.date || batch?.name || '未知';
                if (batch?.date && batch.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
                  const parts = batch.date.split('-');
                  displayDate = `${parts[1]}/${parts[2]}`;
                }
                return (
                  <span key={pbi.id} style={{ fontSize: '12px', color: '#334155' }}>
                    {displayDate} <span style={{ fontWeight: 700, color: '#0f172a' }}>×{pbi.quantity}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  const groupedVariants: Record<string, ProductVariant[]> = {};
  variants.forEach(v => {
    const parsed = parsedVariantsMap.get(v.id);
    let groupKey = '';
    // ProductCategory/parsed category exists and has variants count > 1 globally
    if (parsed && parsed.categoryTitle && (categoryCountMap.get(parsed.categoryTitle) || 0) > 1) {
      groupKey = `category:${parsed.categoryTitle}`;
    } else {
      groupKey = `__single__${v.id}`;
    }
    
    if (!groupedVariants[groupKey]) groupedVariants[groupKey] = [];
    groupedVariants[groupKey].push(v);
  });

  Object.values(groupedVariants).forEach(groupItems => {
    groupItems.sort((a, b) => {
      const valA = getSortVal(a);
      const valB = getSortVal(b);
      if (valA !== valB) return valA - valB;
      return compareNatural(a.myacg_item_code, b.myacg_item_code);
    });
  });

  const getGroupSortOrder = (_key: string, items: ProductVariant[]) => {
    const itemSorts = items
      .map(v => getSortVal(v))
      .filter(n => Number.isFinite(n));

    if (itemSorts.length > 0) {
      return Math.min(...itemSorts);
    }

    return 999999;
  };

  const getGroupMinSku = (items: ProductVariant[]) => {
    return items
      .map(v => v.myacg_item_code || '')
      .filter(Boolean)
      .sort(compareNatural)[0] || '';
  };

  // Debug table logging
  const debugInfo = Object.entries(groupedVariants).map(([key, items]) => {
    const isCat = key.startsWith('category:');
    const title = isCat ? key.slice('category:'.length) : (items[0]?.raw_variant_name || items[0]?.variant_name || '');
    return {
      key,
      title,
      minSku: getGroupMinSku(items),
      sortOrder: getGroupSortOrder(key, items),
      isCategory: isCat,
      itemCount: items.length
    };
  });
  console.table(debugInfo);

  let sortedGroupEntries = Object.entries(groupedVariants).sort(([, itemsA], [, itemsB]) => {
    const sortA = Math.min(...itemsA.map(x => getSortVal(x)));
    const sortB = Math.min(...itemsB.map(x => getSortVal(x)));
    if (sortA !== sortB) return sortA - sortB;

    const skuA = getGroupMinSku(itemsA);
    const skuB = getGroupMinSku(itemsB);
    return compareNatural(skuA, skuB);
  });

  if (sortMode === 'shortage') {
    sortedGroupEntries = sortedGroupEntries.sort(([, itemsA], [, itemsB]) => {
      const getShortage = (items: ProductVariant[]) => items.reduce((sum, v) => {
        const { totalDemand, purchased } = getVariantDemands(v);
        return sum + Math.max(totalDemand - purchased, 0);
      }, 0);
      return getShortage(itemsB) - getShortage(itemsA);
    });
  }

  const costSample = variants.find(v => (v.default_jpy_cost !== undefined && v.default_jpy_cost !== null) || (v.default_twd_cost !== undefined && v.default_twd_cost !== null)) || variants[0];
  console.log('[Default Cost Sync] UI render sample:', costSample ? { id: costSample.id, default_jpy_cost: costSample.default_jpy_cost, default_twd_cost: costSample.default_twd_cost } : 'empty');



  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f4f5f7', display: 'flex', flexDirection: 'column' }}>
      
      {/* Top Breadcrumb & Title Area */}
      <div style={{ backgroundColor: '#fff', padding: '16px 24px', borderBottom: '1px solid #e5e7eb' }}>
        <div className="flex items-center gap-sm text-muted text-sm" style={{ marginBottom: '12px' }}>
          <button className="btn btn-ghost" style={{ padding: 0 }} onClick={() => navigate('/purchase-records')}>
            <ArrowLeft size={16} />
          </button>
          <span>團務與商品管理</span>
          <span>/</span>
          <span className="text-primary font-medium">{group.normalized_title || cleanDailiTitle(group.title) || group.title}</span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#111827', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isDaili ? cleanDailiTitle(group.normalized_title || group.title) : (group.normalized_title || group.title)}
            {group.listing_type && (
              <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '12px', padding: '2px 8px', borderRadius: '4px', fontWeight: 500 }}>
                {group.listing_type}
              </span>
            )}
          </h1>
        </div>
      </div>

      <div style={{ padding: '24px', paddingBottom: isMobile ? '80px' : '24px', flex: 1, display: 'flex', flexDirection: 'column', maxWidth: '1600px', margin: '0 auto', width: '100%' }}>
        
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
              <span style={{ color: '#92400e', fontWeight: 500 }}>資料已在其他分頁更新，請重新整理後再編輯。</span>
            </div>
            <button
              onClick={handleReloadData}
              style={{
                backgroundColor: '#d97706',
                color: '#ffffff',
                border: 'none',
                padding: '6px 12px',
                borderRadius: '4px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                marginLeft: 'auto',
                transition: 'background-color 0.2s'
              }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#b45309'}
              onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#d97706'}
            >
              重新載入最新資料
            </button>
          </div>
        )}

        {/* Top Summary Cards */}
        {activeTab === 'worksheet' && (
          isMobile ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '16px' }}>
              {/* Total Demand */}
              <div className="card" style={{ padding: '12px 14px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>總需求</div>
                  <Package size={16} color="#64748b" />
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '2px' }}>
                  <span style={{ fontSize: '18px', fontWeight: 700, color: '#1e293b' }}>{totalDemand}</span>
                  <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '2px' }}>件</span>
                </div>
              </div>

              {/* Total Purchased */}
              <div className="card" style={{ padding: '12px 14px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>已採購</div>
                  <CheckSquare size={16} color="#2563eb" />
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '2px' }}>
                  <span style={{ fontSize: '18px', fontWeight: 700, color: '#2563eb' }}>{totalPurchased}</span>
                  <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '2px' }}>件</span>
                </div>
              </div>

              {/* Total Shortage */}
              <div className="card" style={{ padding: '12px 14px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>待採購</div>
                  <AlertTriangle size={16} color="#ef4444" />
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '2px' }}>
                  <span style={{ fontSize: '18px', fontWeight: 700, color: '#ef4444' }}>{totalShortage}</span>
                  <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '2px' }}>件</span>
                </div>
              </div>

              {/* Total Excess */}
              <div className="card" style={{ padding: '12px 14px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>多買</div>
                  <RefreshCw size={16} color="#f97316" />
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '2px' }}>
                  <span style={{ fontSize: '18px', fontWeight: 700, color: '#f97316' }}>{totalExcess}</span>
                  <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '2px' }}>件</span>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '24px' }}>
              
              {/* Total Shortage */}
              <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總缺貨數</div>
                  <AlertTriangle size={20} color="#ef4444" />
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: isMobile ? '22px' : '28px', fontWeight: 700, color: '#ef4444' }}>{totalShortage}</span>
                  <span style={{ fontSize: '13px', color: '#64748b' }}>件</span>
                </div>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>需採購補齊</div>
              </div>

              {/* Total Excess */}
              <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總多買數</div>
                  <RefreshCw size={20} color="#f97316" />
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: isMobile ? '22px' : '28px', fontWeight: 700, color: '#f97316' }}>{totalExcess}</span>
                  <span style={{ fontSize: '13px', color: '#64748b' }}>件</span>
                </div>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>數量過多</div>
              </div>

              {/* Total Demand */}
              <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總需求數</div>
                  <Package size={20} color="#64748b" />
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: isMobile ? '22px' : '28px', fontWeight: 700, color: '#1e293b' }}>{totalDemand}</span>
                  <span style={{ fontSize: '13px', color: '#64748b' }}>件</span>
                </div>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>所有需求加總</div>
              </div>

              {/* Total Amount (Orders NTD) */}
              <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>訂單總金額</div>
                  <DollarSign size={20} color="#10b981" />
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: isMobile ? '20px' : '28px', fontWeight: 700, color: '#1e293b' }}>{(isDaili ? dailiTotalOrderAmount : totalOrdersAmount).toLocaleString()}</span>
                  <span style={{ fontSize: '13px', color: '#64748b' }}>NT$</span>
                </div>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{isDaili ? '總需求數量 × 買動漫售價' : '訂單商品總額'}</div>
              </div>

              {isDaili ? (
                <>
                  {/* 待採購成本 */}
                  <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>待採購成本</div>
                      <DollarSign size={20} color="#ef4444" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                      <span style={{ fontSize: isMobile ? '18px' : '28px', fontWeight: 700, color: '#ef4444' }}>NT$ {dailiNeedToBuyCost.toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>缺少數量 × 台幣成本</div>
                  </div>

                  {/* 已採購成本 */}
                  <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>已採購成本</div>
                      <CheckSquare size={20} color="#2563eb" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                      <span style={{ fontSize: isMobile ? '18px' : '28px', fontWeight: 700, color: '#2563eb' }}>NT$ {dailiPurchasedCost.toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>採購批次已付台幣成本</div>
                  </div>

                  {/* 總成本 */}
                  <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總成本</div>
                      <Package size={20} color="#16a34a" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                      <span style={{ fontSize: isMobile ? '18px' : '28px', fontWeight: 700, color: '#16a34a' }}>NT$ {dailiTotalCost.toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>待採購成本 + 已採購成本</div>
                  </div>

                  {/* 預估毛利 */}
                  <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>預估毛利</div>
                      <DollarSign size={20} color="#ca8a04" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                      <span style={{ fontSize: isMobile ? '18px' : '28px', fontWeight: 700, color: '#ca8a04' }}>NT$ {dailiGrossProfit.toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>訂單總金額 - 總成本</div>
                  </div>
                </>
              ) : (
                <>
                  {/* 1. 待採購日幣 */}
                  <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>待採購日幣</div>
                      <DollarSign size={20} color="#ef4444" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                      <span style={{ fontSize: '28px', fontWeight: 700, color: '#ef4444' }}>¥ {jpyNeedToBuy.toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>目前還要花多少日幣</div>
                  </div>

                  {/* 2. 已採購日幣 */}
                  <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>已採購日幣</div>
                      <CheckSquare size={20} color="#2563eb" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                      <span style={{ fontSize: '28px', fontWeight: 700, color: '#2563eb' }}>¥ {jpyPurchased.toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>目前已花掉多少日幣</div>
                  </div>

                  {/* 3. 總需求日幣 */}
                  <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>總需求日幣</div>
                      <Package size={20} color="#16a34a" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                      <span style={{ fontSize: '28px', fontWeight: 700, color: '#16a34a' }}>¥ {jpyTotalDemand.toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>整批商品總成本(日幣)</div>
                  </div>

                  {/* 4. 已購買數量 */}
                  <div className="card" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', backgroundColor: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#475569' }}>已購買數量</div>
                      <CheckSquare size={20} color="#ca8a04" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                      <span style={{ fontSize: '28px', fontWeight: 700, color: '#ca8a04' }}>{totalPurchased} 件</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>所有規格已採購件數加總</div>
                  </div>
                </>
              )}
            </div>
          )
        )}

        {/* Tab Header */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          marginBottom: '16px', 
          width: '100%', 
          maxWidth: '100%',
          overflowX: 'auto', 
          WebkitOverflowScrolling: 'touch'
        }}>
          <div style={{ 
            display: 'flex', 
            backgroundColor: '#e2e8f0', 
            padding: '4px', 
            borderRadius: '8px', 
            marginRight: 'auto',
            width: 'max-content',
            flexShrink: 0
          }}>
            <div 
              style={{ 
                padding: '8px 16px', 
                cursor: 'pointer', 
                fontWeight: 600, 
                fontSize: '14px', 
                borderRadius: '6px', 
                color: activeTab === 'worksheet' ? '#1e293b' : '#64748b', 
                backgroundColor: activeTab === 'worksheet' ? '#fff' : 'transparent', 
                boxShadow: activeTab === 'worksheet' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none', 
                whiteSpace: 'nowrap',
                flex: '0 0 auto'
              }}
              onClick={() => setActiveTab('worksheet')}
            >代購工作規格表</div>
            <div 
              style={{ 
                padding: '8px 16px', 
                cursor: 'pointer', 
                fontWeight: 600, 
                fontSize: '14px', 
                borderRadius: '6px', 
                color: activeTab === 'purchase_batches' ? '#1e293b' : '#64748b', 
                backgroundColor: activeTab === 'purchase_batches' ? '#fff' : 'transparent', 
                boxShadow: activeTab === 'purchase_batches' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none', 
                whiteSpace: 'nowrap',
                flex: '0 0 auto'
              }}
              onClick={() => setActiveTab('purchase_batches')}
            >採購批次紀錄</div>
            <div 
              style={{ 
                padding: '8px 16px', 
                cursor: 'pointer', 
                fontWeight: 600, 
                fontSize: '14px', 
                borderRadius: '6px', 
                color: activeTab === 'private_orders' ? '#1e293b' : '#64748b', 
                backgroundColor: activeTab === 'private_orders' ? '#fff' : 'transparent', 
                boxShadow: activeTab === 'private_orders' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none', 
                whiteSpace: 'nowrap',
                flex: '0 0 auto'
              }}
              onClick={() => setActiveTab('private_orders')}
            >私下登記紀錄</div>
          </div>
        </div>

        {/* Toolbar */}
        {activeTab === 'worksheet' && (
          isMobile ? (
            <div style={{ 
              display: 'flex', 
              flexDirection: 'column',
              gap: '8px',
              marginBottom: '12px', 
              padding: '12px', 
              backgroundColor: '#fff', 
              borderRadius: '8px', 
              border: '1px solid #e5e7eb', 
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)' 
            }}>
              {/* Row 1: Mode Toggle Buttons */}
              <div style={{ display: 'flex', backgroundColor: '#f1f5f9', padding: '3px', borderRadius: '6px', width: '100%', boxSizing: 'border-box' }}>
                <div 
                  style={{ flex: 1, textAlign: 'center', padding: '6px 0', cursor: 'pointer', fontWeight: 600, fontSize: '13px', borderRadius: '4px', color: filterMode === 'all' ? '#1e293b' : '#64748b', backgroundColor: filterMode === 'all' ? '#fff' : 'transparent', boxShadow: filterMode === 'all' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none' }}
                  onClick={() => setFilterMode('all')}
                >顯示全部商品</div>
                <div 
                  style={{ flex: 1, textAlign: 'center', padding: '6px 0', cursor: 'pointer', fontWeight: 600, fontSize: '13px', borderRadius: '4px', color: filterMode === 'abnormal' ? '#2563eb' : '#64748b', backgroundColor: filterMode === 'abnormal' ? '#fff' : 'transparent', boxShadow: filterMode === 'abnormal' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none' }}
                  onClick={() => setFilterMode('abnormal')}
                >缺貨採購模式</div>
              </div>

              {/* Row 2: Search bar */}
              <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: '6px', border: '1px solid #cbd5e1', padding: '0 10px', height: '36px', width: '100%', boxSizing: 'border-box' }}>
                <Search size={14} style={{ color: '#64748b', marginRight: '6px' }} />
                <input 
                  type="text" 
                  placeholder="搜尋商品..." 
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  style={{ border: 'none', background: 'transparent', outline: 'none', width: '100%', fontSize: '13px', color: '#334155' }}
                />
              </div>

              {/* Row 3: Action Buttons */}
              <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                <button 
                  className="btn btn-outline" 
                  style={{ 
                    flex: 1,
                    fontSize: '12px', 
                    padding: '0', 
                    height: '32px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: '#fdf2f8', 
                    color: '#db2777', 
                    borderColor: '#fbcfe8',
                    opacity: editMode ? 1 : 0.6,
                    cursor: editMode ? 'pointer' : 'not-allowed',
                    whiteSpace: 'nowrap'
                  }}
                  disabled={!editMode}
                  onClick={openPrivateOrderModal}
                >
                  <Plus size={12} style={{ marginRight: '4px' }} /> 私下登記
                </button>
                <button 
                  className="btn btn-outline" 
                  style={{ 
                    flex: 1,
                    fontSize: '12px', 
                    padding: '0', 
                    height: '32px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: '#eff6ff', 
                    color: '#2563eb', 
                    borderColor: '#bfdbfe',
                    opacity: editMode ? 1 : 0.6,
                    cursor: editMode ? 'pointer' : 'not-allowed',
                    whiteSpace: 'nowrap'
                  }}
                  disabled={!editMode}
                  onClick={openBatchModal}
                >
                  <Plus size={12} style={{ marginRight: '4px' }} /> 新增採購批次
                </button>
              </div>
            </div>
          ) : (
            <div style={{ 
              display: 'flex', 
              flexDirection: 'column',
              gap: '12px',
              overflow: 'visible',
              marginBottom: '16px', 
              padding: '16px', 
              backgroundColor: '#fff', 
              borderRadius: '12px', 
              border: '1px solid #e5e7eb', 
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)' 
            }}>
              {/* Row 1: Controls (Sort / Rate / Search / Actions) */}
              <div style={{
                display: 'flex',
                flexDirection: isMobile ? 'column' : 'row',
                alignItems: isMobile ? 'stretch' : 'center',
                gap: '12px',
                flexWrap: isMobile ? 'wrap' : 'nowrap',
                width: '100%',
                flexShrink: 0
              }}>
                {/* Mode Toggle Buttons */}
                <div style={{ display: 'flex', justifyContent: isMobile ? 'center' : 'flex-start', flexShrink: 0 }}>
                  <div style={{ display: 'flex', backgroundColor: '#f1f5f9', padding: '4px', borderRadius: '8px', width: isMobile ? '100%' : 'auto' }}>
                    <div 
                      style={{ flex: isMobile ? 1 : 'none', textAlign: 'center', padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', borderRadius: '6px', color: filterMode === 'all' ? '#1e293b' : '#64748b', backgroundColor: filterMode === 'all' ? '#fff' : 'transparent', boxShadow: filterMode === 'all' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none' }}
                      onClick={() => setFilterMode('all')}
                    >顯示全部商品</div>
                    <div 
                      style={{ flex: isMobile ? 1 : 'none', textAlign: 'center', padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', borderRadius: '6px', color: filterMode === 'abnormal' ? '#2563eb' : '#64748b', backgroundColor: filterMode === 'abnormal' ? '#fff' : 'transparent', boxShadow: filterMode === 'abnormal' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none' }}
                      onClick={() => setFilterMode('abnormal')}
                    >缺貨採購模式</div>
                  </div>
                </div>

                {!isMobile && <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0', flexShrink: 0 }}></div>}

                {/* Sort select */}
                <select 
                  className="input" 
                  style={{ width: isMobile ? '100%' : '200px', height: '36px', fontSize: '13px', padding: '0 12px', flexShrink: 0 }}
                  value={sortMode}
                  onChange={e => setSortMode(e.target.value as 'catalog' | 'shortage')}
                >
                  <option value="catalog">依商品主檔順序排序</option>
                  <option value="shortage">依缺貨多寡排序</option>
                </select>

                {!isMobile && <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0', flexShrink: 0 }}></div>}

                {/* Exchange rate input */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: isMobile ? '100%' : 'auto', flexShrink: 0 }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', whiteSpace: 'nowrap' }}>設定匯率:</span>
                  <input 
                    type="text" 
                    inputMode="decimal"
                    pattern="[0-9.]*"
                    className="input" 
                    style={{ flex: isMobile ? 1 : 'none', width: isMobile ? 'auto' : '80px', height: '36px', fontSize: '13px', padding: '0 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '6px' }}
                    value={exchangeRateInput}
                    onChange={e => {
                      const valStr = e.target.value.replace(/[^0-9.]/g, '');
                      const parts = valStr.split('.');
                      const cleanVal = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : valStr;
                      setExchangeRateInput(cleanVal);
                      if (cleanVal && !cleanVal.endsWith('.')) {
                        const val = parseFloat(cleanVal) || 0;
                        setExchangeRate(val);
                        localStorage.setItem('erp_exchange_rate', String(val));
                      }
                    }}
                  />
                </div>

                {!isMobile && <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0', flexShrink: 0 }}></div>}

                {/* Search bar */}
                <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: '6px', border: '1px solid #cbd5e1', padding: '0 12px', height: '36px', width: isMobile ? '100%' : '200px', flexShrink: 0 }}>
                  <Search size={16} style={{ color: '#64748b', marginRight: '8px' }} />
                  <input 
                    type="text" 
                    placeholder="搜尋商品..." 
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    style={{ border: 'none', background: 'transparent', outline: 'none', width: '100%', fontSize: '13px', color: '#334155' }}
                  />
                </div>

                {!isMobile && <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0', flexShrink: 0 }}></div>}

                {/* Action Buttons */}
                <div style={{ display: 'flex', gap: '8px', width: isMobile ? '100%' : 'auto', flexWrap: isMobile ? 'wrap' : 'nowrap', flexShrink: 0 }}>
                  {canWrite && (
                    <button 
                      className="btn btn-outline" 
                      style={{ 
                        flex: isMobile ? 1 : 'none',
                        fontSize: '13px', 
                        padding: '6px 12px', 
                        height: '36px',
                        backgroundColor: '#f0fdf4', 
                        color: '#16a34a', 
                        borderColor: '#bbf7d0',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap'
                      }}
                      onClick={handleCopyAllGroupPurchasedLedger}
                    >
                      <Copy size={14} style={{ display: 'inline-block', marginRight: '4px' }} /> 複製已採購帳目
                    </button>
                  )}
                  <button 
                    className="btn btn-outline" 
                    style={{ 
                      flex: isMobile ? 1 : 'none',
                      fontSize: '13px', 
                      padding: '6px 12px', 
                      height: '36px',
                      backgroundColor: '#fdf2f8', 
                      color: '#db2777', 
                      borderColor: '#fbcfe8',
                      opacity: editMode ? 1 : 0.6,
                      cursor: editMode ? 'pointer' : 'not-allowed',
                      whiteSpace: 'nowrap'
                    }}
                    disabled={!editMode}
                    onClick={openPrivateOrderModal}
                  >
                    <Plus size={14} style={{ display: 'inline-block', marginRight: '4px' }} /> 私下登記
                  </button>
                  <button 
                    className="btn btn-outline" 
                    style={{ 
                      flex: isMobile ? 1 : 'none',
                      fontSize: '13px', 
                      padding: '6px 12px', 
                      height: '36px',
                      backgroundColor: '#eff6ff', 
                      color: '#2563eb', 
                      borderColor: '#bfdbfe',
                      opacity: editMode ? 1 : 0.6,
                      cursor: editMode ? 'pointer' : 'not-allowed',
                      whiteSpace: 'nowrap'
                    }}
                    disabled={!editMode}
                    onClick={openBatchModal}
                  >
                    <Plus size={14} style={{ display: 'inline-block', marginRight: '4px' }} /> 新增採購批次
                  </button>
                  {canWrite && (
                    <button 
                      className="btn btn-outline" 
                      style={{ 
                        flex: isMobile ? 1 : 'none',
                        fontSize: '13px', 
                        padding: '6px 12px', 
                        height: '36px',
                        backgroundColor: '#f8fafc', 
                        color: '#475569', 
                        borderColor: '#cbd5e1',
                        opacity: editMode ? 1 : 0.6,
                        cursor: editMode ? 'pointer' : 'not-allowed',
                        whiteSpace: 'nowrap'
                      }}
                      disabled={!editMode}
                      onClick={handleAddNewVariant}
                    >
                      <Plus size={14} style={{ display: 'inline-block', marginRight: '4px' }} /> 新增規格
                    </button>
                  )}
                </div>
              </div>

              {/* Divider & Row 2: Bulk Master Cost Settings */}
              {editMode && canWrite && (
                <>
                  <div style={{ height: '1px', backgroundColor: '#e2e8f0', margin: '4px 0', flexShrink: 0 }} />
                  <div style={{ 
                    display: 'flex', 
                    flexDirection: isMobile ? 'column' : 'row', 
                    alignItems: isMobile ? 'stretch' : 'center', 
                    gap: '12px', 
                    flexWrap: isMobile ? 'wrap' : 'nowrap',
                    flexShrink: 0,
                    width: '100%'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569', whiteSpace: 'nowrap' }}>批量價格設定:</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      <span style={{ fontSize: '13px', color: '#64748b' }}>單價:</span>
                      <span style={{ fontSize: '13px', color: '#64748b', fontWeight: 600 }}>{isDaili ? 'NT$' : '¥'}</span>
                      <input 
                        type="text" 
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="輸入金額" 
                        className="input"
                        value={bulkMasterPrice}
                        onChange={e => {
                          const val = e.target.value.replace(/[^0-9]/g, '');
                          setBulkMasterPrice(val);
                        }}
                        disabled={isApplyingMasterCost}
                        style={{ width: '100px', height: '32px', padding: '0 8px', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: isApplyingMasterCost ? '#f1f5f9' : '#fff', cursor: isApplyingMasterCost ? 'not-allowed' : 'text' }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      <span style={{ fontSize: '13px', color: '#64748b' }}>分類:</span>
                      <select
                        id="bulk-master-category-select"
                        className="input"
                        value={bulkMasterCategory}
                        onChange={e => setBulkMasterCategory(e.target.value)}
                        disabled={isApplyingMasterCost}
                        style={{ width: '150px', height: '32px', padding: '0 4px', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: isApplyingMasterCost ? '#f1f5f9' : '#fff', cursor: isApplyingMasterCost ? 'not-allowed' : 'pointer' }}
                      >
                        <option value="">-- 選擇分類 --</option>
                        {(Array.from(new Set(variants.map(v => parsedVariantsMap.get(v.id)?.categoryTitle).filter(Boolean))) as string[]).map(cat => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                    </div>
                    <button 
                      type="button" 
                      className="btn btn-outline" 
                      onClick={handleApplyMasterCostToCategory}
                      disabled={isApplyingMasterCost}
                      style={{ padding: '0 12px', height: '32px', fontSize: '12px', borderRadius: '4px', border: '1px solid #cbd5e1', cursor: isApplyingMasterCost ? 'not-allowed' : 'pointer', backgroundColor: '#fff', opacity: isApplyingMasterCost ? 0.6 : 1, flexShrink: 0 }}
                    >
                      {isApplyingMasterCost ? '套用中...' : '套用單價至選取分類'}
                    </button>
                    <button 
                      type="button" 
                      className="btn btn-outline" 
                      onClick={handleApplyMasterCostToAll}
                      disabled={isApplyingMasterCost}
                      style={{ padding: '0 12px', height: '32px', fontSize: '12px', borderRadius: '4px', border: '1px solid #cbd5e1', cursor: isApplyingMasterCost ? 'not-allowed' : 'pointer', backgroundColor: '#fff', opacity: isApplyingMasterCost ? 0.6 : 1, flexShrink: 0 }}
                    >
                      {isApplyingMasterCost ? '套用中...' : '套用單價至全部品項'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        )}

        {/* Card List Area (Standard Mode) */}
        {activeTab === 'worksheet' && filterMode === 'all' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, paddingBottom: '40px' }}>
            {sortedGroupEntries.filter(([groupKey, groupItems]) => {
              // 1. Search Filter
              if (searchTerm) {
                const lowerSearch = searchTerm.toLowerCase();
                const catTitle = groupKey.startsWith('category:') 
                  ? (isDaili ? cleanDailiTitle(groupKey.slice('category:'.length)) : groupKey.slice('category:'.length))
                  : getDisplayProductName(groupItems[0]);
                const groupMatch = catTitle.toLowerCase().includes(lowerSearch);
                const hasMatch = groupItems.some(v => 
                  (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                  (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                );
                if (!groupMatch && !hasMatch) return false;
              }

              return true;

            }).map(([groupKey, groupItems]) => {
              const catTitle = groupKey.startsWith('category:') 
                ? (isDaili ? cleanDailiTitle(groupKey.slice('category:'.length)) : groupKey.slice('category:'.length))
                : getDisplayProductName(groupItems[0]);
              
              const lowerSearch = searchTerm.toLowerCase();
              const isSearchMatched = searchTerm.trim() !== '' && (
                catTitle.toLowerCase().includes(lowerSearch) || 
                groupItems.some(v => 
                  (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                  (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                )
              );
              const isExpanded = isSearchMatched ? true : manualExpandedGroups.has(groupKey);
              
              // Compute Group Aggregates
              let pMyacg = 0, pWaca = 0, pManual = 0, pNeed = 0, pExcess = 0, pPurchased = 0, pDemand = 0;
              groupItems.forEach(v => {
                const { myacgDemand, wacaDemand, privateDemand, totalDemand: tDemand, purchased: tPurchased } = getVariantDemands(v);

                pMyacg += myacgDemand;
                pWaca += wacaDemand;
                pManual += privateDemand;
                pDemand += tDemand;
                pPurchased += tPurchased;
                
                pNeed += Math.max(tDemand - tPurchased, 0);
                pExcess += Math.max(tPurchased - tDemand, 0);
              });

              // Decide Border Color
              let borderColor = "#CBD5E1";
              if (pNeed > 0) {
                borderColor = "#F87171";
              } else if (pDemand > 0) {
                borderColor = "#22C55E";
              }

              // SINGLE ITEM RENDERING
              if (groupKey.startsWith('__single__')) {
                const v = groupItems[0];
                
                if (isMobile) {
                  return (
                    <div 
                      key={v.id} 
                      style={{ 
                        border: '1px solid #cbd5e1', 
                        borderRadius: '8px', 
                        overflow: 'hidden', 
                        backgroundColor: '#fff', 
                        marginBottom: '8px',
                        borderLeft: `4px solid ${borderColor}`
                      }}
                    >
                      {renderMobileVariantCard(v)}
                    </div>
                  );
                }
                
                return (
                  <div key={v.id} className="card shadow-sm rounded-lg overflow-hidden bg-white" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden', borderTop: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderLeft: `4px solid ${borderColor}` }}>
                    <ScrollWrapper isMobile={isMobile}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed', minWidth: isMobile ? '800px' : undefined }}>
                      {isDaili ? (
                        <>
                          <colgroup>
                            <col style={{ width: '30%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '12%' }} />
                            <col style={{ width: '9%' }} />
                            <col style={{ width: '9%' }} />
                            <col style={{ width: '9%' }} />
                            <col style={{ width: '9%' }} />
                          </colgroup>
                          <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                            <tr>
                              <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫售價</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>成本</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                            </tr>
                          </thead>
                        </>
                      ) : (
                        <>
                          <colgroup>
                            <col style={{ width: '30%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '13%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '12%' }} />
                            <col style={{ width: '12%' }} />
                          </colgroup>
                          <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                            <tr>
                              <th style={{ padding: '8px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>單價</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                            </tr>
                          </thead>
                        </>
                      )}
                      <tbody>
                        <tr>
                           <td style={{ padding: '10px 20px', textAlign: 'left' }}>
                            {editMode && canWrite && v.source === 'manual' ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
                                <input 
                                  type="text" 
                                  value={v.variant_name || ''} 
                                  onChange={e => handleManualFieldChange(v.id, 'variant_name', e.target.value)}
                                  onFocus={e => handleManualFieldFocus(v.id, 'variant_name', e.target.value)}
                                  onBlur={e => handleManualFieldBlur(v.id, 'variant_name', e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      (e.target as HTMLInputElement).blur();
                                    }
                                  }}
                                  style={{
                                    width: '100%',
                                    height: '28px',
                                    border: '1px solid #cbd5e1',
                                    borderRadius: '4px',
                                    fontSize: '14px',
                                    fontWeight: 700,
                                    color: '#1E293B',
                                    backgroundColor: '#ffffff',
                                    padding: '0 8px'
                                  }}
                                  placeholder="規格名稱"
                                />
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span style={{ fontSize: '11px', color: '#94A3B8' }}>SKU:</span>
                                  <input 
                                    type="text" 
                                    value={v.myacg_item_code || ''} 
                                    onChange={e => handleManualFieldChange(v.id, 'myacg_item_code', e.target.value)}
                                    onFocus={e => handleManualFieldFocus(v.id, 'myacg_item_code', e.target.value)}
                                    onBlur={e => handleManualFieldBlur(v.id, 'myacg_item_code', e.target.value)}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') {
                                        (e.target as HTMLInputElement).blur();
                                      }
                                    }}
                                    style={{
                                      width: '150px',
                                      height: '24px',
                                      border: '1px solid #cbd5e1',
                                      borderRadius: '4px',
                                      fontSize: '11px',
                                      fontWeight: 400,
                                      color: '#1E293B',
                                      backgroundColor: '#ffffff',
                                      padding: '0 6px'
                                    }}
                                    placeholder="可空白"
                                  />
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                                  <span style={{
                                    backgroundColor: '#f1f5f9',
                                    color: '#64748b',
                                    padding: '1px 6px',
                                    borderRadius: '4px',
                                    fontWeight: 600,
                                    fontSize: '10px'
                                  }}>
                                    [手動建立]
                                  </span>
                                  {editMode && canWrite && (
                                    <div style={{ display: 'inline-flex', gap: '6px' }}>
                                      <button 
                                        type="button"
                                        onClick={() => handleMoveVariant(v.id, 'up')} 
                                        disabled={variants.indexOf(v) === 0}
                                        style={{ 
                                          padding: '2px 6px', 
                                          fontSize: '11px', 
                                          cursor: variants.indexOf(v) === 0 ? 'not-allowed' : 'pointer', 
                                          border: '1px solid #cbd5e1', 
                                          borderRadius: '4px', 
                                          backgroundColor: '#f8fafc',
                                          color: variants.indexOf(v) === 0 ? '#cbd5e1' : '#475569',
                                          fontWeight: 500,
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          height: '22px'
                                        }}
                                        title="上移"
                                      >
                                        ↑ 上移
                                      </button>
                                      <button 
                                        type="button"
                                        onClick={() => handleMoveVariant(v.id, 'down')} 
                                        disabled={variants.indexOf(v) === variants.length - 1}
                                        style={{ 
                                          padding: '2px 6px', 
                                          fontSize: '11px', 
                                          cursor: variants.indexOf(v) === variants.length - 1 ? 'not-allowed' : 'pointer', 
                                          border: '1px solid #cbd5e1', 
                                          borderRadius: '4px', 
                                          backgroundColor: '#f8fafc',
                                          color: variants.indexOf(v) === variants.length - 1 ? '#cbd5e1' : '#475569',
                                          fontWeight: 500,
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          height: '22px'
                                        }}
                                        title="下移"
                                      >
                                        ↓ 下移
                                      </button>
                                      <button 
                                        type="button"
                                        onClick={() => handleDeleteVariant(v.id)} 
                                        style={{ 
                                          padding: '2px 6px', 
                                          fontSize: '11px', 
                                          cursor: 'pointer', 
                                          border: '1px solid #fee2e2', 
                                          borderRadius: '4px', 
                                          backgroundColor: '#fef2f2', 
                                          color: '#dc2626',
                                          fontWeight: 500,
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          height: '22px'
                                        }}
                                        title="刪除"
                                      >
                                        刪除
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <>
                                <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={catTitle}>
                                  <HighlightText text={catTitle} highlight={searchTerm} />
                                </div>
                                <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, display: 'flex', alignItems: 'center', gap: '8px' }} title={v.myacg_item_code}>
                                  <span>SKU: <HighlightText text={v.myacg_item_code || '(空白)'} highlight={searchTerm} /></span>
                                  {v.catalog_missing && (
                                    <span style={{
                                      backgroundColor: '#ffedd5',
                                      color: '#ea580c',
                                      padding: '1px 6px',
                                      borderRadius: '4px',
                                      fontWeight: 600,
                                      fontSize: '10px'
                                    }}>
                                      [清單無此項]
                                    </span>
                                  )}
                                  {v.source === 'manual' && (
                                    <span style={{
                                      backgroundColor: '#f1f5f9',
                                      color: '#64748b',
                                      padding: '1px 6px',
                                      borderRadius: '4px',
                                      fontWeight: 600,
                                      fontSize: '10px'
                                    }}>
                                      [手動建立]
                                    </span>
                                  )}
                                </div>
                              </>
                            )}
                          </td>
                          {isDaili ? (
                            <>
                              <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                NT$ {(inventoryMap.get(v.myacg_item_code)?.final_price ?? 0).toLocaleString()}
                              </td>
                              <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                {editMode && canWrite ? (
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    placeholder="-"
                                    style={{
                                      width: '80px',
                                      height: '28px',
                                      textAlign: 'right',
                                      border: '1px solid #cbd5e1',
                                      borderRadius: '4px',
                                      fontSize: '14px',
                                      fontWeight: 600,
                                      color: '#1E293B',
                                      backgroundColor: '#ffffff',
                                      padding: '0 8px',
                                      margin: '0 0 0 auto',
                                      display: 'block'
                                    }}
                                    value={getVariantDefaultTwdCostInputVal(v)}
                                    onChange={e => {
                                      const val = e.target.value.replace(/[^0-9]/g, '');
                                      setTempTwdCosts(prev => ({ ...prev, [v.id]: val }));
                                    }}
                                    onBlur={e => handleCommitTwdCost(v.id, e.target.value)}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') {
                                        e.currentTarget.blur();
                                      }
                                    }}
                                  />
                                ) : (
                                  (() => {
                                    const defCost = getVariantDefaultTwdCost(v);
                                    if (defCost !== undefined && defCost !== null) {
                                      return `NT$ ${defCost}`;
                                    }
                                    const latCost = getLatestBatchCost(v.id);
                                    if (latCost !== null) {
                                      return `NT$ ${latCost}`;
                                    }
                                    return '-';
                                  })()
                                )}
                              </td>
                            </>
                          ) : (
                            <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                              {editMode && canWrite ? (
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  placeholder="-"
                                  style={{
                                    width: '80px',
                                    height: '28px',
                                    textAlign: 'right',
                                    border: '1px solid #cbd5e1',
                                    borderRadius: '4px',
                                    fontSize: '14px',
                                    fontWeight: 600,
                                    color: '#1E293B',
                                    backgroundColor: '#ffffff',
                                    padding: '0 8px',
                                    margin: '0 0 0 auto',
                                    display: 'block'
                                  }}
                                  value={getVariantDefaultJpyCostInputVal(v)}
                                  onChange={e => {
                                    const val = e.target.value.replace(/[^0-9]/g, '');
                                    setTempJpyCosts(prev => ({ ...prev, [v.id]: val }));
                                  }}
                                  onBlur={e => handleCommitJpyCost(v.id, e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      e.currentTarget.blur();
                                    }
                                  }}
                                />
                              ) : (
                                (() => {
                                  const defCost = getVariantDefaultJpyCost(v);
                                  if (defCost !== undefined && defCost !== null) {
                                    return `¥ ${defCost}`;
                                  }
                                  const latCost = getLatestBatchCost(v.id);
                                  if (latCost !== null) {
                                    return `¥ ${latCost}`;
                                  }
                                  return '-';
                                })()
                              )}
                            </td>
                          )}
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            {renderStatusBadge(pNeed, pExcess, pDemand)}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <input 
                              type="text" 
                              inputMode="numeric"
                              pattern="[0-9]*"
                              style={{ 
                                width: '64px', 
                                height: '28px', 
                                textAlign: 'center', 
                                border: '1px solid #cbd5e1', 
                                borderRadius: '4px', 
                                fontSize: '14px', 
                                fontWeight: 600, 
                                color: editMode ? '#1E293B' : '#64748b', 
                                backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                cursor: editMode ? 'text' : 'not-allowed',
                                margin: '0 auto', 
                                display: 'block' 
                              }} 
                              value={pMyacg || ''}
                              placeholder="0"
                              onChange={e => {
                                const val = e.target.value.replace(/[^0-9]/g, '');
                                handleUpdatePlatformDemand(v.id, 'myacg', val === '' ? 0 : parseInt(val));
                              }}
                              disabled={!editMode}
                            />
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <input 
                              type="text" 
                              inputMode="numeric"
                              pattern="[0-9]*"
                              style={{ 
                                width: '64px', 
                                height: '28px', 
                                textAlign: 'center', 
                                border: '1px solid #cbd5e1', 
                                borderRadius: '4px', 
                                fontSize: '14px', 
                                fontWeight: 600, 
                                color: editMode ? '#1E293B' : '#64748b', 
                                backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                cursor: editMode ? 'text' : 'not-allowed',
                                margin: '0 auto', 
                                display: 'block' 
                              }} 
                              value={pWaca || ''}
                              placeholder="0"
                              onChange={e => {
                                const val = e.target.value.replace(/[^0-9]/g, '');
                                handleUpdatePlatformDemand(v.id, 'waca', val === '' ? 0 : parseInt(val));
                              }}
                              disabled={!editMode}
                            />
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: pManual > 0 ? '#1E293B' : '#94a3b8', backgroundColor: pManual > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>
                              {pManual > 0 ? pManual : '-'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: pPurchased > 0 ? '#1E293B' : '#94a3b8' }}>
                              {pPurchased > 0 ? pPurchased : '-'}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    </ScrollWrapper>
                  </div>
                );
              }

              // CATEGORY CARD RENDERING
              return (
                <div key={groupKey} className="card shadow-sm rounded-lg bg-white" style={{ width: '100%', maxWidth: '100%', overflow: 'hidden', borderTop: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderLeft: `4px solid ${borderColor}` }}>
                  
                  {/* Category Header Row */}
                  <div 
                    style={{ padding: isMobile ? '10px 12px' : '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', gap: '8px', overflow: 'hidden' }}
                    onClick={() => toggleManualGroup(groupKey)}
                  >
                    {isMobile ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden', flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <HighlightText text={catTitle} highlight={searchTerm} />
                        </div>
                        <div style={{ color: '#64748b', fontSize: '12px', fontWeight: 400 }}>
                          共 {groupItems.length} 款
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', overflow: 'hidden', flex: 1 }}>
                        <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px' }}>
                          <HighlightText text={catTitle} highlight={searchTerm} />
                        </div>
                        <span style={{ backgroundColor: '#f1f5f9', color: '#64748b', padding: '2px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 500 }}>
                          共 {groupItems.length} 款
                        </span>
                        {pNeed > 0 && (
                          <span style={{
                            backgroundColor: '#FEE2E2',
                            color: '#DC2626',
                            border: '1px solid #fecaca',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontSize: '12px',
                            fontWeight: 600,
                            marginLeft: '8px',
                            display: 'inline-block'
                          }}>
                            待採購 {pNeed}
                          </span>
                        )}
                        {pNeed === 0 && pExcess > 0 && (
                          <span style={{
                            backgroundColor: '#fff7ed',
                            color: '#c2410c',
                            border: '1px solid #ffedd5',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontSize: '12px',
                            fontWeight: 600,
                            marginLeft: '8px',
                            display: 'inline-block'
                          }}>
                            多買 {pExcess}
                          </span>
                        )}
                      </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '6px' : '16px', fontSize: '13px', color: '#64748b', flexShrink: 0 }}>
                      {!isMobile && (
                        <>
                          <span>總需求 {pDemand}</span>
                          <span>已採購 {pPurchased}</span>
                          <span>待採購 {pNeed}</span>
                          <span>多買 {pExcess}</span>
                          <span>私下 {pManual}</span>
                        </>
                      )}
                      <div style={{ color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
                        {isExpanded ? <ChevronDown size={isMobile ? 16 : 20} /> : <ChevronRight size={isMobile ? 16 : 20} />}
                      </div>
                    </div>
                  </div>

                  {/* Expanded SKU Table */}
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid #f1f5f9' }}>
                      {isMobile ? (
                        <div style={{ display: 'flex', flexDirection: 'column', backgroundColor: '#fff' }}>
                          {(() => {
                            const filteredList = groupItems.filter(v => {
                              if (!searchTerm.trim()) return true;
                              const lowerSearch = searchTerm.toLowerCase();
                              return (
                                (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                                (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                              );
                            });
                            return filteredList.map(v => renderMobileVariantCard(v));
                          })()}
                        </div>
                      ) : (
                        <ScrollWrapper isMobile={isMobile}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed', minWidth: isMobile ? '800px' : undefined }}>
                        {isDaili ? (
                          <>
                            <colgroup>
                              <col style={{ width: '30%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '9%' }} />
                              <col style={{ width: '9%' }} />
                              <col style={{ width: '9%' }} />
                              <col style={{ width: '9%' }} />
                            </colgroup>
                            <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                              <tr>
                                <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫售價</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>成本</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                              </tr>
                            </thead>
                          </>
                        ) : (
                          <>
                            <colgroup>
                              <col style={{ width: '30%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '13%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '11%' }} />
                              <col style={{ width: '12%' }} />
                              <col style={{ width: '12%' }} />
                            </colgroup>
                            <thead style={{ backgroundColor: '#fafafa', color: '#64748B' }}>
                              <tr>
                                <th style={{ padding: '10px 20px', textAlign: 'left', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>商品名稱/SKU</th>
                                <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>單價</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>狀態</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>買動漫</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>WACA</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>私下登記</th>
                                <th style={{ padding: '10px 12px', textAlign: 'center', fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em' }}>已採購</th>
                              </tr>
                            </thead>
                          </>
                        )}
                        <tbody>
                          {(() => {
                            const filteredList = groupItems.filter(v => {
                              if (!searchTerm.trim()) return true;
                              const lowerSearch = searchTerm.toLowerCase();
                              return (
                                (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                                (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                              );
                            });
                            
                            return filteredList.map((v, i) => {
                              const { myacgDemand, wacaDemand, privateDemand, totalDemand, purchased: totalPurchased } = getVariantDemands(v);
                              
                              const needToBuy = Math.max(totalDemand - totalPurchased, 0);
                              const excessBuy = Math.max(totalPurchased - totalDemand, 0);

                              return (
                                <tr key={v.id} style={{ borderBottom: i === filteredList.length - 1 ? 'none' : '1px solid #F1F5F9' }}>
                                  <td style={{ padding: '12px 20px', textAlign: 'left' }}>
                                    {editMode && canWrite && v.source === 'manual' ? (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
                                        <input 
                                          type="text" 
                                          value={v.variant_name || ''} 
                                          onChange={e => handleManualFieldChange(v.id, 'variant_name', e.target.value)}
                                          onFocus={e => handleManualFieldFocus(v.id, 'variant_name', e.target.value)}
                                          onBlur={e => handleManualFieldBlur(v.id, 'variant_name', e.target.value)}
                                          onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                              (e.target as HTMLInputElement).blur();
                                            }
                                          }}
                                          style={{
                                            width: '100%',
                                            height: '28px',
                                            border: '1px solid #cbd5e1',
                                            borderRadius: '4px',
                                            fontSize: '14px',
                                            fontWeight: 700,
                                            color: '#1E293B',
                                            backgroundColor: '#ffffff',
                                            padding: '0 8px'
                                          }}
                                          placeholder="規格名稱"
                                        />
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                          <span style={{ fontSize: '11px', color: '#94A3B8' }}>SKU:</span>
                                          <input 
                                            type="text" 
                                            value={v.myacg_item_code || ''} 
                                            onChange={e => handleManualFieldChange(v.id, 'myacg_item_code', e.target.value)}
                                            onFocus={e => handleManualFieldFocus(v.id, 'myacg_item_code', e.target.value)}
                                            onBlur={e => handleManualFieldBlur(v.id, 'myacg_item_code', e.target.value)}
                                            onKeyDown={e => {
                                              if (e.key === 'Enter') {
                                                (e.target as HTMLInputElement).blur();
                                              }
                                            }}
                                            style={{
                                              width: '150px',
                                              height: '24px',
                                              border: '1px solid #cbd5e1',
                                              borderRadius: '4px',
                                              fontSize: '11px',
                                              fontWeight: 400,
                                              color: '#1E293B',
                                              backgroundColor: '#ffffff',
                                              padding: '0 6px'
                                            }}
                                            placeholder="可空白"
                                          />
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                                          <span style={{
                                            backgroundColor: '#f1f5f9',
                                            color: '#64748b',
                                            padding: '1px 6px',
                                            borderRadius: '4px',
                                            fontWeight: 600,
                                            fontSize: '10px'
                                          }}>
                                            [手動建立]
                                          </span>
                                          {editMode && canWrite && (
                                            <div style={{ display: 'inline-flex', gap: '6px' }}>
                                              <button 
                                                type="button"
                                                onClick={() => handleMoveVariant(v.id, 'up')} 
                                                disabled={variants.indexOf(v) === 0}
                                                style={{ 
                                                  padding: '2px 6px', 
                                                  fontSize: '11px', 
                                                  cursor: variants.indexOf(v) === 0 ? 'not-allowed' : 'pointer', 
                                                  border: '1px solid #cbd5e1', 
                                                  borderRadius: '4px', 
                                                  backgroundColor: '#f8fafc',
                                                  color: variants.indexOf(v) === 0 ? '#cbd5e1' : '#475569',
                                                  fontWeight: 500,
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  justifyContent: 'center',
                                                  height: '22px'
                                                }}
                                                title="上移"
                                              >
                                                ↑ 上移
                                              </button>
                                              <button 
                                                type="button"
                                                onClick={() => handleMoveVariant(v.id, 'down')} 
                                                disabled={variants.indexOf(v) === variants.length - 1}
                                                style={{ 
                                                  padding: '2px 6px', 
                                                  fontSize: '11px', 
                                                  cursor: variants.indexOf(v) === variants.length - 1 ? 'not-allowed' : 'pointer', 
                                                  border: '1px solid #cbd5e1', 
                                                  borderRadius: '4px', 
                                                  backgroundColor: '#f8fafc',
                                                  color: variants.indexOf(v) === variants.length - 1 ? '#cbd5e1' : '#475569',
                                                  fontWeight: 500,
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  justifyContent: 'center',
                                                  height: '22px'
                                                }}
                                                title="下移"
                                              >
                                                下移
                                              </button>
                                              <button 
                                                type="button"
                                                onClick={() => handleDeleteVariant(v.id)} 
                                                style={{ 
                                                  padding: '2px 6px', 
                                                  fontSize: '11px', 
                                                  cursor: 'pointer', 
                                                  border: '1px solid #fee2e2', 
                                                  borderRadius: '4px', 
                                                  backgroundColor: '#fef2f2', 
                                                  color: '#dc2626',
                                                  fontWeight: 500,
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  justifyContent: 'center',
                                                  height: '22px'
                                                }}
                                                title="刪除"
                                              >
                                                刪除
                                              </button>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ) : (
                                      <>
                                        <div style={{ fontWeight: 700, color: '#0F172A', fontSize: '15px', lineHeight: 1.35, marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={getDisplayProductName(v)}>
                                          <HighlightText text={isDaili ? getDisplayProductName(v) : getVariantDisplayLabel(v)} highlight={searchTerm} />
                                        </div>
                                        <div style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8', marginTop: '2px', lineHeight: 1.2, display: 'flex', alignItems: 'center', gap: '8px' }} title={v.myacg_item_code}>
                                          <span>SKU: <HighlightText text={v.myacg_item_code || '(空白)'} highlight={searchTerm} /></span>
                                          {v.catalog_missing && (
                                            <span style={{
                                              backgroundColor: '#ffedd5',
                                              color: '#ea580c',
                                              padding: '1px 6px',
                                              borderRadius: '4px',
                                              fontWeight: 600,
                                              fontSize: '10px'
                                            }}>
                                              [清單無此項]
                                            </span>
                                          )}
                                          {v.source === 'manual' && (
                                            <span style={{
                                              backgroundColor: '#f1f5f9',
                                              color: '#64748b',
                                              padding: '1px 6px',
                                              borderRadius: '4px',
                                              fontWeight: 600,
                                              fontSize: '10px'
                                            }}>
                                              [手動建立]
                                            </span>
                                          )}
                                        </div>
                                      </>
                                    )}
                                  </td>
                                  {isDaili ? (
                                    <>
                                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                        NT$ {(inventoryMap.get(v.myacg_item_code)?.final_price ?? 0).toLocaleString()}
                                      </td>
                                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                        {editMode && canWrite ? (
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            pattern="[0-9]*"
                                            placeholder="-"
                                            style={{
                                              width: '80px',
                                              height: '28px',
                                              textAlign: 'right',
                                              border: '1px solid #cbd5e1',
                                              borderRadius: '4px',
                                              fontSize: '14px',
                                              fontWeight: 600,
                                              color: '#1E293B',
                                              backgroundColor: '#ffffff',
                                              padding: '0 8px',
                                              margin: '0 0 0 auto',
                                              display: 'block'
                                            }}
                                            value={getVariantDefaultTwdCostInputVal(v)}
                                            onChange={e => {
                                              const val = e.target.value.replace(/[^0-9]/g, '');
                                              setTempTwdCosts(prev => ({ ...prev, [v.id]: val }));
                                            }}
                                            onBlur={e => handleCommitTwdCost(v.id, e.target.value)}
                                            onKeyDown={e => {
                                              if (e.key === 'Enter') {
                                                e.currentTarget.blur();
                                              }
                                            }}
                                          />
                                        ) : (
                                          (() => {
                                            const defCost = getVariantDefaultTwdCost(v);
                                            if (defCost !== undefined && defCost !== null) {
                                              return `NT$ ${defCost}`;
                                            }
                                            const latCost = getLatestBatchCost(v.id);
                                            if (latCost !== null) {
                                              return `NT$ ${latCost}`;
                                            }
                                            return '-';
                                          })()
                                        )}
                                      </td>
                                    </>
                                  ) : (
                                    <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                      {editMode && canWrite ? (
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          pattern="[0-9]*"
                                          placeholder="-"
                                          style={{
                                            width: '80px',
                                            height: '28px',
                                            textAlign: 'right',
                                            border: '1px solid #cbd5e1',
                                            borderRadius: '4px',
                                            fontSize: '14px',
                                            fontWeight: 600,
                                            color: '#1E293B',
                                            backgroundColor: '#ffffff',
                                            padding: '0 8px',
                                            margin: '0 0 0 auto',
                                            display: 'block'
                                          }}
                                          value={getVariantDefaultJpyCostInputVal(v)}
                                          onChange={e => {
                                            const val = e.target.value.replace(/[^0-9]/g, '');
                                            setTempJpyCosts(prev => ({ ...prev, [v.id]: val }));
                                          }}
                                          onBlur={e => handleCommitJpyCost(v.id, e.target.value)}
                                          onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                              e.currentTarget.blur();
                                            }
                                          }}
                                        />
                                      ) : (
                                        (() => {
                                          const defCost = getVariantDefaultJpyCost(v);
                                          if (defCost !== undefined && defCost !== null) {
                                            return `¥ ${defCost}`;
                                          }
                                          const latCost = getLatestBatchCost(v.id);
                                          if (latCost !== null) {
                                            return `¥ ${latCost}`;
                                          }
                                          return '-';
                                        })()
                                      )}
                                    </td>
                                  )}
                                
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    {renderStatusBadge(needToBuy, excessBuy, totalDemand)}
                                  </td>

                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <input 
                                      type="text" 
                                      inputMode="numeric"
                                      pattern="[0-9]*"
                                      style={{ 
                                        width: '64px', 
                                        height: '28px', 
                                        textAlign: 'center', 
                                        border: '1px solid #cbd5e1', 
                                        borderRadius: '4px', 
                                        fontSize: '14px', 
                                        fontWeight: 600, 
                                        color: editMode ? '#1E293B' : '#64748b', 
                                        backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                        cursor: editMode ? 'text' : 'not-allowed',
                                        margin: '0 auto', 
                                        display: 'block' 
                                      }} 
                                      value={myacgDemand || ''}
                                      placeholder="0"
                                      onChange={e => {
                                        const val = e.target.value.replace(/[^0-9]/g, '');
                                        handleUpdatePlatformDemand(v.id, 'myacg', val === '' ? 0 : parseInt(val));
                                      }}
                                      disabled={!editMode}
                                    />
                                  </td>
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <input 
                                      type="text" 
                                      inputMode="numeric"
                                      pattern="[0-9]*"
                                      style={{ 
                                        width: '64px', 
                                        height: '28px', 
                                        textAlign: 'center', 
                                        border: '1px solid #cbd5e1', 
                                        borderRadius: '4px', 
                                        fontSize: '14px', 
                                        fontWeight: 600, 
                                        color: editMode ? '#1E293B' : '#64748b', 
                                        backgroundColor: editMode ? '#ffffff' : '#f8fafc',
                                        cursor: editMode ? 'text' : 'not-allowed',
                                        margin: '0 auto', 
                                        display: 'block' 
                                      }} 
                                      value={wacaDemand || ''}
                                      placeholder="0"
                                      onChange={e => {
                                        const val = e.target.value.replace(/[^0-9]/g, '');
                                        handleUpdatePlatformDemand(v.id, 'waca', val === '' ? 0 : parseInt(val));
                                      }}
                                      disabled={!editMode}
                                    />
                                  </td>
                                  
                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: privateDemand > 0 ? '#1E293B' : '#94a3b8', backgroundColor: privateDemand > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>
                                      {privateDemand > 0 ? privateDemand : '-'}
                                    </span>
                                  </td>

                                  <td style={{ padding: '12px', textAlign: 'center' }}>
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: totalPurchased > 0 ? '#1E293B' : '#94a3b8' }}>
                                      {totalPurchased > 0 ? totalPurchased : '-'}
                                    </span>
                                  </td>
                                </tr>
                              );
                            });
                          })()}
                        </tbody>
                      </table>
                    </ScrollWrapper>
                  )}
                </div>
              )}
                </div>
              );
            })}
          </div>
        )}

        {/* Shortage Purchasing List (only when activeTab === 'worksheet' and filterMode === 'abnormal') */}
        {activeTab === 'worksheet' && filterMode === 'abnormal' && (() => {
          // 1. Process all groups and variants to extract actual shortages (needToBuy > 0)
          const shortageGroups = sortedGroupEntries.map(([groupKey, groupItems]) => {
            const catTitle = groupKey.startsWith('category:') 
              ? (isDaili ? cleanDailiTitle(groupKey.slice('category:'.length)) : groupKey.slice('category:'.length))
              : getDisplayProductName(groupItems[0]);
            
            // Apply Search Filter first
            if (searchTerm) {
              const lowerSearch = searchTerm.toLowerCase();
              const groupMatch = catTitle.toLowerCase().includes(lowerSearch);
              const hasMatch = groupItems.some(v => 
                (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
              );
              if (!groupMatch && !hasMatch) return null;
            }

            const itemsWithShortage = groupItems.map(v => {
              const { totalDemand, purchased: totalPurchased } = getVariantDemands(v);
              const needToBuy = Math.max(totalDemand - totalPurchased, 0);
              
              return { variant: v, needToBuy };
            }).filter(item => item.needToBuy > 0);

            const totalGroupShortage = itemsWithShortage.reduce((sum, item) => sum + item.needToBuy, 0);
            
            if (totalGroupShortage === 0) return null;

            return {
              groupKey,
              catTitle,
              items: itemsWithShortage,
              totalShortage: totalGroupShortage
            };
          }).filter((g): g is NonNullable<typeof g> => g !== null);

          // 2. Sort by totalShortage descending (commented out to inherit standard mode sorting)
          // shortageGroups.sort((a, b) => b.totalShortage - a.totalShortage);

          // 3. Stats
          const totalAbnormalProductsCount = shortageGroups.length;
          const totalAbnormalShortageCount = shortageGroups.reduce((sum, g) => sum + g.totalShortage, 0);

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, paddingBottom: '40px' }}>
              {/* Statistics Header */}
              <div style={{ 
                padding: '16px 20px', 
                backgroundColor: '#fff', 
                borderRadius: '12px', 
                border: '1px solid #e5e7eb', 
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)', 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center' 
              }}>
                <span style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>缺貨採購清單</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 600, color: '#475569' }}>
                  <span>共 <strong style={{ color: '#2563eb' }}>{totalAbnormalProductsCount}</strong> 種商品</span>
                  <span style={{ color: '#cbd5e1' }}>|</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    待採購 
                    <strong style={{
                      backgroundColor: '#FEE2E2',
                      color: '#DC2626',
                      border: '1px solid #fecaca',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontWeight: 700
                    }}>
                      {totalAbnormalShortageCount}
                    </strong>
                  </span>
                </div>
              </div>

              {/* Cleared list message */}
              {totalAbnormalProductsCount === 0 && (
                <div className="card text-center" style={{ padding: '40px', backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '12px', color: '#64748b' }}>
                  🎉 目前沒有任何缺貨商品！
                </div>
              )}

              {/* Shopping List Items */}
              {shortageGroups.map(g => {
                const isSingleItem = g.groupKey.startsWith('__single__');
                
                if (isSingleItem) {
                  return (
                    <div 
                      key={g.groupKey} 
                      className="card shadow-sm rounded-lg overflow-hidden bg-white" 
                      style={{ 
                        width: '100%',
                        maxWidth: '100%',
                        overflow: 'hidden',
                        borderTop: '1px solid #e5e7eb', 
                        borderRight: '1px solid #e5e7eb', 
                        borderBottom: '1px solid #e5e7eb', 
                        borderLeft: '4px solid #F87171',
                        padding: '16px 20px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        height: '60px'
                      }}
                    >
                      <span style={{ fontSize: '16px', fontWeight: 700, color: '#0F172A' }}>
                        <HighlightText text={g.catTitle} highlight={searchTerm} />
                      </span>
                      <span style={{
                        backgroundColor: '#FEE2E2',
                        color: '#DC2626',
                        border: '1px solid #fecaca',
                        padding: '4px 12px',
                        borderRadius: '6px',
                        fontSize: '14px',
                        fontWeight: 700
                      }}>
                        待採購 {g.totalShortage}
                      </span>
                    </div>
                  );
                }

                // Multi-spec Product (category group)
                return (
                  <div 
                    key={g.groupKey} 
                    className="card shadow-sm rounded-lg overflow-hidden bg-white" 
                    style={{ 
                      width: '100%',
                      maxWidth: '100%',
                      overflow: 'hidden',
                      borderTop: '1px solid #e5e7eb', 
                      borderRight: '1px solid #e5e7eb', 
                      borderBottom: '1px solid #e5e7eb', 
                      borderLeft: '4px solid #F87171',
                      padding: '16px 20px'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                      <span style={{ fontSize: '16px', fontWeight: 700, color: '#0F172A', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: '#64748b' }}>▼</span> 
                        <HighlightText text={g.catTitle} highlight={searchTerm} />
                      </span>
                      <span style={{
                        backgroundColor: '#FEE2E2',
                        color: '#DC2626',
                        border: '1px solid #fecaca',
                        padding: '4px 12px',
                        borderRadius: '6px',
                        fontSize: '14px',
                        fontWeight: 700
                      }}>
                        待採購 {g.totalShortage}
                      </span>
                    </div>
                    
                    <div style={{ paddingLeft: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {g.items.map(item => (
                        <div key={item.variant.id} style={{ fontSize: '14px', color: '#475569', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ color: '#94a3b8' }}>•</span>
                          <span>
                            <HighlightText text={isDaili ? getDisplayProductName(item.variant) : getVariantDisplayLabel(item.variant)} highlight={searchTerm} />
                          </span>
                          <span style={{ fontWeight: 700, color: '#0F172A', marginLeft: '4px' }}>×{item.needToBuy}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Render Purchase Batch Tab */}
        {activeTab === 'purchase_batches' && (
          isMobile ? (
            <MobilePurchaseBatchTab
              batches={purchaseBatches}
              batchItems={purchaseBatchItems}
              variants={variants}
              categoryMap={categoryMap}
              groups={groups}
              onRefresh={loadData}
              onEditBatch={handleEditBatch}
              getDisplayProductName={getDisplayProductName}
              canWrite={canWrite}
              isDaili={isDaili}
            />
          ) : (
            <PurchaseBatchTab 
              batches={purchaseBatches} 
              batchItems={purchaseBatchItems} 
              variants={variants} 
              categoryMap={categoryMap}
              groups={groups}
              onRefresh={loadData} 
              onEditBatch={handleEditBatch}
              getDisplayProductName={getDisplayProductName}
              canWrite={canWrite}
              isDaili={isDaili}
            />
          )
        )}

        {/* Render Private Order Tab */}
        {activeTab === 'private_orders' && (
          <PrivateOrderTab 
            orders={privateOrders} 
            orderItems={privateOrderItems} 
            variants={variants} 
            onRefresh={loadData} 
            onEditOrder={handleEditOrder}
            getDisplayProductName={getDisplayProductName}
          />
        )}
      </div>

      {/* Modals... (Keep Private Order and Batch Modals Unchanged) */}
      {showPrivateOrderModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ width: '600px', maxHeight: '90vh', overflowY: 'auto', backgroundColor: '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', padding: '16px', borderBottom: '1px solid #e5e7eb' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>{editingPoId ? '編輯私下登記' : '新增私下登記'}</h2>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowPrivateOrderModal(false)}><X size={20} /></button>
            </div>
            
            <div style={{ padding: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>買家名稱 *</label>
                  <input className="input" type="text" value={poForm.customer_name} onChange={e => setPoForm({...poForm, customer_name: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>聯絡方式</label>
                  <input className="input" type="text" value={poForm.contact} onChange={e => setPoForm({...poForm, contact: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>訂單備註</label>
                  <input className="input" type="text" value={poForm.note} onChange={e => setPoForm({...poForm, note: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px' }} />
                </div>
              </div>

              <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '14px', color: '#1e293b' }}>商品需求明細</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '24px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f8fafc', color: '#64748b' }}>
                    <th style={{ padding: '8px', textAlign: 'left', fontWeight: 500 }}>商品規格</th>
                    <th style={{ padding: '8px', textAlign: 'center', fontWeight: 500, width: '80px' }}>數量</th>
                    <th style={{ padding: '8px', textAlign: 'right', fontWeight: 500, width: '100px' }}>實收金額</th>
                  </tr>
                </thead>
                <tbody>
                  {variants.map((v, idx) => (
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
                        <input 
                          className="input" 
                          type="text" 
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={poLines[idx]?.quantity === 0 ? '' : (poLines[idx]?.quantity || '')} 
                          onChange={e => {
                            const val = e.target.value.replace(/[^0-9]/g, '');
                            updatePoLine(idx, 'quantity', val === '' ? 0 : parseInt(val));
                          }} 
                          style={{ width: '100%', padding: '4px 8px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px' }} 
                        />
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>
                        <input 
                          className="input" 
                          type="text" 
                          inputMode="decimal"
                          pattern="[0-9]*\.?[0-9]*" 
                          value={poLines[idx]?.amount === 0 ? '' : (poLines[idx]?.amount ?? '')} 
                          onChange={e => {
                            const valStr = e.target.value.replace(/[^0-9.]/g, '');
                            const parts = valStr.split('.');
                            const cleanVal = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : valStr;
                            updatePoLine(idx, 'amount', cleanVal);
                          }} 
                          style={{ width: '100%', padding: '4px 8px', textAlign: 'right', border: '1px solid #cbd5e1', borderRadius: '4px' }} 
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button className="btn btn-outline" style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1' }} onClick={() => setShowPrivateOrderModal(false)}>取消</button>
                <button className="btn btn-primary" style={{ padding: '8px 16px', borderRadius: '6px', backgroundColor: '#2563eb', color: '#fff' }} onClick={handleAddPrivateOrderSubmit} disabled={!poForm.customer_name.trim()}>儲存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showBatchModal && (
        <PurchaseBatchModal
          show={showBatchModal}
          onClose={() => setShowBatchModal(false)}
          group={group}
          variants={variants}
          inventory={Array.from(inventoryMap.values())}
          salesOrderItems={salesOrderItems}
          privateOrderItems={privateOrderItems}
          purchaseBatchItems={purchaseBatchItems}
          purchaseBatches={purchaseBatches}
          editingBatchId={editingBatchId}
          onSaveSuccess={async () => {
            await loadData();
          }}
          onStale={() => {
            setIsStale(true);
            loadData();
          }}
          getDisplayProductName={getDisplayProductName}
        />
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div style={{
          position: 'fixed',
          top: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: '#1e293b',
          color: '#fff',
          padding: '12px 24px',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 10000,
          fontSize: '14px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          pointerEvents: 'none',
          transition: 'all 0.3s ease'
        }}>
          {toastMessage}
        </div>
      )}

      {/* Floating Action Button (FAB) */}
      <button
        onClick={toggleEditMode}
        className="fixed transition-all duration-200"
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: 9999,
          height: '42px',
          padding: '0 20px',
          fontWeight: 600,
          fontSize: '14px',
          borderRadius: '9999px',
          border: editMode ? '1px solid #FED7AA' : '1px solid #A7F3D0',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          backgroundColor: editMode ? '#FFEFE6' : '#E6F4EA',
          color: editMode ? '#C2410C' : '#137333',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          outline: 'none'
        }}
      >
        {editMode ? '✏️ 編輯中' : '🔒 已鎖定'}
      </button>
    </div>
  );
}
