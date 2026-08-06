import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Minus, Trash2, CheckSquare, PackageOpen, Search, ChevronDown, ChevronUp, Edit3 } from 'lucide-react';
import { dataProvider } from '../providers/dataProvider';
import type { OutboundShipment, OutboundShipmentItem, JapanPackage, JapanPackageItem, InventoryItem } from '../lib/db';
import { useViewport } from '../contexts/ViewportContext';
import * as XLSX from 'xlsx';

const cleanProductTitle = (title: string) =>
  title
    .replace(/【[^】]*】/g, '')
    .replace(/二次預購|預購|通販/g, '')
    .replace(/\d{2}年\d{2}月/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const MANUAL_TWD_PRICE_PREFIX = '台幣單價：';

const getManualTwdPrice = (note?: string) => {
  const match = note?.match(/(?:^|\n)台幣單價：\s*([0-9]+(?:\.[0-9]+)?)(?=\n|$)/);
  if (!match) return undefined;
  const price = Number(match[1]);
  return Number.isFinite(price) ? price : undefined;
};

const STATUS_FLOW = ['draft', 'packing', 'shipped', 'received'] as const;
const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', packing: '打包中', shipped: '已出貨', received: '已到台灣',
};

const getStatusBadge = (status: string) => {
  switch (status) {
    case 'draft': return { bg: '#f1f5f9', color: '#64748b' };
    case 'packing': return { bg: '#fef3c7', color: '#92400e' };
    case 'shipped': return { bg: '#dbeafe', color: '#1e40af' };
    case 'received': return { bg: '#dcfce7', color: '#166534' };
    default: return { bg: '#f1f5f9', color: '#64748b' };
  }
};

interface PoolItem {
  japanPackageItemId: string;
  productTitle: string;
  categoryName: string;
  variantName: string;
  displayName: string;
  sku: string;
  note?: string;
  arrivedQty: number;
  shippedQty: number;
  availableQty: number;
  packageTitle: string;
  productGroupId?: string;
}

export default function OutboundShipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isMobile } = useViewport();

  const [shipment, setShipment] = useState<OutboundShipment | null>(null);
  const [allShipments, setAllShipments] = useState<OutboundShipment[]>([]);
  const [selectedItems, setSelectedItems] = useState<OutboundShipmentItem[]>([]);
  const [allShipmentItems, setAllShipmentItems] = useState<OutboundShipmentItem[]>([]);
  const [japanPackages, setJapanPackages] = useState<JapanPackage[]>([]);
  const [japanPackageItems, setJapanPackageItems] = useState<JapanPackageItem[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [poolSearch, setPoolSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [collapsedSelectedGroups, setCollapsedSelectedGroups] = useState<Set<string>>(new Set());
  const [showHeaderEdit, setShowHeaderEdit] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualSku, setManualSku] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualVariant, setManualVariant] = useState('');
  const [manualTwdPrice, setManualTwdPrice] = useState('');
  const [manualQty, setManualQty] = useState('1');
  const [editingShipped, setEditingShipped] = useState(false);

  // Header form
  const [formTitle, setFormTitle] = useState('');
  const [formCarrier, setFormCarrier] = useState('');
  const [formTracking, setFormTracking] = useState('');
  const [formWeight, setFormWeight] = useState('');
  const [formCost, setFormCost] = useState('');
  const [formNote, setFormNote] = useState('');

  useEffect(() => {
    loadData();
  }, [id]);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [shipments, items, jp, jpi, inv] = await Promise.all([
        dataProvider.getOutboundShipments(),
        dataProvider.getOutboundShipmentItems(),
        dataProvider.getJapanPackages(),
        dataProvider.getJapanPackageItems(),
        dataProvider.getInventory(),
      ]);
      setAllShipments(shipments);
      setAllShipmentItems(items);
      setJapanPackages(jp);
      setJapanPackageItems(jpi);
      setInventoryItems(inv);

      const current = shipments.find(s => s.id === id);
      setShipment(current || null);
      setSelectedItems(items.filter(i => i.outbound_shipment_id === id));

      if (current) {
        setFormTitle(current.title);
        setFormCarrier(current.carrier || '');
        setFormTracking(current.tracking_number || '');
        setFormWeight(current.weight_kg?.toString() || '');
        setFormCost(current.shipping_cost?.toString() || '');
        setFormNote(current.note || '');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Build pool: items from arrived packages with available quantity > 0
  const poolItems = useMemo<PoolItem[]>(() => {
    const arrivedPackageIds = new Set(
      japanPackages.filter(p => p.status === 'arrived' || p.status === 'confirmed' || p.arrived_at).map(p => p.id)
    );

    // Compute shipped quantities across ALL shipments (except current one for available calc)
    const shippedMap = new Map<string, number>();
    for (const si of allShipmentItems) {
      if (si.japan_package_item_id && si.outbound_shipment_id !== id) {
        shippedMap.set(si.japan_package_item_id, (shippedMap.get(si.japan_package_item_id) || 0) + si.quantity);
      }
    }

    const items: PoolItem[] = [];
    for (const jpi of japanPackageItems) {
      if (!arrivedPackageIds.has(jpi.japan_package_id)) continue;
      const pkg = japanPackages.find(p => p.id === jpi.japan_package_id);
      const shippedQty = shippedMap.get(jpi.id) || 0;
      const availableQty = jpi.quantity - shippedQty;
      if (availableQty <= 0) continue;

      const catName = jpi.category_name || '';
      const varName = jpi.variant_name || '';
      const displayName = [catName, varName].filter(Boolean).join(' — ') || '預設規格';

      items.push({
        japanPackageItemId: jpi.id,
        productTitle: cleanProductTitle(jpi.product_title || '未命名商品') || jpi.product_title || '未命名商品',
        categoryName: catName,
        variantName: varName,
        displayName,
        sku: jpi.sku || '',
        note: jpi.note || undefined,
        arrivedQty: jpi.quantity,
        shippedQty,
        availableQty,
        packageTitle: pkg?.title || '',
        productGroupId: jpi.product_group_id,
      });
    }
    return items;
  }, [japanPackages, japanPackageItems, allShipmentItems, id]);

  // Group pool items by product title
  const groupedPool = useMemo(() => {
    let filtered = poolItems;
    if (poolSearch.trim()) {
      const q = poolSearch.toLowerCase();
      filtered = poolItems.filter(p =>
        p.productTitle.toLowerCase().includes(q) ||
        p.displayName.toLowerCase().includes(q) ||
        p.categoryName.toLowerCase().includes(q) ||
        p.variantName.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.packageTitle.toLowerCase().includes(q)
      );
    }

    const groups = new Map<string, PoolItem[]>();
    for (const item of filtered) {
      const key = item.productTitle;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    for (const [, items] of groups) {
      items.sort((a, b) => a.sku.localeCompare(b.sku, 'ja'));
    }
    return groups;
  }, [poolItems, poolSearch]);

  const toggleGroup = (groupKey: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const addItemToShipment = useCallback((poolItem: PoolItem, qty?: number) => {
    const existing = selectedItems.find(i => i.japan_package_item_id === poolItem.japanPackageItemId);
    const addQty = qty || 1;

    // Check already selected qty for this item in current shipment
    const currentQty = existing ? existing.quantity : 0;
    if (currentQty + addQty > poolItem.availableQty) return;

    let updated: OutboundShipmentItem[];
    if (existing) {
      updated = selectedItems.map(i =>
        i.id === existing.id ? { ...i, quantity: i.quantity + addQty } : i
      );
    } else {
      const newItem: OutboundShipmentItem = {
        id: crypto.randomUUID(),
        outbound_shipment_id: id!,
        japan_package_item_id: poolItem.japanPackageItemId,
        product_group_id: poolItem.productGroupId,
        product_title: poolItem.productTitle,
        variant_name: poolItem.displayName,
        sku: poolItem.sku,
        note: poolItem.note,
        quantity: addQty,
        checked: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      updated = [...selectedItems, newItem];
    }
    setSelectedItems(updated);
    saveItems(updated);
  }, [selectedItems, id]);

  const addGroupToShipment = useCallback((items: PoolItem[]) => {
    let updated = [...selectedItems];
    for (const poolItem of items) {
      const existing = updated.find(i => i.japan_package_item_id === poolItem.japanPackageItemId);
      if (existing) {
        if (existing.quantity < poolItem.availableQty) {
          updated = updated.map(i =>
            i.id === existing.id ? { ...i, quantity: poolItem.availableQty } : i
          );
        }
      } else {
        updated.push({
          id: crypto.randomUUID(),
          outbound_shipment_id: id!,
          japan_package_item_id: poolItem.japanPackageItemId,
          product_group_id: poolItem.productGroupId,
          product_title: poolItem.productTitle,
          variant_name: poolItem.displayName,
          sku: poolItem.sku,
          note: poolItem.note,
          quantity: poolItem.availableQty,
          checked: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }
    setSelectedItems(updated);
    saveItems(updated);
  }, [selectedItems, id]);

  const removeItem = useCallback((itemId: string) => {
    const updated = selectedItems.filter(i => i.id !== itemId);
    setSelectedItems(updated);
    saveItems(updated);
  }, [selectedItems]);

  const removeGroupItems = useCallback((groupName: string, items: OutboundShipmentItem[]) => {
    if (items.length === 0) return;
    if (!confirm(`確認刪除「${groupName}」底下全部 ${items.length} 項商品？`)) return;

    const itemIds = new Set(items.map(item => item.id));
    const updated = selectedItems.filter(item => !itemIds.has(item.id));
    setSelectedItems(updated);
    saveItems(updated);
  }, [selectedItems]);

  const updateItemQty = useCallback((itemId: string, delta: number) => {
    const updated = selectedItems.map(i => {
      if (i.id !== itemId) return i;
      const poolItem = poolItems.find(p => p.japanPackageItemId === i.japan_package_item_id);
      const maxQty = poolItem ? poolItem.availableQty : i.quantity;
      const newQty = Math.max(1, Math.min(i.quantity + delta, maxQty));
      return { ...i, quantity: newQty };
    });
    setSelectedItems(updated);
    saveItems(updated);
  }, [selectedItems, poolItems]);

  const toggleChecked = useCallback((itemId: string) => {
    const updated = selectedItems.map(i => {
      if (i.id !== itemId) return i;
      return { ...i, checked: !i.checked, checked_at: !i.checked ? new Date().toISOString() : undefined };
    });
    setSelectedItems(updated);
    saveItems(updated);
  }, [selectedItems]);

  const addManualItem = useCallback(() => {
    const name = manualName.trim();
    if (!name) return;
    const qty = parseInt(manualQty) || 1;
    const twdPrice = manualTwdPrice.trim() === '' ? undefined : Number(manualTwdPrice);
    const newItem: OutboundShipmentItem = {
      id: crypto.randomUUID(),
      outbound_shipment_id: id!,
      sku: manualSku.trim() || undefined,
      product_title: name,
      variant_name: manualVariant.trim() || undefined,
      quantity: qty,
      checked: false,
      note: twdPrice !== undefined && Number.isFinite(twdPrice)
        ? `${MANUAL_TWD_PRICE_PREFIX}${twdPrice}`
        : undefined,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const updated = [...selectedItems, newItem];
    setSelectedItems(updated);
    saveItems(updated);
    setManualSku('');
    setManualName('');
    setManualVariant('');
    setManualTwdPrice('');
    setManualQty('1');
    setShowManualAdd(false);
  }, [selectedItems, id, manualSku, manualName, manualVariant, manualTwdPrice, manualQty]);

  const saveItems = async (items: OutboundShipmentItem[]) => {
    const otherItems = allShipmentItems.filter(i => i.outbound_shipment_id !== id);
    const all = [...otherItems, ...items];
    setAllShipmentItems(all);
    await dataProvider.saveOutboundShipmentItems(all);
  };

  const clearAllItems = useCallback(() => {
    if (!confirm(`確認清空全部 ${selectedItems.length} 項商品？`)) return;
    setSelectedItems([]);
    saveItems([]);
  }, [selectedItems]);

  const deleteShipment = async () => {
    if (!confirm(`確認刪除出庫單「${shipment?.title}」？此操作無法復原。`)) return;
    const updated = allShipments.filter(s => s.id !== id);
    await dataProvider.saveOutboundShipments(updated);
    const updatedItems = allShipmentItems.filter(i => i.outbound_shipment_id !== id);
    await dataProvider.saveOutboundShipmentItems(updatedItems);
    navigate('/outbound-shipments');
  };

  const inventoryBySku = useMemo(() => {
    const map = new Map<string, InventoryItem>();
    for (const inv of inventoryItems) {
      map.set(inv.myacg_item_code, inv);
    }
    return map;
  }, [inventoryItems]);

  const exportMyAcgXLS = () => {
    if (!shipment || selectedItems.length === 0) return;

    const rows = selectedItems.map(item => {
      const inv = item.sku ? inventoryBySku.get(item.sku) : undefined;
      const manualTwdPrice = getManualTwdPrice(item.note);
      return {
        '主編號(多規格編號)': inv?.myacg_parent_code || '',
        '子編號(商品編號)': item.sku || '',
        '產品編號': '',
        '商品名稱': item.product_title || '',
        '規格/項目': item.variant_name || '',
        '商品類型': inv?.listing_type || '',
        '價格': manualTwdPrice !== undefined ? manualTwdPrice : inv ? `${inv.final_price}元` : '',
        '庫存': item.quantity,
        '銷售': inv?.myacg_sold_quantity ?? 0,
        '刊登時間': inv?.myacg_listed_at || '',
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, `${shipment.title}_商品清單.xls`);
  };

  const exportInboundXLS = () => {
    if (!shipment || selectedItems.length === 0) return;

    const rows = selectedItems.map(item => ({
      '商品編號(SKU)': item.sku || '',
      '商品名稱': item.product_title || '',
      '規格/項目': item.variant_name || '',
      '入庫數量': item.quantity,
      '國際追蹤號碼': shipment.tracking_number || '',
      '物流商': shipment.carrier || '',
      '出庫單名稱': shipment.title || '',
      '出庫日期': shipment.created_at ? shipment.created_at.slice(0, 10) : '',
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, `${shipment.title}_入庫單.xls`);
  };

  const saveHeader = async () => {
    if (!shipment) return;
    const updated: OutboundShipment = {
      ...shipment,
      title: formTitle || shipment.title,
      carrier: formCarrier || undefined,
      tracking_number: formTracking || undefined,
      weight_kg: formWeight ? parseFloat(formWeight) : undefined,
      shipping_cost: formCost ? parseFloat(formCost) : undefined,
      note: formNote || undefined,
      updated_at: new Date().toISOString(),
    };
    setShipment(updated);
    const all = allShipments.map(s => s.id === id ? updated : s);
    setAllShipments(all);
    await dataProvider.saveOutboundShipments(all);
    setShowHeaderEdit(false);
  };

  const updateStatus = async (newStatus: string) => {
    if (!shipment) return;
    const updated: OutboundShipment = {
      ...shipment,
      status: newStatus,
      shipped_at: newStatus === 'shipped' ? new Date().toISOString().slice(0, 10) : shipment.shipped_at,
      received_at: newStatus === 'received' ? new Date().toISOString().slice(0, 10) : shipment.received_at,
      updated_at: new Date().toISOString(),
    };
    setShipment(updated);
    const all = allShipments.map(s => s.id === id ? updated : s);
    setAllShipments(all);
    await dataProvider.saveOutboundShipments(all);
  };

  if (isLoading) return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>載入中...</div>;
  if (!shipment) return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>找不到此出庫單</div>;

  const badge = getStatusBadge(shipment.status);
  const checkedCount = selectedItems.filter(i => i.checked).length;
  const totalQty = selectedItems.reduce((sum, i) => sum + i.quantity, 0);

  return (
    <div style={{ padding: isMobile ? '12px' : '20px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => navigate('/outbound-shipments')} style={{
          display: 'flex', alignItems: 'center', gap: 4, background: 'none',
          border: 'none', color: '#3b82f6', fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 8,
        }}>
          <ArrowLeft size={16} /> 返回出庫清單
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{shipment.title}</h1>
          <span style={{
            padding: '3px 12px', borderRadius: 12, fontSize: 12, fontWeight: 600,
            background: badge.bg, color: badge.color, flexShrink: 0,
          }}>{STATUS_LABELS[shipment.status] || shipment.status}</span>
          <button onClick={() => setShowHeaderEdit(!showHeaderEdit)} style={{
            background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 4,
          }}>✏️</button>
        </div>
        {!isMobile && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {STATUS_FLOW.map(s => (
              <button
                key={s}
                disabled={shipment.status === s}
                onClick={() => updateStatus(s)}
                style={{
                  padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                  border: shipment.status === s ? '2px solid #3b82f6' : '1px solid #e2e8f0',
                  background: shipment.status === s ? '#eff6ff' : '#fff',
                  color: shipment.status === s ? '#1d4ed8' : '#64748b',
                  opacity: shipment.status === s ? 1 : 0.8,
                }}
              >{STATUS_LABELS[s]}</button>
            ))}
          </div>
        )}

        {/* Info bar */}
        <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 13, color: '#64748b', flexWrap: 'wrap', alignItems: 'center' }}>
          <span>📦 {selectedItems.length} 項，共 {totalQty} 件</span>
          {shipment.carrier && <span>🚚 {shipment.carrier}</span>}
          {shipment.tracking_number && <span>#{shipment.tracking_number}</span>}
          {shipment.weight_kg && <span>⚖️ {shipment.weight_kg}kg</span>}
          {shipment.shipping_cost && <span>💰 ¥{shipment.shipping_cost}</span>}
          {shipment.status === 'received' && (
            <span>✅ 點收進度 {checkedCount}/{selectedItems.length} ({selectedItems.length > 0 ? Math.round((checkedCount / selectedItems.length) * 100) : 0}%)</span>
          )}
        </div>

        {/* Action buttons based on status */}
        {shipment.status === 'draft' && selectedItems.length > 0 && (
          <button onClick={() => updateStatus('packing')} style={{
            marginTop: 12, padding: '10px 24px', background: '#f59e0b', color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}>開始打包</button>
        )}
        {shipment.status === 'packing' && selectedItems.length > 0 && (
          <button onClick={() => {
            if (confirm(`確認打包完成？共 ${selectedItems.length} 項、${totalQty} 件將標記為已出貨。`)) {
              updateStatus('shipped');
            }
          }} style={{
            marginTop: 12, padding: '10px 24px', background: '#22c55e', color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}>✓ 確認打包完成，標記已出貨</button>
        )}
        {shipment.status === 'shipped' && (
          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button onClick={() => setEditingShipped(!editingShipped)} style={{
              padding: '10px 24px', background: editingShipped ? '#e2e8f0' : '#fff', color: '#475569',
              border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}><Edit3 size={16} /> {editingShipped ? '完成修改' : '修改包裹內容'}</button>
            <button onClick={() => {
              if (confirm('確認此箱已到達台灣？將進入點貨模式。')) {
                setEditingShipped(false);
                updateStatus('received');
              }
            }} style={{
              padding: '10px 24px', background: '#3b82f6', color: '#fff',
              border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>📦 已達台灣，開始點貨</button>
          </div>
        )}

        {/* Toolbar */}
        <div style={{
          display: 'flex', gap: 8, marginTop: 12,
          flexWrap: isMobile ? 'nowrap' : 'wrap',
          overflowX: isMobile ? 'auto' : 'visible',
          WebkitOverflowScrolling: 'touch',
        }}>
          {selectedItems.length > 0 && (<>
            <button onClick={exportMyAcgXLS} style={{
              padding: '8px 12px', background: '#fff', color: '#475569',
              border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>📄 匯出 XLS</button>
            <button onClick={exportInboundXLS} style={{
              padding: '8px 12px', background: '#fff', color: '#475569',
              border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>📦 匯出入庫單</button>
          </>)}
          {selectedItems.length > 1 && (
            <button onClick={clearAllItems} style={{
              padding: '8px 12px', background: '#fff', color: '#dc2626',
              border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>清空全部</button>
          )}
          <button onClick={deleteShipment} style={{
            padding: '8px 12px', background: '#fff', color: '#dc2626',
            border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
            whiteSpace: 'nowrap', flexShrink: 0,
            marginLeft: isMobile ? 0 : 'auto',
          }}>刪除出庫單</button>
        </div>
      </div>

      {/* Header edit form */}
      {showHeaderEdit && (
        <div style={{
          background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
          padding: 16, marginBottom: 16,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
            <label style={{ fontSize: 13 }}>
              <span style={{ color: '#64748b' }}>名稱</span>
              <input value={formTitle} onChange={e => setFormTitle(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, marginTop: 4, boxSizing: 'border-box' }} />
            </label>
            <label style={{ fontSize: 13 }}>
              <span style={{ color: '#64748b' }}>物流商</span>
              <input value={formCarrier} onChange={e => setFormCarrier(e.target.value)} placeholder="例：日本郵便"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, marginTop: 4, boxSizing: 'border-box' }} />
            </label>
            <label style={{ fontSize: 13 }}>
              <span style={{ color: '#64748b' }}>追蹤號碼</span>
              <input value={formTracking} onChange={e => setFormTracking(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, marginTop: 4, boxSizing: 'border-box' }} />
            </label>
            <label style={{ fontSize: 13 }}>
              <span style={{ color: '#64748b' }}>重量 (kg)</span>
              <input type="number" value={formWeight} onChange={e => setFormWeight(e.target.value)} step="0.1"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, marginTop: 4, boxSizing: 'border-box' }} />
            </label>
            <label style={{ fontSize: 13 }}>
              <span style={{ color: '#64748b' }}>運費</span>
              <input type="number" value={formCost} onChange={e => setFormCost(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, marginTop: 4, boxSizing: 'border-box' }} />
            </label>
            <label style={{ fontSize: 13 }}>
              <span style={{ color: '#64748b' }}>備註</span>
              <input value={formNote} onChange={e => setFormNote(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, marginTop: 4, boxSizing: 'border-box' }} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={saveHeader} style={{
              padding: '8px 20px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>儲存</button>
            <button onClick={() => setShowHeaderEdit(false)} style={{
              padding: '8px 16px', background: '#e2e8f0', color: '#475569', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer',
            }}>取消</button>
          </div>
        </div>
      )}

      {/* Dual panel */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: (isMobile || shipment.status === 'received') ? '1fr' : '1fr 1fr',
        gap: 16,
        minHeight: 400,
      }}>
        {/* LEFT: Selected items */}
        <div style={{
          border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid #e2e8f0',
            background: '#f8fafc', fontWeight: 600, fontSize: 14,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>📋 出庫清單 ({selectedItems.length} 項，{totalQty} 件)</span>
            <button onClick={() => setShowManualAdd(!showManualAdd)} style={{
              padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              background: showManualAdd ? '#e2e8f0' : '#f1f5f9', color: '#475569',
              border: '1px solid #e2e8f0', cursor: 'pointer',
            }}>{showManualAdd ? '取消' : '+ 手動新增'}</button>
          </div>
          {showManualAdd && (
            <div style={{ padding: '8px 12px', borderBottom: '1px solid #e2e8f0', background: '#fefce8' }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'end' }}>
                <div style={{ flex: 1, minWidth: 110 }}>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>SKU（商品編號）</div>
                  <input value={manualSku} onChange={e => setManualSku(e.target.value)}
                    placeholder="例：G01234567"
                    onKeyDown={e => e.key === 'Enter' && addManualItem()}
                    style={{ width: '100%', padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div style={{ flex: 2, minWidth: 120 }}>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>商品名稱 *</div>
                  <input value={manualName} onChange={e => setManualName(e.target.value)}
                    placeholder="例：現場購入零食"
                    onKeyDown={e => e.key === 'Enter' && addManualItem()}
                    style={{ width: '100%', padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div style={{ flex: 1, minWidth: 80 }}>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>規格</div>
                  <input value={manualVariant} onChange={e => setManualVariant(e.target.value)}
                    placeholder="選填"
                    onKeyDown={e => e.key === 'Enter' && addManualItem()}
                    style={{ width: '100%', padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div style={{ width: 100 }}>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>台幣單價</div>
                  <input type="number" value={manualTwdPrice} onChange={e => setManualTwdPrice(e.target.value)} min="0" step="1"
                    placeholder="選填"
                    onKeyDown={e => e.key === 'Enter' && addManualItem()}
                    style={{ width: '100%', padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div style={{ width: 60 }}>
                  <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>數量</div>
                  <input type="number" value={manualQty} onChange={e => setManualQty(e.target.value)} min="1"
                    onKeyDown={e => e.key === 'Enter' && addManualItem()}
                    style={{ width: '100%', padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <button onClick={addManualItem} style={{
                  padding: '6px 14px', background: '#3b82f6', color: '#fff', border: 'none',
                  borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
                }}>加入</button>
              </div>
            </div>
          )}
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {selectedItems.length === 0 && !showManualAdd ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 14 }}>
                從右邊商品池雙擊加入商品
              </div>
            ) : (() => {
              const grouped = new Map<string, OutboundShipmentItem[]>();
              for (const item of selectedItems) {
                const key = cleanProductTitle(item.product_title || '') || item.product_title || '未分類';
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key)!.push(item);
              }
              return Array.from(grouped.entries()).map(([groupName, items]) => {
                const groupQty = items.reduce((s, i) => s + i.quantity, 0);
                const isCollapsed = collapsedSelectedGroups.has(groupName);
                const groupChecked = items.filter(i => i.checked).length;
                const groupPercent = items.length > 0 ? Math.round((groupChecked / items.length) * 100) : 0;
                const canEditGroup = shipment.status === 'draft' || shipment.status === 'packing' || (shipment.status === 'shipped' && editingShipped);
                return (
                  <div key={groupName} style={{ marginBottom: 8 }}>
                    <div
                      onClick={() => setCollapsedSelectedGroups(prev => {
                        const next = new Set(prev);
                        if (next.has(groupName)) next.delete(groupName);
                        else next.add(groupName);
                        return next;
                      })}
                      style={{
                        padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                        background: '#f8fafc', border: '1px solid #f1f5f9',
                        minHeight: 44,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                        {isCollapsed ? <ChevronDown size={16} style={{ flexShrink: 0, marginTop: 2 }} /> : <ChevronUp size={16} style={{ flexShrink: 0, marginTop: 2 }} />}
                        <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>
                          {groupName}
                        </span>
                        {canEditGroup && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeGroupItems(groupName, items);
                            }}
                            title="刪除此群組的全部商品"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              padding: '4px 8px', borderRadius: 6,
                              border: '1px solid #fecaca', background: '#fff7f7',
                              color: '#dc2626', fontSize: 12, fontWeight: 700,
                              cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                            }}
                          >
                            <Trash2 size={13} />
                            全部刪除
                          </button>
                        )}
                      </div>
                      <div style={{ paddingLeft: 22, marginTop: 4 }}>
                        <span style={{ fontSize: 12, color: '#64748b' }}>
                          {shipment.status === 'received'
                            ? `完成 ${groupChecked}/${items.length} (${groupPercent}%)`
                            : `${items.length > 1 ? `${items.length} 規格，` : ''}共 ${groupQty} 件`
                          }
                        </span>
                        {shipment.status === 'received' && (
                          <div style={{ width: '100%', height: 5, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
                            <div style={{ width: `${groupPercent}%`, height: '100%', background: '#10b981', borderRadius: 3, transition: 'width 0.3s' }} />
                          </div>
                        )}
                      </div>
                    </div>
                    {!isCollapsed && items.map(item => {
                      const canEdit = shipment.status === 'draft' || shipment.status === 'packing' || (shipment.status === 'shipped' && editingShipped);
                      const isReceived = shipment.status === 'received';
                      const itemLabel = (() => {
                        if (!item.japan_package_item_id) return item.variant_name || '單一規格';
                        const jpi = japanPackageItems.find(j => j.id === item.japan_package_item_id);
                        if (!jpi) return item.variant_name || '單一規格';
                        return [jpi.category_name, jpi.variant_name].filter(Boolean).join(' — ') || '單一規格';
                      })();

                      return (
                        <div
                          key={item.id}
                          onClick={isReceived ? () => toggleChecked(item.id) : undefined}
                          style={{
                            padding: isReceived ? '12px 14px 12px 24px' : '8px 10px 8px 24px',
                            borderRadius: 8, marginTop: 2,
                            background: item.checked ? '#f0fdf4' : '#fff',
                            border: '1px solid',
                            borderColor: item.checked ? '#bbf7d0' : isReceived ? '#e2e8f0' : 'transparent',
                            cursor: isReceived ? 'pointer' : 'default',
                            transition: 'all 0.2s',
                          }}
                        >
                          {/* Name row */}
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                            {isReceived && (
                              <div style={{
                                width: 24, height: 24, borderRadius: 6, marginTop: 2,
                                border: '2px solid', borderColor: item.checked ? '#10b981' : '#cbd5e1',
                                background: item.checked ? '#10b981' : '#fff', color: '#fff',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                flexShrink: 0,
                              }}>
                                {item.checked && <CheckSquare size={16} />}
                              </div>
                            )}
                            <div style={{ flex: 1 }}>
                              <div style={{
                                fontWeight: isReceived ? 700 : 500,
                                color: item.checked ? '#047857' : '#334155',
                                fontSize: 14,
                              }}>
                                <span>{itemLabel}</span>
                                {(isReceived || (shipment.status === 'shipped' && !editingShipped)) && (
                                  <span style={{ marginLeft: 8, color: '#2563eb', fontWeight: 800 }}>×{item.quantity}</span>
                                )}
                              </div>
                              {(item.sku || getManualTwdPrice(item.note) !== undefined) && (
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: '#94a3b8' }}>
                                  {item.sku && <span>{item.sku}</span>}
                                  {getManualTwdPrice(item.note) !== undefined && (
                                    <span>台幣單價 NT$ {getManualTwdPrice(item.note)!.toLocaleString()}</span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          {/* Controls row */}
                          {canEdit && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                              <div style={{ display: 'flex', alignItems: 'center' }}>
                                <button onClick={() => updateItemQty(item.id, -1)} style={{
                                  width: 44, height: 44, borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
                                  border: '1px solid #cbd5e1', borderRight: 'none',
                                  background: '#f8fafc', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 18, fontWeight: 700, color: '#475569',
                                  userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation',
                                }}><Minus size={16} /></button>
                                <span style={{
                                  width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 16, fontWeight: 600, borderTop: '1px solid #cbd5e1', borderBottom: '1px solid #cbd5e1',
                                }}>{item.quantity}</span>
                                <button onClick={() => updateItemQty(item.id, 1)} style={{
                                  width: 44, height: 44, borderTopRightRadius: 6, borderBottomRightRadius: 6,
                                  border: '1px solid #cbd5e1', borderLeft: 'none',
                                  background: '#f8fafc', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 18, fontWeight: 700, color: '#475569',
                                  userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation',
                                }}><Plus size={16} /></button>
                              </div>
                              <button onClick={() => removeItem(item.id)} style={{
                                width: 40, height: 40, borderRadius: 8, background: 'none', border: 'none',
                                color: '#ef4444', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                touchAction: 'manipulation',
                              }}><Trash2 size={18} /></button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              });
            })()}
          </div>
        </div>

        {/* RIGHT: Pool — hidden in received mode */}
        {shipment.status !== 'received' && <div style={{
          border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid #e2e8f0',
            background: '#f8fafc', fontWeight: 600, fontSize: 14,
          }}>
            🏭 倉庫商品池 ({poolItems.length} 項可出庫)
          </div>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: '#94a3b8' }} />
              <input
                placeholder="搜尋商品名稱、規格、SKU..."
                value={poolSearch}
                onChange={e => setPoolSearch(e.target.value)}
                style={{
                  width: '100%', padding: '8px 10px 8px 32px', border: '1px solid #e2e8f0',
                  borderRadius: 8, fontSize: 16, outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {groupedPool.size === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 14 }}>
                <PackageOpen size={36} style={{ opacity: 0.3, marginBottom: 8 }} />
                <p>目前沒有可出庫的商品</p>
                <p style={{ fontSize: 12 }}>請確認日本包裹的狀態為「已到貨」或「已點收」</p>
              </div>
            ) : (
              Array.from(groupedPool.entries()).map(([groupName, items]) => {
                const isExpanded = expandedGroups.has(groupName);
                const remainingItems = items.filter(i => {
                  const sel = selectedItems.find(s => s.japan_package_item_id === i.japanPackageItemId);
                  return i.availableQty - (sel?.quantity || 0) > 0;
                });
                if (remainingItems.length === 0) return null;
                const totalAvailable = remainingItems.reduce((s, i) => {
                  const sel = selectedItems.find(si => si.japan_package_item_id === i.japanPackageItemId);
                  return s + (i.availableQty - (sel?.quantity || 0));
                }, 0);
                return (
                  <div key={groupName} style={{ marginBottom: 6 }}>
                    {/* Group header */}
                    <div
                      style={{
                        padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                        background: '#f8fafc', border: '1px solid #f1f5f9',
                        minHeight: 44,
                      }}
                      onClick={() => toggleGroup(groupName)}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                        {isExpanded ? <ChevronUp size={16} style={{ flexShrink: 0, marginTop: 2 }} /> : <ChevronDown size={16} style={{ flexShrink: 0, marginTop: 2 }} />}
                        <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>
                          {groupName}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, paddingLeft: 22 }}>
                        <span style={{ fontSize: 12, color: '#64748b' }}>{remainingItems.length} 規格，共 {totalAvailable} 件</span>
                        <button
                          onClick={e => { e.stopPropagation(); addGroupToShipment(items); }}
                          style={{
                            padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                            background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer',
                            touchAction: 'manipulation',
                          }}
                        >全部加入</button>
                      </div>
                    </div>
                    {/* Group items */}
                    {isExpanded && items.map(poolItem => {
                      const alreadySelected = selectedItems.find(i => i.japan_package_item_id === poolItem.japanPackageItemId);
                      const remainingQty = poolItem.availableQty - (alreadySelected?.quantity || 0);
                      if (remainingQty <= 0) return null;
                      return (
                        <div
                          key={poolItem.japanPackageItemId}
                          onDoubleClick={() => addItemToShipment(poolItem)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '10px 10px 10px 28px', borderRadius: 6, marginTop: 2,
                            cursor: 'pointer',
                            background: '#fff',
                            minHeight: 44,
                          }}
                          title="點擊加入出庫單"
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 14 }}>{poolItem.displayName}</span>
                            {poolItem.sku && <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 6 }}>{poolItem.sku}</span>}
                          </div>
                          <span style={{ fontSize: 12, color: '#64748b', flexShrink: 0 }}>
                            可出 {remainingQty}/{poolItem.availableQty}
                          </span>
                          <button
                            onClick={e => { e.stopPropagation(); addItemToShipment(poolItem); }}
                            style={{
                              width: 40, height: 40, borderRadius: 8, border: '1px solid #cbd5e1',
                              background: '#f8fafc', cursor: 'pointer', display: 'flex',
                              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                              touchAction: 'manipulation',
                            }}
                          ><Plus size={18} /></button>
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>}
      </div>
    </div>
  );
}
