import { useState, useEffect } from 'react';
import { db } from '../lib/db';
import type { SalesOrder, SalesOrderItem, ProductVariant } from '../lib/db';
import { Plus, ListOrdered } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';

export default function OrdersImport() {
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [orderItems, setOrderItems] = useState<SalesOrderItem[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [buyerName, setBuyerName] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [selectedSku, setSelectedSku] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [newOrderItems, setNewOrderItems] = useState<{sku: string, qty: number}[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [fetchedOrders, fetchedItems, fetchedVariants] = await Promise.all([
      db.getSalesOrders(),
      db.getSalesOrderItems(),
      db.getProductVariants()
    ]);
    setOrders(fetchedOrders);
    setOrderItems(fetchedItems);
    setVariants(fetchedVariants);
  };

  const handleAddItem = () => {
    if (!selectedSku || quantity <= 0) return;
    setNewOrderItems([...newOrderItems, { sku: selectedSku, qty: quantity }]);
    setSelectedSku('');
    setQuantity(1);
  };

  const handleCreateOrder = async () => {
    if (!buyerName || !orderNumber || newOrderItems.length === 0) {
      return alert('請填寫訂單資訊與至少一筆需求');
    }

    const orderId = crypto.randomUUID();
    const newOrder: SalesOrder = {
      id: orderId,
      platform: 'manual',
      order_number: orderNumber,
      buyer_name: buyerName,
      created_at: new Date().toISOString()
    };

    const newItems: SalesOrderItem[] = newOrderItems.map(item => ({
      id: crypto.randomUUID(),
      order_id: orderId,
      myacg_item_code: item.sku,
      quantity: item.qty
    }));

    const currentOrders = await db.getSalesOrders();
    const currentOrderItems = await db.getSalesOrderItems();

    await db.saveSalesOrders([...currentOrders, newOrder]);
    await db.saveSalesOrderItems([...currentOrderItems, ...newItems]);

    setIsModalOpen(false);
    setBuyerName('');
    setOrderNumber('');
    setNewOrderItems([]);
    await loadData();
  };

  return (
    <div className="flex-col gap-lg" style={{ padding: '0 24px', maxWidth: '1600px', margin: '0 auto' }}>
      <div className="flex justify-between items-center" style={{ padding: '16px 0', borderBottom: '1px solid var(--color-border)' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>訂單快速匯入</h1>
          <p className="text-muted text-sm" style={{ margin: 0, marginTop: '4px' }}>手動建檔或匯入訂單，系統將自動累加 SKU 需求數</p>
        </div>
        <div className="flex gap-sm">
          <button className="btn btn-primary" onClick={() => setIsModalOpen(true)}>
            <Plus size={16} /> 手動新增訂單
          </button>
        </div>
      </div>

      <div className="flex-col gap-md">
        {orders.length === 0 ? (
          <EmptyState
            icon={ListOrdered}
            title="尚未匯入訂單"
            description="目前沒有任何銷售訂單，您可以手動新增訂單以產生採購需求。"
            actionLabel="手動新增"
            onAction={() => setIsModalOpen(true)}
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th style={{ width: '25%' }}>訂單編號</th>
                  <th style={{ width: '25%' }}>買家名稱</th>
                  <th style={{ width: '15%' }}>平台</th>
                  <th style={{ width: '25%' }}>建立時間</th>
                  <th style={{ width: '10%', textAlign: 'right' }}>品項數</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id}>
                    <td style={{ fontWeight: 500 }}>{o.order_number}</td>
                    <td>{o.buyer_name}</td>
                    <td><span className="badge badge-neutral">{o.platform}</span></td>
                    <td className="text-muted">{new Date(o.created_at).toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {orderItems.filter(i => i.order_id === o.id).length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isModalOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div className="card flex-col gap-md" style={{ width: '600px', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ margin: 0 }}>手動新增訂單</h2>
            
            <div className="flex gap-sm">
              <div className="flex-col gap-xs" style={{ flex: 1 }}>
                <label className="text-sm font-medium">訂單編號</label>
                <input className="input" value={orderNumber} onChange={e => setOrderNumber(e.target.value)} placeholder="如: ORD-20231101" />
              </div>
              <div className="flex-col gap-xs" style={{ flex: 1 }}>
                <label className="text-sm font-medium">買家名稱</label>
                <input className="input" value={buyerName} onChange={e => setBuyerName(e.target.value)} />
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--color-border)', margin: 'var(--spacing-md) 0' }} />

            <h3 style={{ margin: 0, fontSize: '15px' }}>新增需求 SKU</h3>
            <div className="flex gap-sm items-end">
              <div className="flex-col gap-xs" style={{ flex: 2 }}>
                <label className="text-sm font-medium">選擇 SKU</label>
                <select className="input" value={selectedSku} onChange={e => setSelectedSku(e.target.value)}>
                  <option value="">-- 請選擇 --</option>
                  {variants.map(v => (
                    <option key={v.myacg_item_code} value={v.myacg_item_code}>
                      [{v.myacg_item_code}] {v.product_title} - {v.variant_name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-col gap-xs" style={{ flex: 1 }}>
                <label className="text-sm font-medium">數量</label>
                <input type="number" className="input" value={quantity} onChange={e => setQuantity(parseInt(e.target.value) || 1)} min="1" />
              </div>
              <button className="btn btn-outline" onClick={handleAddItem}>加入清單</button>
            </div>

            {newOrderItems.length > 0 && (
              <div style={{ marginTop: 'var(--spacing-md)' }}>
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th style={{ textAlign: 'right' }}>需求數量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {newOrderItems.map(item => (
                      <tr key={item.sku}>
                        <td>{item.sku}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{item.qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end gap-sm" style={{ marginTop: 'var(--spacing-lg)' }}>
              <button className="btn btn-ghost" onClick={() => setIsModalOpen(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleCreateOrder}>確認建檔</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
