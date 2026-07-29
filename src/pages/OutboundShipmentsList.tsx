import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageOpen, Plus, Search, Truck, PackageCheck, Archive, FileEdit, ChevronRight } from 'lucide-react';
import { dataProvider } from '../providers/dataProvider';
import type { OutboundShipment, OutboundShipmentItem } from '../lib/db';
import { useViewport } from '../contexts/ViewportContext';

const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'packing', label: '打包中' },
  { value: 'shipped', label: '已出貨' },
  { value: 'received', label: '已到台灣' },
];

const getStatusBadge = (status: string) => {
  switch (status) {
    case 'draft': return { label: '草稿', bg: '#f1f5f9', color: '#64748b' };
    case 'packing': return { label: '打包中', bg: '#fef3c7', color: '#92400e' };
    case 'shipped': return { label: '已出貨', bg: '#dbeafe', color: '#1e40af' };
    case 'received': return { label: '已到台灣', bg: '#dcfce7', color: '#166534' };
    default: return { label: status, bg: '#f1f5f9', color: '#64748b' };
  }
};

export default function OutboundShipmentsList() {
  const navigate = useNavigate();
  const { isMobile } = useViewport();

  const [shipments, setShipments] = useState<OutboundShipment[]>([]);
  const [shipmentItems, setShipmentItems] = useState<OutboundShipmentItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [s, si] = await Promise.all([
        dataProvider.getOutboundShipments(),
        dataProvider.getOutboundShipmentItems(),
      ]);
      setShipments(s);
      setShipmentItems(si);
    } catch (e) {
      console.error('[OutboundShipmentsList] load failed:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredShipments = useMemo(() => {
    let list = shipments;
    if (statusFilter !== 'all') {
      list = list.filter(s => s.status === statusFilter);
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      list = list.filter(s =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.tracking_number || '').toLowerCase().includes(q) ||
        (s.carrier || '').toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }, [shipments, statusFilter, searchTerm]);

  const getItemCount = (shipmentId: string) =>
    shipmentItems.filter(i => i.outbound_shipment_id === shipmentId).length;

  const getTotalQty = (shipmentId: string) =>
    shipmentItems.filter(i => i.outbound_shipment_id === shipmentId).reduce((sum, i) => sum + i.quantity, 0);

  const handleCreate = async () => {
    const title = newTitle.trim() || `出庫 ${new Date().toISOString().slice(0, 10)}`;
    const newShipment: OutboundShipment = {
      id: crypto.randomUUID(),
      title,
      status: 'draft',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const updated = [newShipment, ...shipments];
    setShipments(updated);
    await dataProvider.saveOutboundShipments(updated);
    setShowCreateForm(false);
    setNewTitle('');
    navigate(`/outbound-shipments/${newShipment.id}`);
  };

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: shipments.length };
    for (const s of shipments) {
      counts[s.status] = (counts[s.status] || 0) + 1;
    }
    return counts;
  }, [shipments]);

  return (
    <div style={{ padding: isMobile ? '16px' : '24px 32px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>出庫管理</h1>
          <p style={{ color: '#64748b', fontSize: 14, margin: '4px 0 0' }}>管理從日本寄回台灣的出庫單</p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '10px 18px', background: '#3b82f6', color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <Plus size={16} /> 新增出庫單
        </button>
      </div>

      {/* Summary Dashboard */}
      {shipments.length > 0 && (() => {
        const packingShipments = shipments.filter(s => s.status === 'packing');
        const shippedShipments = shipments.filter(s => s.status === 'shipped');
        const draftCount = shipments.filter(s => s.status === 'draft').length;
        const packingItems = packingShipments.flatMap(s =>
          shipmentItems.filter(i => i.outbound_shipment_id === s.id)
        );
        const shippedItems = shippedShipments.flatMap(s =>
          shipmentItems.filter(i => i.outbound_shipment_id === s.id)
        );

        if (draftCount === 0 && packingShipments.length === 0 && shippedShipments.length === 0) return null;

        return (
          <div style={{
            display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
            gap: 12, marginBottom: 20,
          }}>
            {/* Draft count */}
            {draftCount > 0 && (
              <div style={{
                background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 16px',
              }}>
                <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 4 }}>草稿</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#64748b' }}>{draftCount} 箱</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>尚未開始打包</div>
              </div>
            )}

            {/* Packing */}
            {packingShipments.length > 0 && (
              <div style={{
                background: '#fffbeb', border: '1px solid #fef3c7', borderRadius: 10, padding: '14px 16px',
              }}>
                <div style={{ fontSize: 12, color: '#92400e', fontWeight: 600, marginBottom: 4 }}>打包中</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#92400e' }}>
                  {packingShipments.length} 箱
                  <span style={{ fontSize: 13, fontWeight: 500, marginLeft: 6 }}>
                    ({packingItems.reduce((s, i) => s + i.quantity, 0)} 件)
                  </span>
                </div>
                {packingShipments.map(s => {
                  const items = shipmentItems.filter(i => i.outbound_shipment_id === s.id);
                  return (
                    <div key={s.id} onClick={() => navigate(`/outbound-shipments/${s.id}`)}
                      style={{ fontSize: 12, color: '#78350f', marginTop: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <ChevronRight size={12} />
                      <span style={{ fontWeight: 500 }}>{s.title}</span>
                      <span style={{ color: '#92400e' }}>— {items.length} 項 {items.reduce((sum, i) => sum + i.quantity, 0)} 件</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Shipped in transit */}
            {shippedShipments.length > 0 && (
              <div style={{
                background: '#eff6ff', border: '1px solid #dbeafe', borderRadius: 10, padding: '14px 16px',
              }}>
                <div style={{ fontSize: 12, color: '#1e40af', fontWeight: 600, marginBottom: 4 }}>運送中</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#1e40af' }}>
                  {shippedShipments.length} 箱
                  <span style={{ fontSize: 13, fontWeight: 500, marginLeft: 6 }}>
                    ({shippedItems.reduce((s, i) => s + i.quantity, 0)} 件)
                  </span>
                </div>
                {shippedShipments.map(s => (
                  <div key={s.id} onClick={() => navigate(`/outbound-shipments/${s.id}`)}
                    style={{ fontSize: 12, color: '#1e3a5f', marginTop: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <ChevronRight size={12} />
                    <span style={{ fontWeight: 500 }}>{s.title}</span>
                    {s.tracking_number && <span style={{ color: '#3b82f6' }}>#{s.tracking_number}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {showCreateForm && (
        <div style={{
          background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
          padding: 16, marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center',
          boxSizing: 'border-box',
        }}>
          <input
            autoFocus
            placeholder={`出庫 ${new Date().toISOString().slice(0, 10)}`}
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            style={{
              flex: 1, minWidth: 0, padding: '10px 14px', border: '1px solid #cbd5e1',
              borderRadius: 8, fontSize: 16, outline: 'none', boxSizing: 'border-box',
            }}
          />
          <button onClick={handleCreate} style={{
            padding: '10px 16px', background: '#3b82f6', color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
            flexShrink: 0,
          }}>建立</button>
          <button onClick={() => { setShowCreateForm(false); setNewTitle(''); }} style={{
            padding: '10px 12px', background: '#e2e8f0', color: '#475569',
            border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer',
            flexShrink: 0,
          }}>取消</button>
        </div>
      )}

      {/* Status filter */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {STATUS_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setStatusFilter(opt.value)}
            style={{
              padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 500,
              border: statusFilter === opt.value ? '2px solid #3b82f6' : '1px solid #e2e8f0',
              background: statusFilter === opt.value ? '#eff6ff' : '#fff',
              color: statusFilter === opt.value ? '#1d4ed8' : '#64748b',
              cursor: 'pointer',
            }}
          >
            {opt.label} ({statusCounts[opt.value] || 0})
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <Search size={16} style={{ position: 'absolute', left: 12, top: 12, color: '#94a3b8' }} />
        <input
          placeholder="搜尋出庫單名稱、追蹤號碼..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          style={{
            width: '100%', padding: '10px 14px 10px 36px', border: '1px solid #e2e8f0',
            borderRadius: 10, fontSize: 14, outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* List */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>載入中...</div>
      ) : filteredShipments.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <PackageOpen size={48} style={{ marginBottom: 12, opacity: 0.3 }} />
          <p>目前沒有出庫單</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filteredShipments.map(s => {
            const badge = getStatusBadge(s.status);
            const itemCount = getItemCount(s.id);
            const totalQty = getTotalQty(s.id);
            return (
              <div
                key={s.id}
                onClick={() => navigate(`/outbound-shipments/${s.id}`)}
                style={{
                  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
                  padding: '14px 18px', cursor: 'pointer',
                  transition: 'box-shadow 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)')}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16, fontWeight: 600 }}>{s.title}</span>
                    <span style={{
                      padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                      background: badge.bg, color: badge.color,
                    }}>{badge.label}</span>
                  </div>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>
                    {s.created_at ? new Date(s.created_at).toLocaleDateString('zh-TW') : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 13, color: '#64748b' }}>
                  <span>📦 {itemCount} 項商品，共 {totalQty} 件</span>
                  {s.carrier && <span>🚚 {s.carrier}</span>}
                  {s.tracking_number && <span>#{s.tracking_number}</span>}
                  {s.weight_kg && <span>⚖️ {s.weight_kg}kg</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
