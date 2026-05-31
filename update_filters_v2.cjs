const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseRecords.tsx', 'utf8');

// The block to replace is the useMemo.
// I will extract everything between `const { filteredAndSortedGroups, debugInfo } = useMemo(() => {` and `}, [groups, searchTerm, filterSource, filterStatus, filterType, sortMode]);`
const oldMemoRegex = /const \{ filteredAndSortedGroups, debugInfo \} = useMemo\(\(\) => \{[\s\S]*?\}, \[groups, searchTerm, filterSource, filterStatus, filterType, sortMode\]\);/;

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
  }, [groups, searchTerm, filterSource, filterStatus, filterType, sortMode]);`;

code = code.replace(oldMemoRegex, newMemoBlock);

fs.writeFileSync('src/pages/PurchaseRecords.tsx', code, 'utf8');
console.log('Patch complete.');
