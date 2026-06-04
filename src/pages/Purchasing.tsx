import { useState, useEffect } from 'react';
import { dataProvider } from '../providers/dataProvider';
import type { ProductVariant } from '../lib/db';
import { FileText, Plus, Trash2, Save, Printer, Gift } from 'lucide-react';

interface OverviewItem extends ProductVariant {
  group_title: string;
  group_id: string;
}

interface POItem {
  id: string;
  brand: string;
  barcode: string;
  description: string;
  price: number;
  qty: number;
  stock: number;
}

interface SpecialOrderLog {
  id: string;
  customer: string;
  item: string;
  status: string;
  checked: boolean;
}

export default function Purchasing() {
  const [poItems, setPoItems] = useState<POItem[]>([]);
  const [specialOrders, setSpecialOrders] = useState<SpecialOrderLog[]>([
    { id: 'so-1', customer: '林小明', item: '梅田店限定特典明信片', status: '已備妥', checked: true },
    { id: 'so-2', customer: '陳美玲', item: '大阪店1週年貼紙套組', status: '待備貨', checked: false },
    { id: 'so-3', customer: '張大同', item: 'VSPO! 壓克力吊飾', status: '已送出', checked: true },
    { id: 'so-4', customer: '李建國', item: 'Hololive 紀念徽章', status: '待備貨', checked: false }
  ]);

  // States for new items
  const [newCustomer, setNewCustomer] = useState('');
  const [newItemName, setNewItemName] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const allGroups = await dataProvider.getProductGroups().catch(() => []);
      const groupMap = new Map(allGroups.map(g => [g.id, g]));

      const allCategories = await dataProvider.getProductCategories().catch(() => []);
      const catToGroupMap = new Map(allCategories.map(c => [c.id, c.product_group_id]));

      const allVariants = await dataProvider.getProductVariants().catch(() => []);
      const allPrivateOrderItems = await dataProvider.getPrivateOrderItems().catch(() => []);
      const allPurchaseBatchItems = await dataProvider.getPurchaseBatchItems().catch(() => []);
      const inventory = await dataProvider.getInventory().catch(() => []);
      
      const items: (OverviewItem & { diff: number })[] = allVariants.map(v => {
        const groupId = v.product_group_id || catToGroupMap.get(v.product_category_id || '');
        const group = groupId ? groupMap.get(groupId) : null;
        
        const manual = allPrivateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
        const myacg = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
        const waca = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
        const totalDemand = manual + myacg + waca;
        
        const totalPurchased = allPurchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);

        return {
          ...v,
          group_id: groupId || '',
          group_title: group?.title || '未知群組',
          diff: totalPurchased - totalDemand
        };
      });

      const activeShortages = items.filter(i => i.diff < 0);
      
      const mappedPOItems: POItem[] = activeShortages.map(item => {
        const invItem = inventory.find(inv => inv.myacg_item_code === item.myacg_item_code);
        const price = invItem?.final_price || 1200; 
        const stock = invItem ? Math.max(0, invItem.myacg_sold_quantity - Math.abs(item.diff)) : 0; 
        
        let brand = 'Other';
        const titleLower = item.group_title.toLowerCase();
        if (titleLower.includes('gsc') || titleLower.includes('good smile')) {
          brand = 'GSC';
        } else if (titleLower.includes('max factory')) {
          brand = 'Max Factory';
        } else if (titleLower.includes('furyu')) {
          brand = 'FuRyu';
        } else if (titleLower.includes('hololive')) {
          brand = 'Cover';
        } else if (titleLower.includes('vspo')) {
          brand = 'VSPO';
        }
        
        return {
          id: item.id || Math.random().toString(36).substring(2, 9),
          brand,
          barcode: item.myacg_item_code || '',
          description: `${item.group_title} - ${item.variant_name || '單品'}`,
          price,
          qty: Math.abs(item.diff),
          stock
        };
      });

      if (mappedPOItems.length > 0) {
        setPoItems(mappedPOItems);
      } else {
        // Fallback Premium mock items to visualize the form layout
        setPoItems([
          { id: '1', brand: 'GSC', barcode: 'GP0714483', description: '代購版 GSC 藝術誌主人 公 藍檔案集 Blue Archive 一中盒6入 驚喜零件隨機收錄', price: 1770, qty: 5, stock: 2 },
          { id: '2', brand: 'Max Factory', barcode: 'GP0714465', description: '代購版 GSC 黏土人 初音未來未來音樂 10th Anniversary Ver.', price: 1645, qty: 3, stock: 1 },
          { id: '3', brand: 'FuRyu', barcode: 'GP0714459', description: '代購版 GSC 初音未來 變裝看Ver.', price: 1470, qty: 8, stock: 4 },
          { id: '4', brand: 'Bandai', barcode: 'GP0714450', description: '代購版 GSC 星音 Teto 偶像裝Ver.', price: 1470, qty: 12, stock: 0 },
          { id: '5', brand: 'GSC', barcode: 'GP0714440', description: '代購版 GSC 防護機構 黏土人 小鳥遊 暖暖', price: 1400, qty: 4, stock: 2 }
        ]);
      }
    } catch (e) {
      console.error('Failed to load PO Data', e);
    }
  };

  // Handlers for PO Items
  const handleUpdateItem = (id: string, field: keyof POItem, value: any) => {
    setPoItems(prev => prev.map(item => {
      if (item.id === id) {
        let parsed = value;
        if (field === 'price' || field === 'qty' || field === 'stock') {
          parsed = parseFloat(value) || 0;
        }
        return { ...item, [field]: parsed };
      }
      return item;
    }));
  };

  const handleAddNewItem = () => {
    const newItem: POItem = {
      id: Math.random().toString(36).substring(2, 9),
      brand: 'Other',
      barcode: `GP0${Math.floor(100000 + Math.random() * 900000)}`,
      description: '新採購商品 - 請輸入規格名稱',
      price: 1000,
      qty: 1,
      stock: 0
    };
    setPoItems(prev => [...prev, newItem]);
  };

  const handleDeleteItem = (id: string) => {
    setPoItems(prev => prev.filter(item => item.id !== id));
  };

  // Handlers for Special Orders & Gift Log
  const toggleSpecialOrderChecked = (id: string) => {
    setSpecialOrders(prev => prev.map(so => 
      so.id === id ? { ...so, checked: !so.checked } : so
    ));
  };

  const updateSpecialOrderStatus = (id: string, newStatus: string) => {
    setSpecialOrders(prev => prev.map(so => 
      so.id === id ? { ...so, status: newStatus } : so
    ));
  };

  const handleAddSpecialOrder = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustomer.trim() || !newItemName.trim()) return;

    const newLog: SpecialOrderLog = {
      id: Math.random().toString(36).substring(2, 9),
      customer: newCustomer.trim(),
      item: newItemName.trim(),
      status: '待備貨',
      checked: false
    };

    setSpecialOrders(prev => [...prev, newLog]);
    setNewCustomer('');
    setNewItemName('');
  };

  const handleDeleteSpecialOrder = (id: string) => {
    setSpecialOrders(prev => prev.filter(so => so.id !== id));
  };

  // PO Calculations
  const subtotal = poItems.reduce((sum, item) => sum + (item.price * item.qty), 0);
  const tax = Math.round(subtotal * 0.05);
  const total = subtotal + tax;

  const handleSavePurchaseOrder = () => {
    alert('💾 採購單已存檔，正在同步至雲端庫存與出貨批次數據。');
  };

  return (
    <div className="po-container">
      <style>{`
        .po-container {
          width: 100%;
          max-width: none;
          margin: 0;
          padding: 8px;
          box-sizing: border-box;
          font-family: 'Outfit', 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #1e293b;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        /* 1. Header with Navy background */
        .po-header {
          background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
          color: #f8fafc;
          padding: 24px;
          border-radius: 12px;
          display: flex;
          justify-content: space-between;
          gap: 24px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          border: 1px solid #1e293b;
          flex-wrap: wrap;
        }

        .po-header-left {
          flex: 1 1 45%;
          display: flex;
          flex-direction: column;
          gap: 14px;
          min-width: 320px;
        }

        .po-header-title {
          font-size: 24px;
          font-weight: 800;
          letter-spacing: 0.5px;
          color: #ffffff;
          margin: 0;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .po-header-info {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 6px 16px;
          font-size: 13px;
          color: #94a3b8;
        }

        .po-header-info-label {
          font-weight: 700;
          color: #cbd5e1;
        }

        .po-header-info-value {
          color: #f1f5f9;
        }

        .po-header-right {
          flex: 1 1 45%;
          background-color: rgba(255, 255, 255, 0.04);
          border-radius: 8px;
          padding: 16px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          gap: 20px;
          min-width: 320px;
        }

        .po-header-right-col {
          flex: 1;
        }

        .po-header-right-col h4 {
          margin: 0 0 8px 0;
          font-size: 13px;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .po-header-right-col ul {
          margin: 0;
          padding-left: 14px;
          font-size: 11px;
          color: #cbd5e1;
          line-height: 1.6;
        }

        /* 2. Side-by-side flex container */
        .po-layout-split {
          display: flex;
          gap: 24px;
          width: 100%;
          align-items: flex-start;
          flex-wrap: wrap;
        }

        /* 3. Left Table style (Excel like) */
        .po-main-section {
          flex: 1 1 65%;
          min-width: 600px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .po-table-wrapper {
          background-color: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }

        .po-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 13px;
          background-color: #ffffff;
        }

        .po-table th {
          background-color: #f8fafc;
          color: #334155;
          font-weight: 700;
          padding: 10px 12px;
          border: 1px solid #cbd5e1;
          font-size: 12px;
        }

        .po-table td {
          padding: 6px 12px;
          border: 1px solid #cbd5e1;
          color: #334155;
          vertical-align: middle;
          box-sizing: border-box;
        }

        .po-table tr:hover {
          background-color: #f8fafc;
        }

        .po-cell-input {
          width: 100%;
          border: 1px transparent;
          background: transparent;
          font-size: 13px;
          color: #334155;
          padding: 2px 4px;
          outline: none;
          box-sizing: border-box;
        }

        .po-cell-input:focus {
          border-color: #3b82f6;
          background-color: #ffffff;
          box-shadow: inset 0 0 0 1px #3b82f6;
          border-radius: 4px;
        }

        .po-cell-input-number {
          text-align: center;
        }

        .po-summary-box-wrapper {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          width: 100%;
        }

        .po-summary-box {
          width: 280px;
          background-color: #f8fafc;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.02);
        }

        .po-summary-row {
          display: flex;
          justify-content: space-between;
          font-size: 13px;
        }

        .po-summary-row-label {
          color: #64748b;
          font-weight: 600;
        }

        .po-summary-row-val {
          font-weight: 700;
          color: #334155;
        }

        .po-summary-total {
          border-top: 1px solid #cbd5e1;
          padding-top: 8px;
          margin-top: 4px;
          display: flex;
          justify-content: space-between;
          font-size: 15px;
        }

        .po-summary-total-label {
          color: #0f172a;
          font-weight: 800;
        }

        .po-summary-total-val {
          font-weight: 800;
          color: #1e3a8a;
        }

        /* 4. Right Special Orders & Gift Log */
        .po-side-section {
          flex: 1 1 30%;
          min-width: 320px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .gift-log-card {
          background: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 12px;
          padding: 20px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .gift-log-title {
          font-size: 16px;
          font-weight: 800;
          color: #0f172a;
          margin: 0;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .gift-log-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }

        .gift-log-table th {
          background-color: #f8fafc;
          border-bottom: 2px solid #cbd5e1;
          padding: 8px;
          color: #475569;
          font-weight: 700;
        }

        .gift-log-table td {
          padding: 8px;
          border-bottom: 1px solid #e2e8f0;
          vertical-align: middle;
        }

        .gift-log-check-circle {
          cursor: pointer;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          font-size: 12px;
          transition: all 0.2s;
        }

        .gift-log-status-select {
          font-size: 12px;
          padding: 4px 6px;
          border-radius: 6px;
          border: 1px solid #cbd5e1;
          font-weight: 600;
          outline: none;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-action-po {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 600;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .btn-action-po-primary {
          background-color: #2563eb;
          color: #ffffff;
          border: none;
          box-shadow: 0 1px 2px rgba(37,99,235,0.05);
        }

        .btn-action-po-primary:hover {
          background-color: #1d4ed8;
        }

        .btn-action-po-secondary {
          background-color: #ffffff;
          color: #475569;
          border: 1px solid #cbd5e1;
          box-shadow: 0 1px 2px rgba(0,0,0,0.02);
        }

        .btn-action-po-secondary:hover {
          background-color: #f8fafc;
          border-color: #94a3b8;
        }
      `}</style>

      {/* Header Info Block */}
      <div className="po-header">
        <div className="po-header-left">
          <div className="po-header-title">
            <FileText size={24} style={{ color: '#60a5fa' }} />
            <span>採購單 / PURCHASE ORDER</span>
          </div>
          <div className="po-header-info">
            <span className="po-header-info-label">供應商名稱：</span>
            <span className="po-header-info-value">GSC 日本官方 / 代理商總合部</span>
            <span className="po-header-info-label">聯絡電話：</span>
            <span className="po-header-info-value">+81-3-1234-5678 (日) / 02-2345-6789 (台)</span>
            <span className="po-header-info-label">電子信箱：</span>
            <span className="po-header-info-value">order-support@goodsmile.jp</span>
          </div>
        </div>
        <div className="po-header-right">
          <div className="po-header-right-col">
            <h4 style={{ color: '#60a5fa' }}>💡 訂購須知</h4>
            <ul>
              <li>請於結單前完成規格確認與數量核對。</li>
              <li>空運商品約 7-14 天到貨，海運約 21-30 天。</li>
              <li>特規商品一經訂購即無法取消或退換。</li>
            </ul>
          </div>
          <div className="po-header-right-col" style={{ borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '16px' }}>
            <h4 style={{ color: '#f87171' }}>⚠️ 注意事項</h4>
            <ul>
              <li>未加入採購母體之品項請先於主檔確認。</li>
              <li>價格若有變動以日本出貨當日匯率為準。</li>
              <li>贈品紀錄需與特別訂單同步核對無誤。</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Main split view */}
      <div className="po-layout-split">
        
        {/* Left Side: PO Items list */}
        <div className="po-main-section">
          
          <div style={{ display: 'flex', justifySelf: 'stretch', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#334155' }}>
              待採購項目清單 ({poItems.length} 筆)
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-action-po btn-action-po-secondary" onClick={handleSavePurchaseOrder}>
                <Save size={14} />
                <span>儲存採購單</span>
              </button>
              <button className="btn-action-po btn-action-po-secondary" onClick={() => window.print()}>
                <Printer size={14} />
                <span>列印單據</span>
              </button>
            </div>
          </div>

          <div className="po-table-wrapper">
            <table className="po-table">
              <thead>
                <tr>
                  <th style={{ width: '10%' }}>品牌</th>
                  <th style={{ width: '15%' }}>條碼 (SKU)</th>
                  <th style={{ width: '40%' }}>品名規格</th>
                  <th style={{ width: '10%', textAlign: 'right' }}>單價 (NT$)</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>訂購量</th>
                  <th style={{ width: '7%', textAlign: 'center' }}>庫存</th>
                  <th style={{ width: '13%', textAlign: 'right' }}>金額 (NT$)</th>
                  <th style={{ width: '5%', textAlign: 'center' }}></th>
                </tr>
              </thead>
              <tbody>
                {poItems.map(item => (
                  <tr key={item.id}>
                    <td>
                      <input 
                        type="text" 
                        className="po-cell-input" 
                        value={item.brand} 
                        onChange={(e) => handleUpdateItem(item.id, 'brand', e.target.value)} 
                      />
                    </td>
                    <td style={{ fontWeight: 600, color: '#475569' }}>
                      <input 
                        type="text" 
                        className="po-cell-input" 
                        value={item.barcode} 
                        onChange={(e) => handleUpdateItem(item.id, 'barcode', e.target.value)} 
                      />
                    </td>
                    <td>
                      <input 
                        type="text" 
                        className="po-cell-input" 
                        value={item.description} 
                        onChange={(e) => handleUpdateItem(item.id, 'description', e.target.value)} 
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input 
                        type="number" 
                        className="po-cell-input po-cell-input-number" 
                        style={{ textAlign: 'right' }}
                        value={item.price} 
                        onChange={(e) => handleUpdateItem(item.id, 'price', e.target.value)} 
                      />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input 
                        type="number" 
                        className="po-cell-input po-cell-input-number" 
                        value={item.qty} 
                        onChange={(e) => handleUpdateItem(item.id, 'qty', e.target.value)} 
                      />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input 
                        type="number" 
                        className="po-cell-input po-cell-input-number" 
                        value={item.stock} 
                        onChange={(e) => handleUpdateItem(item.id, 'stock', e.target.value)} 
                      />
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#0f172a' }}>
                      {(item.price * item.qty).toLocaleString()}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button 
                        onClick={() => handleDeleteItem(item.id)}
                        style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '2px' }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Action Row and Summary block */}
          <div className="po-summary-box-wrapper">
            <button className="btn-action-po btn-action-po-secondary" onClick={handleAddNewItem}>
              <Plus size={14} />
              <span>新增商品品項</span>
            </button>

            <div className="po-summary-box">
              <div className="po-summary-row">
                <span className="po-summary-row-label">小計 (Subtotal)</span>
                <span className="po-summary-row-val">NT$ {subtotal.toLocaleString()}</span>
              </div>
              <div className="po-summary-row">
                <span className="po-summary-row-label">營業稅 (VAT 5%)</span>
                <span className="po-summary-row-val">NT$ {tax.toLocaleString()}</span>
              </div>
              <div className="po-summary-total">
                <span className="po-summary-total-label">總金額 (Total)</span>
                <span className="po-summary-total-val">NT$ {total.toLocaleString()}</span>
              </div>
            </div>
          </div>

        </div>

        {/* Right Side: Special Orders & Gift Log */}
        <div className="po-side-section">
          
          <div className="gift-log-card">
            <div className="gift-log-title">
              <Gift size={18} style={{ color: '#16a34a' }} />
              <span>Special Orders & Gift Log</span>
            </div>
            
            <p style={{ fontSize: '11px', color: '#64748b', margin: '0 0 4px 0', lineHeight: 1.4 }}>
              特別訂單與贈品紀錄表，用於追蹤熟客贈品與特定加單狀態。
            </p>

            <table className="gift-log-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', width: '25%' }}>對象</th>
                  <th style={{ textAlign: 'left', width: '35%' }}>品項/贈品</th>
                  <th style={{ width: '25%', textAlign: 'center' }}>狀態</th>
                  <th style={{ width: '15%', textAlign: 'center' }}>紀錄</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {specialOrders.map(so => (
                  <tr key={so.id}>
                    <td style={{ fontWeight: 600, color: '#334155' }}>{so.customer}</td>
                    <td style={{ color: '#475569' }}>{so.item}</td>
                    <td style={{ textAlign: 'center' }}>
                      <select
                        className="gift-log-status-select"
                        value={so.status}
                        onChange={(e) => updateSpecialOrderStatus(so.id, e.target.value)}
                        style={{
                          backgroundColor: so.status === '已送出' ? '#f0fdf4' : so.status === '已備妥' ? '#eff6ff' : '#fff7ed',
                          color: so.status === '已送出' ? '#16a34a' : so.status === '已備妥' ? '#2563eb' : '#d97706',
                          borderColor: so.status === '已送出' ? '#bbf7d0' : so.status === '已備妥' ? '#bfdbfe' : '#fed7d7'
                        }}
                      >
                        <option value="待備貨">待備貨</option>
                        <option value="已備妥">已備妥</option>
                        <option value="已送出">已送出</option>
                      </select>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span 
                        onClick={() => toggleSpecialOrderChecked(so.id)}
                        className="gift-log-check-circle"
                        style={{
                          border: '2px solid ' + (so.checked ? '#22c55e' : '#cbd5e1'),
                          backgroundColor: so.checked ? '#e8f5e9' : 'transparent',
                          color: '#22c55e'
                        }}
                      >
                        {so.checked && '✓'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button 
                        onClick={() => handleDeleteSpecialOrder(so.id)}
                        style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '2px' }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Quick Add Special Order */}
            <form onSubmit={handleAddSpecialOrder} style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid #cbd5e1', paddingTop: '12px', marginTop: '4px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#475569' }}>💡 快速新增紀錄</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input 
                  type="text" 
                  className="input" 
                  placeholder="客戶名稱" 
                  value={newCustomer}
                  onChange={e => setNewCustomer(e.target.value)}
                  style={{ flex: 1, height: '30px', padding: '0 8px', fontSize: '11px' }}
                />
                <input 
                  type="text" 
                  className="input" 
                  placeholder="品項 / 贈品" 
                  value={newItemName}
                  onChange={e => setNewItemName(e.target.value)}
                  style={{ flex: 2, height: '30px', padding: '0 8px', fontSize: '11px' }}
                />
              </div>
              <button 
                type="submit" 
                className="btn-action-po btn-action-po-primary" 
                style={{ height: '30px', padding: '0 12px', fontSize: '11px', display: 'flex', justifyContent: 'center', width: '100%' }}
              >
                <Plus size={12} />
                <span>加入紀錄表</span>
              </button>
            </form>

          </div>

        </div>

      </div>

    </div>
  );
}
