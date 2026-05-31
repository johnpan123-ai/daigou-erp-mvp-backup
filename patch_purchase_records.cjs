const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseRecords.tsx', 'utf8');

// Replace useMemo block
const oldMemoRegex = /const filteredAndSortedGroups = useMemo\(\(\) => \{[\s\S]*?\}, \[groups, searchTerm, filterSource, filterStatus, filterType, sortMode\]\);/;

const newMemoBlock = `const { filteredAndSortedGroups, debugInfo } = useMemo(() => {
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
      result = result.filter(g => g.listing_type === filterType);
    }
    debug.afterType = result.length;

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
  }, [groups, searchTerm, filterSource, filterStatus, filterType, sortMode]);`;

code = code.replace(oldMemoRegex, newMemoBlock);

// Replace UI display to add debug info
const oldUI = `        <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
          共 <span style={{ color: '#2563eb', fontWeight: 700, fontSize: '15px' }}>{filteredAndSortedGroups.length}</span> 筆商品符合條件
        </div>`;

const newUI = `        <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
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
        </div>`;

code = code.replace(oldUI, newUI);

fs.writeFileSync('src/pages/PurchaseRecords.tsx', code, 'utf8');
console.log('Patch complete.');
