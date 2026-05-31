import { useState, useEffect } from 'react';
import { dataProvider } from '../providers/dataProvider';
import type { ProductVariant } from '../lib/db';
import { AlertTriangle, AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface OverviewItem extends ProductVariant {
  group_title: string;
  group_id: string;
}

export default function Purchasing() {
  const [shortages, setShortages] = useState<OverviewItem[]>([]);
  const [excesses, setExcesses] = useState<OverviewItem[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const allGroups = await dataProvider.getProductGroups();
    const groupMap = new Map(allGroups.map(g => [g.id, g]));

    // Legacy fallback mapping
    const allCategories = await dataProvider.getProductCategories();
    const catToGroupMap = new Map(allCategories.map(c => [c.id, c.product_group_id]));

    const allVariants = await dataProvider.getProductVariants();
    const allPrivateOrderItems = await dataProvider.getPrivateOrderItems();
    const allPurchaseBatchItems = await dataProvider.getPurchaseBatchItems();
    
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

    setShortages(items.filter(i => i.diff < 0));
    setExcesses(items.filter(i => i.diff > 0));
  };

  return (
    <div className="flex-col gap-lg">
      <div className="flex justify-between items-center" style={{ marginBottom: 'var(--spacing-md)' }}>
        <div>
          <h1 style={{ marginBottom: '4px', fontSize: '20px', fontWeight: 600 }}>採購差異總覽</h1>
          <p className="text-muted text-sm" style={{ margin: 0 }}>全系統缺貨與多買快速監看。主要採購操作請至「訂購紀錄表」。</p>
        </div>
      </div>

      <div className="flex gap-lg">
        {/* Shortages */}
        <div className="card flex-col gap-sm" style={{ flex: 1, padding: 0, overflow: 'hidden' }}>
          <div className="flex items-center gap-sm" style={{ padding: '16px 20px', backgroundColor: 'rgba(218, 55, 60, 0.1)', borderBottom: '1px solid var(--color-border)' }}>
            <AlertCircle size={18} className="text-danger" />
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--color-danger)' }}>全系統缺貨 ({shortages.length})</h3>
          </div>
          <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th style={{ width: '40%' }}>母體/群組</th>
                <th style={{ width: '40%' }}>規格/項目</th>
                <th style={{ width: '20%', textAlign: 'center' }}>缺貨量</th>
              </tr>
            </thead>
            <tbody>
              {shortages.map((item: any) => (
                <tr key={item.id} onClick={() => navigate(`/purchase-records/${item.group_id}`)} style={{ cursor: 'pointer' }}>
                  <td style={{ color: 'var(--color-text-secondary)' }}>{item.group_title}</td>
                  <td style={{ fontWeight: 500 }}>{item.variant_name}</td>
                  <td className="cell-danger" style={{ textAlign: 'center' }}>{item.diff}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Excesses */}
        <div className="card flex-col gap-sm" style={{ flex: 1, padding: 0, overflow: 'hidden' }}>
          <div className="flex items-center gap-sm" style={{ padding: '16px 20px', backgroundColor: 'rgba(240, 178, 50, 0.1)', borderBottom: '1px solid var(--color-border)' }}>
            <AlertTriangle size={18} className="text-warning" />
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--color-warning)' }}>全系統多買 ({excesses.length})</h3>
          </div>
          <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th style={{ width: '40%' }}>母體/群組</th>
                <th style={{ width: '40%' }}>規格/項目</th>
                <th style={{ width: '20%', textAlign: 'center' }}>多買量</th>
              </tr>
            </thead>
            <tbody>
              {excesses.map((item: any) => (
                <tr key={item.id} onClick={() => navigate(`/purchase-records/${item.group_id}`)} style={{ cursor: 'pointer' }}>
                  <td style={{ color: 'var(--color-text-secondary)' }}>{item.group_title}</td>
                  <td style={{ fontWeight: 500 }}>{item.variant_name}</td>
                  <td className="cell-warning" style={{ textAlign: 'center' }}>+{item.diff}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
