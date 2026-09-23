import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { dataProvider, StaleDataError } from '../providers/dataProvider';
import { calculateVariantDemandAndPurchased } from '../lib/db';
import { mapPrivateOrderItemsByGroup, mapPurchaseBatchItemsByGroup } from '../lib/purchaseBatchScope';
import type { ProductGroup, ProductVariant, PurchaseBatch, PurchaseBatchItem, InventoryItem, PrivateOrder, PrivateOrderItem } from '../lib/db';
import { useViewport } from '../contexts/ViewportContext';
import { allocatePurchaseBatchFreight } from '../lib/purchaseBatchFreightAllocation';
import {
  isPurchaseBatchSubmitBoundaryError,
  purchaseBatchIntentCoordinator,
} from '../providers/cloud/purchaseBatchTransaction';
import { CloudOfflineWriteError } from '../providers/cloud/cloudConnectivity';

interface PurchaseBatchModalProps {
  show: boolean;
  onClose: () => void;
  group: ProductGroup;
  variants: ProductVariant[];
  inventory: InventoryItem[];
  salesOrderItems: any[];
  privateOrders: PrivateOrder[];
  privateOrderItems: PrivateOrderItem[];
  purchaseBatchItems: PurchaseBatchItem[];
  purchaseBatches: PurchaseBatch[];
  editingBatchId: string | null;
  onSaveSuccess: () => void;
  onStale?: () => void;
  getDisplayProductName: (v: ProductVariant) => string;
}

function cleanVariantName(variantName: string, categoryTitle: string): string {
  let name = variantName.trim();
  const catTitle = categoryTitle.trim();
  if (!catTitle) return name;

  if (name.startsWith(catTitle)) {
    let rest = name.slice(catTitle.length).trim();
    if (rest.startsWith('-') || rest.startsWith('_') || rest.startsWith('—')) {
      rest = rest.slice(1).trim();
    }
    if (rest) return rest;
  }
  return name;
}

interface ParsedVariant {
  categoryTitle: string | null;
  variantDisplayName: string;
}

type PurchaseBatchDraftLine = {
  variant_id: string;
  quantity: number;
  cost: number | string;
  note: string;
};

type FreightAllocationSnapshot = {
  freightYen: number;
  baseCosts: Array<number | string>;
};

function parseVariantFallback(v: ProductVariant, categoryMap: Map<string, any>): ParsedVariant {
  if (v.product_category_id) {
    const cat = categoryMap.get(v.product_category_id);
    if (cat) {
      const catTitle = cat.title || (cat as any).name || '';
      const varName = (v.variant_name || v.raw_variant_name || '').trim();
      const displayName = cleanVariantName(varName, catTitle);
      return {
        categoryTitle: catTitle || null,
        variantDisplayName: displayName
      };
    }
  }

  const name = (v.variant_name || v.raw_variant_name || '').trim();
  if (name.includes(' - ')) {
    const parts = name.split(' - ');
    const prefix = parts[0].trim();
    let rest = parts.slice(1).join(' - ').trim();
    if (rest.startsWith(prefix)) {
      let sub = rest.slice(prefix.length).trim();
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

  return {
    categoryTitle: null,
    variantDisplayName: name
  };
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
  privateOrders,
  privateOrderItems,
  purchaseBatchItems,
  purchaseBatches,
  editingBatchId,
  onSaveSuccess,
  getDisplayProductName: propGetDisplayProductName
}: PurchaseBatchModalProps) {
  const { isMobile } = useViewport();
  const [categories, setCategories] = useState<any[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (show) {
      dataProvider.getProductCategories().then(setCategories).catch(console.error);
    }
  }, [show]);

  const [onlyShowShortage, setOnlyShowShortage] = useState<boolean>(false);
  const [batchForm, setBatchForm] = useState({ name: '', date: '', note: '' });
  const [batchLines, setBatchLines] = useState<PurchaseBatchDraftLine[]>([]);
  const [freightInput, setFreightInput] = useState('');
  const [freightStatus, setFreightStatus] = useState<{ kind: 'success' | 'warning' | 'error'; message: string } | null>(null);
  const freightAllocationRef = useRef<FreightAllocationSnapshot | null>(null);
  const initializedRef = useRef<string | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{
    kind: 'error' | 'warning';
    message: string;
    lockRetry?: boolean;
  } | null>(null);

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
  const groupPurchaseBatchItems = useMemo(() => {
    if (!group?.id) return [];
    return mapPurchaseBatchItemsByGroup(purchaseBatches, purchaseBatchItems).get(group.id) ?? [];
  }, [purchaseBatches, purchaseBatchItems, group?.id]);
  const groupPrivateOrderItems = useMemo(() => {
    if (!group?.id) return [];
    return mapPrivateOrderItemsByGroup(privateOrders, privateOrderItems).get(group.id) ?? [];
  }, [privateOrders, privateOrderItems, group?.id]);

  const getAutoBatchName = (batches: PurchaseBatch[]): string => {
    const groupBatches = batches.filter(b => b.product_group_id === group?.id && b.id !== editingBatchId);
    const existingNames = new Set(groupBatches.map(b => (b.name || '').trim()));
    let n = groupBatches.length + 1;
    while (existingNames.has(`第${n}批下單`)) n++;
    return `第${n}批下單`;
  };

  const autoBatchNamePreview = useMemo(
    () => getAutoBatchName(purchaseBatches),
    [purchaseBatches, group?.id, editingBatchId]
  );

  const getLatestBatchCost = (variantId: string): number | null => {
    const items = groupPurchaseBatchItems.filter(item => item.product_variant_id === variantId && item.cost > 0);
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
      groupPrivateOrderItems,
      groupPurchaseBatchItems,
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
    const purchased = groupPurchaseBatchItems
      .filter(pbi => pbi.product_variant_id === v.id && pbi.purchase_batch_id !== editingBatchId)
      .reduce((sum, item) => sum + item.quantity, 0);

    return totalDemand - purchased;
  };

  const getDisplayProductName = (v: ProductVariant): string => {
    if (propGetDisplayProductName) {
      return propGetDisplayProductName(v);
    }
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
    setFreightInput('');
    setFreightStatus(null);
    freightAllocationRef.current = null;
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

  const mobileGroups = useMemo(() => {
    const categoryMap = new Map<string, any>(categories.map(c => [c.id, c]));
    const groupsMap = new Map<string, Array<{ variant: ProductVariant; originalIndex: number }>>();
    
    variants.forEach((v, idx) => {
      const shortage = getVariantShortageForModal(v);
      const isHidden = onlyShowShortage && shortage <= 0;
      if (isHidden) return;

      const parsed = parseVariantFallback(v, categoryMap);
      const catTitle = parsed.categoryTitle || '單品';
      
      if (!groupsMap.has(catTitle)) {
        groupsMap.set(catTitle, []);
      }
      groupsMap.get(catTitle)!.push({ variant: v, originalIndex: idx });
    });
    
    return Array.from(groupsMap.entries()).map(([title, items]) => {
      const totalShortage = items.reduce((sum, item) => {
        const shortage = getVariantShortageForModal(item.variant);
        return sum + Math.max(shortage, 0);
      }, 0);
      return {
        title,
        items,
        totalShortage
      };
    });
  }, [variants, categories, onlyShowShortage]);

  const toggleGroup = (title: string) => {
    setExpandedGroups(prev => ({
      ...prev,
      [title]: !prev[title]
    }));
  };

  const pressTimerRef = useRef<any>(null);
  const pressIntervalRef = useRef<any>(null);

  const stopContinuousPress = () => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    if (pressIntervalRef.current) clearInterval(pressIntervalRef.current);
  };

  const restorePreFreightCosts = (
    lines: PurchaseBatchDraftLine[],
    snapshot = freightAllocationRef.current
  ) => {
    if (!snapshot) return lines.map(line => ({ ...line }));
    return lines.map((line, index) => ({
      ...line,
      cost: snapshot.baseCosts[index] ?? line.cost
    }));
  };

  const invalidateFreightAllocation = (
    update: (lines: PurchaseBatchDraftLine[]) => PurchaseBatchDraftLine[],
    message = '商品數量／單價已變更，已還原分攤前單價，請重新分攤。'
  ) => {
    const snapshot = freightAllocationRef.current;
    const hadAllocation = snapshot !== null;
    setBatchLines(prev => update(restorePreFreightCosts(prev, snapshot)));
    freightAllocationRef.current = null;
    if (hadAllocation) setFreightStatus({ kind: 'warning', message });
  };

  const adjustBatchLineQuantity = (index: number, delta: number) => {
    invalidateFreightAllocation(prev => {
      const newLines = [...prev];
      if (newLines[index]) {
        const currentQty = newLines[index].quantity || 0;
        newLines[index] = { 
          ...newLines[index], 
          quantity: Math.max(currentQty + delta, 0) 
        };
      }
      return newLines;
    });
  };

  const startContinuousPress = (index: number, delta: number) => {
    stopContinuousPress();
    adjustBatchLineQuantity(index, delta);
    pressTimerRef.current = setTimeout(() => {
      pressIntervalRef.current = setInterval(() => {
        adjustBatchLineQuantity(index, delta);
      }, 100);
    }, 400);
  };

  const updateBatchLine = (index: number, field: string, value: any) => {
    invalidateFreightAllocation(prev => {
      const newLines = [...prev];
      newLines[index] = { ...newLines[index], [field]: value };
      return newLines;
    });
  };

  const fillAllShortages = () => {
    invalidateFreightAllocation(prev => {
      const newLines = [...prev];
      mobileGroups.forEach(cg => {
        cg.items.forEach(item => {
          const idx = item.originalIndex;
          const shortage = getVariantShortageForModal(item.variant);
          if (shortage > 0) {
            newLines[idx] = {
              ...newLines[idx],
              quantity: shortage
            };
          }
        });
      });
      return newLines;
    });
  };

  const handleFreightInputChange = (value: string) => {
    const cleanValue = value.replace(/[^0-9]/g, '');
    const snapshot = freightAllocationRef.current;
    const hadAllocation = snapshot !== null;
    if (hadAllocation) {
      setBatchLines(prev => restorePreFreightCosts(prev, snapshot));
      freightAllocationRef.current = null;
      setFreightStatus({ kind: 'warning', message: '本批運費已變更，已還原分攤前單價，請重新分攤。' });
    } else {
      setFreightStatus(null);
    }
    setFreightInput(cleanValue);
  };

  const handleAllocateFreight = () => {
    const freightYen = Number(freightInput);
    if (!Number.isSafeInteger(freightYen) || freightYen <= 0) {
      setFreightStatus({ kind: 'error', message: '本批運費必須是大於 0 的整數日圓。' });
      return;
    }

    const existingSnapshot = freightAllocationRef.current;
    const baseLines = existingSnapshot
      ? restorePreFreightCosts(batchLines, existingSnapshot)
      : batchLines.map(line => ({ ...line }));

    try {
      const result = allocatePurchaseBatchFreight(
        freightYen,
        baseLines.map(line => ({
          key: line.variant_id,
          quantity: line.quantity,
          unitCost: typeof line.cost === 'string' ? Number(line.cost) : line.cost
        }))
      );
      const resultByVariant = new Map(result.allocations.map(allocation => [allocation.key, allocation]));

      setBatchLines(baseLines.map(line => {
        const allocation = resultByVariant.get(line.variant_id);
        return allocation ? { ...line, cost: allocation.newUnitCost } : line;
      }));
      freightAllocationRef.current = {
        freightYen,
        baseCosts: baseLines.map(line => line.cost)
      };
      setFreightStatus({
        kind: 'success',
        message: `✓ 已依 ¥${result.requestedFreightTotal.toLocaleString()} 比例分攤（${result.allocations.length} 項，單價已四捨五入）`
      });
    } catch (error) {
      setFreightStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : '運費分攤失敗，請重新確認輸入。'
      });
    }
  };

  const performBatchSubmit = async () => {
    const validLines = batchLines.filter(l => l.quantity > 0);
    if (!group || validLines.length === 0) {
      setSubmitStatus({ kind: 'error', message: '請至少填寫一筆數量大於 0 的採購品項。' });
      return;
    }
    if (editingBatchId && !batchForm.name.trim()) {
      setSubmitStatus({ kind: 'error', message: '請填寫採購批次名稱。' });
      return;
    }
    setSubmitStatus(null);

    try {
      const allBatches = await dataProvider.getPurchaseBatches();
      const allBatchItems = await dataProvider.getPurchaseBatchItems();
      const scope = `${group.id}:${editingBatchId || 'new'}`;
      const draft = {
        groupId: group.id,
        editingBatchId,
        form: { name: batchForm.name, date: batchForm.date, note: batchForm.note },
        lines: validLines.map(line => ({
          variantId: line.variant_id,
          quantity: line.quantity,
          cost: typeof line.cost === 'string' ? (parseFloat(line.cost) || 0) : (line.cost || 0),
          note: line.note,
        })),
      };
      const command = purchaseBatchIntentCoordinator.resolve(scope, draft, idempotencyKey => {
        const existingBatch = editingBatchId
          ? allBatches.find(batch => batch.id === editingBatchId)
          : undefined;
        if (editingBatchId && !existingBatch) throw new Error('PURCHASE_BATCH_EDIT_BASE_MISSING');
        const batchId = existingBatch?.id || crypto.randomUUID();
        const batch: PurchaseBatch = existingBatch
          ? { ...existingBatch, name: batchForm.name, date: batchForm.date, note: batchForm.note }
          : {
              id: batchId,
              product_group_id: group.id,
              name: batchForm.name.trim() || getAutoBatchName(allBatches),
              date: batchForm.date,
              note: batchForm.note,
              created_at: new Date().toISOString(),
            };
        const existingItems = new Map(
          allBatchItems
            .filter(item => item.purchase_batch_id === batchId)
            .map(item => [item.product_variant_id, item]),
        );
        const items: PurchaseBatchItem[] = validLines.map(line => {
          const existing = existingItems.get(line.variant_id);
          return {
            ...existing,
            id: existing?.id || crypto.randomUUID(),
            purchase_batch_id: batchId,
            product_variant_id: line.variant_id,
            quantity: line.quantity,
            cost: typeof line.cost === 'string' ? (parseFloat(line.cost) || 0) : (line.cost || 0),
            note: line.note,
          };
        });
        return { idempotencyKey, batch, items };
      });

      await dataProvider.savePurchaseBatchTransaction(command);
      purchaseBatchIntentCoordinator.complete(scope, command.idempotencyKey);
      
      onClose();
      onSaveSuccess();
    } catch (err) {
      if (err instanceof StaleDataError) {
        setSubmitStatus({ kind: 'warning', message: '雲端資料已更新，本次尚未送出；草稿已保留，請確認後再儲存。' });
        return;
      }
      if (err instanceof CloudOfflineWriteError) {
        setSubmitStatus({ kind: 'warning', message: '雲端資料正在更新，本次尚未送出；草稿已保留，請稍後重新確認。' });
        return;
      }
      if (isPurchaseBatchSubmitBoundaryError(err)) {
        setSubmitStatus({
          kind: err.kind === 'server-rejected' ? 'error' : 'warning',
          message: err.message,
          lockRetry: err.kind !== 'server-rejected',
        });
        return;
      }
      if (err instanceof Error && err.name === 'PurchaseBatchTransactionError') {
        setSubmitStatus({ kind: 'error', message: err.message });
        return;
      }
      setSubmitStatus({ kind: 'error', message: '無法完成採購儲存前檢查，本次尚未送出；草稿已保留。' });
    }
  };

  const handleAddBatchSubmit = () => {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    setIsSaving(true);
    const pending = performBatchSubmit().finally(() => {
      saveInFlightRef.current = null;
      setIsSaving(false);
    });
    saveInFlightRef.current = pending;
    return pending;
  };

  const batchTotal = batchLines.reduce((sum, line) => {
    const q = line?.quantity || 0;
    const c = typeof line?.cost === 'string' ? (parseFloat(line?.cost) || 0) : (line?.cost || 0);
    return sum + (q * c);
  }, 0);

  if (!show) return null;

  return (
    <div id="purchase-batch-modal" style={{ 
      position: 'fixed', 
      inset: 0, 
      backgroundColor: 'rgba(0,0,0,0.4)', 
      display: 'flex', 
      alignItems: isMobile ? 'flex-start' : 'center', 
      justifyContent: 'center', 
      zIndex: 1000,
      overflowY: 'auto',
      padding: isMobile ? '12px 0' : '0'
    }}>
      <div className="card" style={{ 
        width: isMobile ? '95vw' : '600px', 
        maxHeight: isMobile ? '80vh' : '90vh', 
        overflowY: 'auto', 
        backgroundColor: '#fff',
        marginTop: isMobile ? '12px' : '0',
        marginBottom: isMobile ? '12px' : '0'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', padding: '16px', backgroundColor: '#eff6ff', borderBottom: '2px solid #93c5fd' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#1d4ed8', margin: 0 }}>{editingBatchId ? '編輯採購批次' : '新增採購批次'}</h2>
            <p style={{ margin: '4px 0 0', color: '#1e40af', fontSize: '13px' }}>建立正式採購批次，記錄本次採購數量與成本。</p>
          </div>
          <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={onClose}><X size={20} /></button>
        </div>
        
        <div style={{ padding: '16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>批次名稱{editingBatchId ? ' *' : ''}</label>
              <input className="input" type="text" value={batchForm.name} onChange={e => setBatchForm({...batchForm, name: e.target.value})} placeholder={editingBatchId ? '例如：2023-11-20 安利美特採購' : `（留空將自動命名為：${autoBatchNamePreview}）`} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px', fontSize: isMobile ? '16px' : '14px' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>採購日期</label>
              <input 
                className="input" 
                type="date" 
                value={batchForm.date} 
                onChange={e => setBatchForm({...batchForm, date: e.target.value})} 
                style={{ 
                  width: '100%', 
                  height: '36px', 
                  border: '1px solid #cbd5e1', 
                  borderRadius: '6px', 
                  padding: '0 12px', 
                  fontSize: isMobile ? '16px' : '14px',
                  backgroundColor: '#fff',
                  color: '#0f172a',
                  WebkitAppearance: 'none',
                  appearance: 'none',
                  boxSizing: 'border-box',
                  lineHeight: 'normal'
                }} 
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: '#475569' }}>備註</label>
              <input className="input" type="text" value={batchForm.note} onChange={e => setBatchForm({...batchForm, note: e.target.value})} style={{ width: '100%', height: '36px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '0 12px', fontSize: isMobile ? '16px' : '14px' }} />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ fontWeight: 600, fontSize: '14px', color: '#1e293b' }}>採購明細</div>
              {isMobile && (
                <button
                  type="button"
                  onClick={fillAllShortages}
                  style={{
                    backgroundColor: '#3b82f6',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '4px 8px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    userSelect: 'none',
                    WebkitUserSelect: 'none'
                  }}
                >
                  全部補齊
                </button>
              )}
            </div>
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

          {isMobile ? (
            <div 
              onContextMenu={(e) => e.preventDefault()}
              style={{ 
                marginBottom: '24px', 
                display: 'flex', 
                flexDirection: 'column', 
                gap: '12px',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                WebkitTouchCallout: 'none',
                touchAction: 'manipulation'
              }}
            >
              {(() => {
                if (mobileGroups.length === 0) {
                  return (
                    <div style={{ padding: '24px', textAlign: 'center', color: '#64748b', fontSize: '14px', backgroundColor: '#f8fafc', borderRadius: '8px' }}>
                      目前無任何缺口商品
                    </div>
                  );
                }
                
                const categoryMap = new Map<string, any>(categories.map(c => [c.id, c]));

                return mobileGroups.map(cg => {
                  const isExpanded = !!expandedGroups[cg.title];
                  return (
                    <div key={cg.title} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' }}>
                      {/* Group Header */}
                      <div 
                        onClick={() => toggleGroup(cg.title)}
                        style={{ 
                          display: 'flex', 
                          justifyContent: 'space-between', 
                          alignItems: 'center', 
                          padding: '10px 14px', 
                          backgroundColor: '#f1f5f9', 
                          cursor: 'pointer',
                          fontWeight: 600,
                          fontSize: '13px',
                          color: '#1e293b',
                          userSelect: 'none'
                        }}
                      >
                        <span>
                          {isExpanded ? '▼' : '▶'} {cg.title} ({cg.totalShortage})
                        </span>
                      </div>
                      
                      {/* Group Items */}
                      {isExpanded && (
                        <div style={{ padding: '0 12px', backgroundColor: '#fff', display: 'flex', flexDirection: 'column' }}>
                          {cg.items.map(item => {
                            const v = item.variant;
                            const idx = item.originalIndex;
                            const shortage = getVariantShortageForModal(v);
                            const lineData = batchLines[idx];
                            const parsed = parseVariantFallback(v, categoryMap);
                            const displayName = isDaili ? getDisplayProductName(v) : parsed.variantDisplayName;

                            return (
                              <div key={v.id} style={{ 
                                padding: '8px 0', 
                                borderBottom: '1px solid #f1f5f9',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '6px'
                              }}>
                                {/* Row 1: Name and Shortage Badge */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                                  <div style={{ fontWeight: 500, color: '#0f172a', fontSize: '13px', lineHeight: 1.25 }}>
                                    {displayName}
                                  </div>
                                  
                                  <div>
                                    {(() => {
                                      const remainingGap = shortage - (lineData?.quantity || 0);
                                      if (remainingGap > 0) {
                                        return (
                                          <span style={{
                                            backgroundColor: '#FEE2E2',
                                            color: '#DC2626',
                                            border: '1px solid #fecaca',
                                            padding: '1px 6px',
                                            borderRadius: '4px',
                                            fontSize: '11px',
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
                                            padding: '1px 6px',
                                            borderRadius: '4px',
                                            fontSize: '11px',
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
                                            padding: '1px 6px',
                                            borderRadius: '4px',
                                            fontSize: '11px',
                                            fontWeight: 600,
                                            whiteSpace: 'nowrap'
                                          }}>
                                            多買 {Math.abs(remainingGap)}
                                          </span>
                                        );
                                      }
                                    })()}
                                  </div>
                                </div>

                                {/* Row 2: Selector and Price */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  {/* Quantity Selector: [-] [ quantity ] [+] */}
                                  <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <button 
                                      type="button"
                                      onMouseDown={() => startContinuousPress(idx, -1)}
                                      onMouseUp={stopContinuousPress}
                                      onMouseLeave={stopContinuousPress}
                                      onTouchStart={(e) => {
                                        e.preventDefault();
                                        startContinuousPress(idx, -1);
                                      }}
                                      onTouchEnd={(e) => {
                                        e.preventDefault();
                                        stopContinuousPress();
                                      }}
                                      onTouchCancel={(e) => {
                                        e.preventDefault();
                                        stopContinuousPress();
                                      }}
                                      onContextMenu={(e) => {
                                        e.preventDefault();
                                      }}
                                      style={{
                                        width: '44px',
                                        height: '44px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        border: '1px solid #cbd5e1',
                                        borderTopLeftRadius: '6px',
                                        borderBottomLeftRadius: '6px',
                                        backgroundColor: '#f8fafc',
                                        cursor: 'pointer',
                                        fontWeight: 700,
                                        fontSize: '18px',
                                        color: '#475569',
                                        userSelect: 'none',
                                        WebkitUserSelect: 'none',
                                        WebkitTouchCallout: 'none',
                                        touchAction: 'manipulation'
                                      }}
                                    >
                                      -
                                    </button>
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
                                      style={{ 
                                        width: '54px', 
                                        height: '44px', 
                                        padding: '0', 
                                        textAlign: 'center', 
                                        borderTop: '1px solid #cbd5e1', 
                                        borderBottom: '1px solid #cbd5e1',
                                        borderLeft: 'none',
                                        borderRight: 'none',
                                        borderRadius: '0',
                                        fontSize: '16px',
                                        fontWeight: 600,
                                        color: '#0f172a'
                                      }} 
                                    />
                                    <button 
                                      type="button"
                                      onMouseDown={() => startContinuousPress(idx, 1)}
                                      onMouseUp={stopContinuousPress}
                                      onMouseLeave={stopContinuousPress}
                                      onTouchStart={(e) => {
                                        e.preventDefault();
                                        startContinuousPress(idx, 1);
                                      }}
                                      onTouchEnd={(e) => {
                                        e.preventDefault();
                                        stopContinuousPress();
                                      }}
                                      onTouchCancel={(e) => {
                                        e.preventDefault();
                                        stopContinuousPress();
                                      }}
                                      onContextMenu={(e) => {
                                        e.preventDefault();
                                      }}
                                      style={{
                                        width: '44px',
                                        height: '44px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        border: '1px solid #cbd5e1',
                                        borderTopRightRadius: '6px',
                                        borderBottomRightRadius: '6px',
                                        backgroundColor: '#f8fafc',
                                        cursor: 'pointer',
                                        fontWeight: 700,
                                        fontSize: '18px',
                                        color: '#475569',
                                        userSelect: 'none',
                                        WebkitUserSelect: 'none',
                                        WebkitTouchCallout: 'none',
                                        touchAction: 'manipulation'
                                      }}
                                    >
                                      +
                                    </button>
                                  </div>

                                  {/* Price selector */}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 500 }}>單價</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '2px', position: 'relative' }}>
                                      {!isDaili && <span style={{ color: '#64748b', fontSize: '11px' }}>¥</span>}
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
                                        style={{ 
                                          width: '64px', 
                                          height: '32px', 
                                          padding: '0 4px', 
                                          textAlign: 'right', 
                                          border: '1px solid #cbd5e1', 
                                          borderRadius: '4px',
                                          fontSize: '16px',
                                          color: '#0f172a',
                                          fontWeight: 500
                                        }} 
                                      />
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          ) : (
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
                          目無任何缺口商品
                        </td>
                      </tr>
                    );
                  }
                  
                  return rows;
                })()}
              </tbody>
            </table>
          )}

          {!isDaili && !editingBatchId && (
            <div
              data-testid="purchase-batch-freight-tool"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginTop: '4px',
                marginBottom: '16px',
                padding: '12px',
                border: '1px solid #fcd34d',
                borderRadius: '8px',
                backgroundColor: '#fffbeb'
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 700, color: '#92400e' }}>本批運費分攤</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#78350f' }}>
                  本批運費（日幣）
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>¥</span>
                    <input
                      aria-label="本批運費（日幣）"
                      className="input"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={freightInput}
                      onChange={event => handleFreightInputChange(event.target.value)}
                      placeholder="1000"
                      style={{ width: '120px', height: '36px', padding: '0 10px', border: '1px solid #d97706', borderRadius: '6px', backgroundColor: '#fff' }}
                    />
                  </span>
                </label>
                <button
                  type="button"
                  onClick={handleAllocateFreight}
                  style={{
                    height: '36px',
                    padding: '0 14px',
                    border: '1px solid #b45309',
                    borderRadius: '6px',
                    backgroundColor: '#d97706',
                    color: '#fff',
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                >
                  分攤運費至單價
                </button>
              </div>
              <div style={{ fontSize: '12px', color: '#92400e', lineHeight: 1.5 }}>
                僅分攤至「數量 &gt; 0 且實支單價 &gt; 0」的品項；按鈕只會更新本視窗草稿。
              </div>
              <div
                role="status"
                aria-live="polite"
                aria-hidden={freightStatus ? undefined : true}
                style={{
                    minHeight: '18px',
                    lineHeight: '18px',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: freightStatus?.kind === 'success' ? '#15803d' : freightStatus?.kind === 'warning' ? '#b45309' : '#dc2626',
                    visibility: freightStatus ? 'visible' : 'hidden',
                  }}
              >
                {freightStatus?.message || '\u00a0'}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px', borderTop: '1px solid #e5e7eb', paddingTop: '16px' }}>
            <div
              data-testid="purchase-batch-submit-status"
              role="status"
              aria-live="polite"
              aria-hidden={submitStatus ? undefined : true}
              style={{ minHeight: '19px', lineHeight: '19px', fontSize: '13px', fontWeight: 600, color: submitStatus?.kind === 'error' ? '#b91c1c' : '#b45309', visibility: submitStatus ? 'visible' : 'hidden' }}
            >
              {submitStatus?.message || '\u00a0'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
                本批次合計：<span data-testid="purchase-batch-total" style={{ color: '#2563eb', fontSize: '15px', fontWeight: 700 }}>{isDaili ? 'NT$ ' : '¥ '}{batchTotal.toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-outline" style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1', cursor: 'pointer' }} onClick={onClose}>取消</button>
                <button className="btn btn-primary" style={{ minWidth: '92px', justifyContent: 'center', whiteSpace: 'nowrap', padding: '8px 16px', borderRadius: '6px', backgroundColor: '#2563eb', color: '#fff', cursor: 'pointer' }} onClick={handleAddBatchSubmit} disabled={isSaving || submitStatus?.lockRetry === true || (!!editingBatchId && !batchForm.name.trim())}>{isSaving ? '儲存中…' : '儲存'}</button>
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
