const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseRecords.tsx', 'utf8');

// Replace states
const oldStates = `
  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState('all');
  const [sortMode, setSortMode] = useState('created_desc');
`;

const newStates = `
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
`;

code = code.replace(oldStates.trim(), newStates.trim());

// Replace useMemo
const oldMemo = `  const filteredAndSortedGroups = useMemo(() => {
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
  }, [groups, searchTerm, filterMode, sortMode]);`;

const newMemo = `  const filteredAndSortedGroups = useMemo(() => {
    let result = [...groups];

    const today = new Date().toISOString().split('T')[0];

    // 1. Filter Source
    if (filterSource !== 'all') {
      result = result.filter(g => {
        if (g.listing_type === '代理版') return filterSource === '代理商品';
        const lowerTitle = (g.title || '').toLowerCase();
        if (lowerTitle.includes('hololive')) return filterSource === 'Hololive';
        if (lowerTitle.includes('vspo') || g.title.includes('ぶいすぽ')) return filterSource === 'VSPO';
        return false;
      });
    }

    // 2. Filter Status
    if (filterStatus !== 'all') {
      if (filterStatus === '開單中') {
        result = result.filter(g => !g.closing_date || g.closing_date >= today);
      } else if (filterStatus === '已結單') {
        result = result.filter(g => g.closing_date && g.closing_date < today);
      }
    }

    // 3. Filter Type
    if (filterType !== 'all') {
      result = result.filter(g => g.listing_type === filterType);
    }

    // 4. Search
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

    return result;
  }, [groups, searchTerm, filterSource, filterStatus, filterType, sortMode]);`;

code = code.replace(oldMemo, newMemo);


const oldToolbar = `      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center', backgroundColor: '#fff', padding: '16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
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
      </div>`;


const newToolbar = `      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '16px', backgroundColor: '#fff', padding: '16px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
        
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

      </div>`;

code = code.replace(oldToolbar, newToolbar);

fs.writeFileSync('src/pages/PurchaseRecords.tsx', code, 'utf8');
console.log('PurchaseRecords filters updated');
