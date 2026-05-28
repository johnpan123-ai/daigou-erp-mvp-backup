import { useState, useEffect } from 'react';
import { db } from '../lib/db';
import type { ProductGroup } from '../lib/db';
import { Receipt, Link as LinkIcon, Edit2, Save, X } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { useNavigate } from 'react-router-dom';

export default function PurchaseRecords() {
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ProductGroup>>({});
  const navigate = useNavigate();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const fetchedGroups = await db.getProductGroups();
    setGroups(fetchedGroups);
  };

  const handleEdit = (group: ProductGroup) => {
    setEditingId(group.id);
    setEditForm(group);
  };

  const handleSave = async (id: string) => {
    const updatedGroups = groups.map(g => g.id === id ? { ...g, ...editForm } as ProductGroup : g);
    await db.saveProductGroups(updatedGroups);
    setGroups(updatedGroups);
    setEditingId(null);
  };

  const handleRowClick = (id: string, e: React.MouseEvent) => {
    // Don't navigate if clicking inputs/buttons
    if ((e.target as HTMLElement).tagName === 'INPUT' || 
        (e.target as HTMLElement).tagName === 'SELECT' || 
        (e.target as HTMLElement).tagName === 'BUTTON' ||
        (e.target as HTMLElement).closest('button')) {
      return;
    }
    if (editingId === id) return;
    navigate(`/purchase-records/${id}`);
  };

  const renderPriorityBadge = (priority: string) => {
    if (priority === 'High') return <span className="badge badge-danger">高</span>;
    if (priority === 'Medium') return <span className="badge badge-warning">中</span>;
    return <span className="badge badge-success">低</span>;
  };

  return (
    <div className="flex-col gap-lg">
      <div className="flex justify-between items-center" style={{ marginBottom: 'var(--spacing-md)' }}>
        <div>
          <h1 style={{ marginBottom: '4px', fontSize: '20px', fontWeight: 600 }}>訂購紀錄表</h1>
          <p className="text-muted text-sm" style={{ margin: 0 }}>總體商品群組清單，點擊進入該群組進行採購與需求管理。</p>
        </div>
      </div>

      <div className="flex-col gap-md">
        {groups.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="尚未有訂購紀錄"
            description="您可以透過匯入商品清單來自動產生母體，或手動建立。"
            actionLabel="前往商品清單匯入"
            onAction={() => navigate('/inventory')}
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="erp-table" style={{ width: '100%', tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th style={{ width: '10%' }}>購買日</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>優先度</th>
                  <th style={{ width: '38%' }}>品項 (母體名稱)</th>
                  <th style={{ width: '12%' }}>結單日</th>
                  <th style={{ width: '12%' }}>發售月份</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>官網</th>
                  <th style={{ width: '6%', textAlign: 'center' }}>連結</th>
                  <th style={{ width: '6%', textAlign: 'center' }}>編輯</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(g => {
                  const isEditing = editingId === g.id;
                  
                  return (
                    <tr 
                      key={g.id} 
                      onClick={(e) => handleRowClick(g.id, e)}
                      style={{ cursor: isEditing ? 'default' : 'pointer' }}
                    >
                      <td>
                        {isEditing ? (
                          <input className="input" style={{ width: '100%' }} value={editForm.purchase_date || ''} onChange={e => setEditForm({...editForm, purchase_date: e.target.value})} />
                        ) : g.purchase_date || '-'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {isEditing ? (
                          <select className="input" value={editForm.priority} onChange={e => setEditForm({...editForm, priority: e.target.value as any})}>
                            <option value="High">高</option>
                            <option value="Medium">中</option>
                            <option value="Low">低</option>
                          </select>
                        ) : renderPriorityBadge(g.priority)}
                      </td>
                      <td style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
                        {isEditing ? (
                          <input className="input" style={{ width: '100%' }} value={editForm.title || ''} onChange={e => setEditForm({...editForm, title: e.target.value})} />
                        ) : g.title}
                      </td>
                      <td>
                        {isEditing ? (
                          <input className="input" style={{ width: '100%' }} value={editForm.closing_date || ''} onChange={e => setEditForm({...editForm, closing_date: e.target.value})} />
                        ) : g.closing_date || '-'}
                      </td>
                      <td>
                        {isEditing ? (
                          <input className="input" style={{ width: '100%' }} value={editForm.release_month || ''} onChange={e => setEditForm({...editForm, release_month: e.target.value})} />
                        ) : g.release_month || '-'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {isEditing ? (
                          <input type="checkbox" checked={editForm.has_official_site || false} onChange={e => setEditForm({...editForm, has_official_site: e.target.checked})} />
                        ) : (
                          g.has_official_site ? <span className="badge badge-success">有</span> : <span className="badge badge-neutral">無</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {isEditing ? (
                          <input className="input" style={{ width: '100%' }} value={editForm.product_url || ''} onChange={e => setEditForm({...editForm, product_url: e.target.value})} placeholder="URL" />
                        ) : (
                          g.product_url ? <a href={g.product_url} target="_blank" rel="noreferrer" className="text-info" onClick={e => e.stopPropagation()}><LinkIcon size={16} /></a> : '-'
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {isEditing ? (
                          <div className="flex items-center justify-center gap-xs">
                            <button className="btn btn-ghost text-success" style={{ padding: '4px' }} onClick={() => handleSave(g.id)}><Save size={16} /></button>
                            <button className="btn btn-ghost text-danger" style={{ padding: '4px' }} onClick={() => setEditingId(null)}><X size={16} /></button>
                          </div>
                        ) : (
                          <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={(e) => { e.stopPropagation(); handleEdit(g); }}><Edit2 size={16} /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
