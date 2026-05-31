const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseRecords.tsx', 'utf8');

const imports = `import { useState, useEffect, useMemo } from 'react';
import { db } from '../lib/db';
import type { ProductGroup } from '../lib/db';
import { Receipt, Link as LinkIcon, Edit2, Save, X, Search } from 'lucide-react';
import { EmptyState } from '../components/empty/EmptyState';
import { useNavigate } from 'react-router-dom';`;

code = code.replace(/import \{ useState, useEffect \} from 'react';[\s\S]*?import \{ useNavigate \} from 'react-router-dom';/, imports);


const stateAdditions = `
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ProductGroup>>({});
  const navigate = useNavigate();

  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState('all');
  const [sortMode, setSortMode] = useState('created_desc');

  const filteredAndSortedGroups = useMemo(() => {
    let result = [...groups];

    // 1. Filter
    if (filterMode !== 'all') {
      const today = new Date().toISOString().split('T')[0];
      if (filterMode === '未結單') {
        result = result.filter(g => !g.closing_date || g.closing_date >= today);
      } else if (filterMode === '已結單') {
        result = result.filter(g => g.closing_date && g.closing_date < today);
      } else {
        result = result.filter(g => g.listing_type === filterMode);
      }
    }

    // 2. Search
    if (searchTerm.trim()) {
      const lowerTerm = searchTerm.toLowerCase();
      result = result.filter(g => {
        return (
          (g.title && g.title.toLowerCase().includes(lowerTerm)) ||
          (g.normalized_title && g.normalized_title.toLowerCase().includes(lowerTerm)) ||
          (g.release_month && g.release_month.toLowerCase().includes(lowerTerm)) ||
          (g.closing_date && g.closing_date.toLowerCase().includes(lowerTerm)) ||
          (g.listing_type && g.listing_type.toLowerCase().includes(lowerTerm)) ||
          (g.product_url && g.product_url.toLowerCase().includes(lowerTerm))
        );
      });
    }

    // 3. Sort
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

    return result;
  }, [groups, searchTerm, filterMode, sortMode]);
`;

code = code.replace(/  const \[groups, setGroups\] = useState<ProductGroup\[\]>\(\[\]\);\n  const \[editingId, setEditingId\] = useState<string \| null>\(null\);\n  const \[editForm, setEditForm\] = useState<Partial<ProductGroup>>\(\{\}\);\n  const navigate = useNavigate\(\);/m, stateAdditions);


const toolbarJSX = `
      <div className="flex justify-between items-center" style={{ marginBottom: 'var(--spacing-md)' }}>
        <div>
          <h1 style={{ marginBottom: '4px', fontSize: '20px', fontWeight: 600 }}>訂購紀錄表</h1>
          <p className="text-muted text-sm" style={{ margin: 0 }}>總體商品群組清單，點擊進入該群組進行採購與需求管理。</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center', backgroundColor: '#fff', padding: '16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
        <div style={{ display: 'flex', alignItems: 'center', flex: 1, backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '0 12px', height: '40px' }}>
          <Search size={18} style={{ color: '#64748b', marginRight: '8px' }} />
          <input 
            type="text" 
            placeholder="搜尋品項、商品名稱、月份、類型..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ border: 'none', background: 'transparent', outline: 'none', width: '100%', fontSize: '14px', color: '#334155' }}
          />
        </div>
        
        <select 
          className="input" 
          style={{ width: '160px', height: '40px', fontSize: '14px' }}
          value={filterMode}
          onChange={e => setFilterMode(e.target.value)}
        >
          <option value="all">全部</option>
          <option value="代理版">代理版</option>
          <option value="一般預購">一般預購</option>
          <option value="現貨">現貨</option>
          <option value="現地代購">現地代購</option>
          <option value="未結單">未結單</option>
          <option value="已結單">已結單</option>
        </select>

        <select 
          className="input" 
          style={{ width: '180px', height: '40px', fontSize: '14px' }}
          value={sortMode}
          onChange={e => setSortMode(e.target.value)}
        >
          <option value="created_desc">建立時間 (新到舊)</option>
          <option value="closing_asc">結單日 (近到遠)</option>
        </select>
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
`;

code = code.replace(/      <div className="flex justify-between items-center" style=\{\{ marginBottom: 'var\(--spacing-md\)' \}\}>[\s\S]*?      <div className="flex-col gap-md">[\s\S]*?          <EmptyState[\s\S]*?\/>/, toolbarJSX);

// Replace mapping groups.map -> filteredAndSortedGroups.map
code = code.replace(/\{groups\.map\(\(group\)/, '{filteredAndSortedGroups.map((group)');

fs.writeFileSync('src/pages/PurchaseRecords.tsx', code, 'utf8');
console.log('PurchaseRecords updated');
