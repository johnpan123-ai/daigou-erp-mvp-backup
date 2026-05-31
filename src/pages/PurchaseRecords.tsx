import { useState, useEffect, useMemo } from 'react';
import { db } from '../lib/db';
import type { ProductGroup } from '../lib/db';
import { Receipt, Link as LinkIcon, Edit2, Save, X, Search } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { useNavigate } from 'react-router-dom';

export default function PurchaseRecords() {

  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ProductGroup>>({});
  const navigate = useNavigate();

  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem('erp_search_term') || '');
  const [filterSource, setFilterSource] = useState(() => localStorage.getItem('erp_filter_source') || 'all');
  const [filterStatus, setFilterStatus] = useState(() => localStorage.getItem('erp_filter_status') || 'all');
  const [filterType, setFilterType] = useState(() => localStorage.getItem('erp_filter_type') || 'all');
  const [sortMode, setSortMode] = useState(() => localStorage.getItem('erp_sort_mode') || 'created_desc');

  useEffect(() => {
    localStorage.setItem('erp_search_term', searchTerm);
    localStorage.setItem('erp_filter_source', filterSource);
    localStorage.setItem('erp_filter_status', filterStatus);
    localStorage.setItem('erp_filter_type', filterType);
    localStorage.setItem('erp_sort_mode', sortMode);
  }, [searchTerm, filterSource, filterStatus, filterType, sortMode]);

  const { filteredAndSortedGroups, debugInfo } = useMemo(() => {
    let result = [...groups];
    
    const debug = {
      total: result.length,
      afterSource: result.length,
      afterStatus: result.length,
      afterType: result.length,
      afterSearch: result.length,
      final: result.length
    };

    const today = new Date().toISOString().split('T')[0];

    const isProxyProduct = (g: ProductGroup) => {
      if (g.listing_type === '代理版') return true;
      if (g.source_type === '代理版') return true;
      const t1 = (g.title || '').toLowerCase();
      const t2 = (g.normalized_title || '').toLowerCase();
      // wait, source_type is not on ProductGroup, but original_title might be? No original_title on ProductGroup.
      // But title and normalized_title are.
      if (t1.includes('代理版') || t1.includes('代理')) return true;
      if (t2.includes('代理版') || t2.includes('代理')) return true;
      return false;
    };

    // 1. Filter Source
    if (filterSource !== 'all') {
      result = result.filter(g => {
        if (isProxyProduct(g)) return filterSource === '代理商品';
        const lowerTitle = (g.title || '').toLowerCase();
        if (lowerTitle.includes('hololive')) return filterSource === 'Hololive';
        if (lowerTitle.includes('vspo') || g.title.includes('ぶいすぽ')) return filterSource === 'VSPO';
        return false;
      });
    }
    debug.afterSource = result.length;

    // 2. Filter Status
    if (filterStatus !== 'all') {
      if (filterStatus === '開單中') {
        result = result.filter(g => !g.closing_date || g.closing_date >= today);
      } else if (filterStatus === '已結單') {
        result = result.filter(g => g.closing_date && g.closing_date < today);
      }
    }
    debug.afterStatus = result.length;

    // 3. Filter Type
    if (filterType !== 'all') {
      result = result.filter(g => {
        if (filterType === '代理版') return isProxyProduct(g);
        return (g.listing_type || '一般預購') === filterType;
      });
    }
    debug.afterType = result.length;

    // 4. Search
    if (searchTerm.trim()) {
      const lowerTerm = searchTerm.toLowerCase();
      result = result.filter(g => {
        const isProxy = isProxyProduct(g);
        const effectiveListingType = isProxy ? '代理版' : (g.listing_type || '');
        return (
          (g.title && g.title.toLowerCase().includes(lowerTerm)) ||
          (g.normalized_title && g.normalized_title.toLowerCase().includes(lowerTerm)) ||
          (g.release_month && g.release_month.toLowerCase().includes(lowerTerm)) ||
          (g.closing_date && g.closing_date.toLowerCase().includes(lowerTerm)) ||
          effectiveListingType.includes(lowerTerm) ||
          (g.product_url && g.product_url.toLowerCase().includes(lowerTerm))
        );
      });
    }
    debug.afterSearch = result.length;
    debug.final = result.length;

    // 5. Sort
    result.sort((a, b) => {
      if (sortMode === 'closing_asc') {
        const dateA = a.closing_date || '9999-12-31';
        const dateB = b.closing_date || '9999-12-31';
        return dateA.localeCompare(dateB);
      } else {
        const timeA = new Date(a.created_at || a.purchase_date || 0).getTime();
        const timeB = new Date(b.created_at || b.purchase_date || 0).getTime();
        return timeB - timeA;
      }
    });

    return { filteredAndSortedGroups: result, debugInfo: debug };
  }, [groups, searchTerm, filterSource, filterStatus, filterType, sortMode]);


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

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '16px', backgroundColor: '#fff', padding: '16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
        
        <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '0 12px', height: '40px' }}>
          <Search size={18} style={{ color: '#64748b', marginRight: '8px' }} />
          <input 
            type="text" 
            placeholder="搜尋品項、商品名稱、月份、類型..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ border: 'none', background: 'transparent', outline: 'none', width: '100%', fontSize: '14px', color: '#334155' }}
          />
        </div>
        
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品來源</span>
            <select className="input" style={{ width: '140px', height: '36px', fontSize: '13px' }} value={filterSource} onChange={e => setFilterSource(e.target.value)}>
              <option value="all">全部</option>
              <option value="Hololive">Hololive</option>
              <option value="VSPO">VSPO</option>
              <option value="代理商品">代理商品</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品狀態</span>
            <select className="input" style={{ width: '120px', height: '36px', fontSize: '13px' }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="all">全部</option>
              <option value="開單中">開單中</option>
              <option value="已結單">已結單</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>商品類型</span>
            <select className="input" style={{ width: '140px', height: '36px', fontSize: '13px' }} value={filterType} onChange={e => setFilterType(e.target.value)}>
              <option value="all">全部</option>
              <option value="一般預購">一般預購</option>
              <option value="現貨">現貨</option>
              <option value="現地代購">現地代購</option>
              <option value="日本代購">日本代購</option>
              <option value="代理版">代理版</option>
            </select>
          </div>

          <div style={{ flex: 1 }}></div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>排序</span>
            <select className="input" style={{ width: '160px', height: '36px', fontSize: '13px' }} value={sortMode} onChange={e => setSortMode(e.target.value)}>
              <option value="created_desc">建立時間 (新到舊)</option>
              <option value="closing_asc">結單日 (近到遠)</option>
            </select>
          </div>

        </div>

        <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
          共 <span style={{ color: '#2563eb', fontWeight: 700, fontSize: '15px' }}>{filteredAndSortedGroups.length}</span> 筆商品符合條件
        </div>
        
        {/* Debug Info */}
        <div style={{ marginTop: '12px', padding: '12px', backgroundColor: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: '8px', fontSize: '12px', color: '#475569' }}>
          <div style={{ fontWeight: 600, marginBottom: '4px', color: '#334155' }}>Filter Debug Info:</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
            <div>原始商品總數：{debugInfo.total} 筆</div>
            <div>來源篩選後：{debugInfo.afterSource} 筆</div>
            <div>狀態篩選後：{debugInfo.afterStatus} 筆</div>
            <div>類型篩選後：{debugInfo.afterType} 筆</div>
            <div>搜尋篩選後：{debugInfo.afterSearch} 筆</div>
            <div style={{ fontWeight: 600, color: '#2563eb' }}>最終結果：{debugInfo.final} 筆</div>
          </div>
        </div>

      </div>

      <div className="flex-col gap-md">
        {filteredAndSortedGroups.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title={groups.length === 0 ? "尚未有訂購紀錄" : "找不到符合的紀錄"}
            description={groups.length === 0 ? "您可以透過匯入商品清單來自動產生母體，或手動建立。" : "請嘗試調整搜尋關鍵字或篩選條件。"}
            actionLabel={groups.length === 0 ? "前往商品清單匯入" : ""}
            onAction={() => groups.length === 0 ? navigate('/inventory') : undefined}
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
                        ) : (
                          <div className="flex items-center gap-sm">
                            <span>{g.normalized_title || g.title}</span>
                            {g.listing_type && (
                              <span style={{ backgroundColor: '#e2e8f0', color: '#475569', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 500 }}>
                                {g.listing_type}
                              </span>
                            )}
                          </div>
                        )}
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
