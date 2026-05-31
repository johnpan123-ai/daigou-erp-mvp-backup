const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'pages', 'PurchaseRecords.tsx');

// Restore to original first to apply the patch cleanly
const execSync = require('child_process').execSync;
execSync('git restore src/pages/PurchaseRecords.tsx', { cwd: __dirname });

let content = fs.readFileSync(filePath, 'utf8');

// Normalize line endings to LF
content = content.replace(/\r\n/g, '\n');

// Clean up unused imports at the top
content = content.replace(
  "import { Receipt, Edit2, Save, X, Search, Trash2 } from 'lucide-react';",
  "import { Receipt, Search } from 'lucide-react';"
);

// Define the target string for replacing the state hooks
const stateHookTarget = `  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ProductGroup>>({});
  const navigate = useNavigate();

  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem('erp_search_term') || '');
  const [filterSource, setFilterSource] = useState(() => localStorage.getItem('erp_filter_source') || 'all');
  const [filterStatus, setFilterStatus] = useState(() => localStorage.getItem('erp_filter_status') || 'all');
  const [filterType, setFilterType] = useState(() => localStorage.getItem('erp_filter_type') || 'all');
  const [sortMode, setSortMode] = useState(() => localStorage.getItem('erp_sort_mode') || 'closing_urgent');
  const [activeTab, setActiveTab] = useState<'all' | 'proxy' | 'multi'>(() => {
    return (localStorage.getItem('erp_active_tab') as 'all' | 'proxy' | 'multi') || 'all';
  });`;

const stateHookReplacement = `  const navigate = useNavigate();

  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem('erp_search_term') || '');
  const [filterSource, setFilterSource] = useState(() => localStorage.getItem('erp_filter_source') || 'all');
  const [filterStatus, setFilterStatus] = useState(() => localStorage.getItem('erp_filter_status') || 'all');
  const [filterType, setFilterType] = useState(() => localStorage.getItem('erp_filter_type') || 'all');
  const [sortMode, setSortMode] = useState(() => localStorage.getItem('erp_sort_mode') || 'closing_urgent');
  const [activeTab, setActiveTab] = useState<'all' | 'proxy' | 'multi'>(() => {
    return (localStorage.getItem('erp_active_tab') as 'all' | 'proxy' | 'multi') || 'all';
  });
  const [proxyFilter, setProxyFilter] = useState<'all' | 'pending' | 'partial' | 'completed' | 'urgent'>(() => {
    return (localStorage.getItem('erp_proxy_filter') as any) || 'all';
  });
  const [sourceTab, setSourceTab] = useState<'all' | 'Hololive' | 'VSPO' | '代理商品' | 'other'>(() => {
    return (localStorage.getItem('erp_source_tab') as any) || 'all';
  });
  const [cardFilter, setCardFilter] = useState<'all' | 'active' | 'pending' | 'completed' | 'urgent3'>('all');
  const [editMode, setEditMode] = useState<boolean>(() => {
    return localStorage.getItem('purchase_records_edit_mode') === 'true';
  });`;

if (!content.includes(stateHookTarget)) {
  console.error("State hook target not found!");
  process.exit(1);
}
content = content.replace(stateHookTarget, stateHookReplacement);

// Replace the old useEffect hooks
const effectsTarget = `  useEffect(() => {
    localStorage.setItem('erp_search_term', searchTerm);
    localStorage.setItem('erp_filter_source', filterSource);
    localStorage.setItem('erp_filter_status', filterStatus);
    localStorage.setItem('erp_filter_type', filterType);
    localStorage.setItem('erp_sort_mode', sortMode);
  }, [searchTerm, filterSource, filterStatus, filterType, sortMode]);

  useEffect(() => {
    localStorage.setItem('erp_active_tab', activeTab);
  }, [activeTab]);`;

const effectsReplacement = `  useEffect(() => {
    localStorage.setItem('erp_search_term', searchTerm);
    localStorage.setItem('erp_filter_source', filterSource);
    localStorage.setItem('erp_filter_status', filterStatus);
    localStorage.setItem('erp_filter_type', filterType);
    localStorage.setItem('erp_sort_mode', sortMode);
  }, [searchTerm, filterSource, filterStatus, filterType, sortMode]);

  useEffect(() => {
    localStorage.setItem('erp_active_tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem('erp_source_tab', sourceTab);
  }, [sourceTab]);

  useEffect(() => {
    localStorage.setItem('erp_proxy_filter', proxyFilter);
  }, [proxyFilter]);

  // Reset proxyFilter when cardFilter changes
  useEffect(() => {
    if (cardFilter !== 'all') {
      setProxyFilter('all');
    }
  }, [cardFilter]);

  // Reset cardFilter when proxyFilter changes
  useEffect(() => {
    if (proxyFilter !== 'all') {
      setCardFilter('all');
    }
  }, [proxyFilter]);

  // Reset cardFilter when activeTab or sourceTab changes
  useEffect(() => {
    setCardFilter('all');
  }, [activeTab, sourceTab]);`;

if (!content.includes(effectsTarget)) {
  console.error("Effects target not found!");
  process.exit(1);
}
content = content.replace(effectsTarget, effectsReplacement);

// 1. Remove getGroupGap and getClosingDateStyle definitions together
const gapStart = content.indexOf('  const getGroupGap =');
const memoStart = content.indexOf('  const { filteredAndSortedGroups', gapStart);
if (gapStart !== -1 && memoStart !== -1) {
  content = content.substring(0, gapStart) + content.substring(memoStart);
}

// 2. Remove tabCounts definition
const tabCountsStart = content.indexOf('  const tabCounts = useMemo');
if (tabCountsStart !== -1) {
  const tabCountsEnd = content.indexOf('}, [groups, variants, categories, inventory, sourceTab]);', tabCountsStart);
  if (tabCountsEnd !== -1) {
    content = content.substring(0, tabCountsStart) + content.substring(tabCountsEnd + '}, [groups, variants, categories, inventory, sourceTab]);'.length + 1);
  }
}

// 3. Change debugInfo in the groups memo return
content = content.replace("const { filteredAndSortedGroups, debugInfo }", "const { filteredAndSortedGroups }");
content = content.replace("return { filteredAndSortedGroups: result, debugInfo: debug };", "return { filteredAndSortedGroups: result };");

// 4. Insert urgentProxyGroups and cardCounts right before the loadData call useEffect
const targetEffect = `  useEffect(() => {
    loadData();
  }, []);`;

const memoInsertions = `  const urgentProxyGroups = useMemo(() => {
    let tabGroups = [...groups];
    if (sourceTab !== 'all') {
      tabGroups = tabGroups.filter(g => {
        const lowerTitle = (g.title || '').toLowerCase();
        const isHololive = lowerTitle.includes('hololive');
        const isVspo = lowerTitle.includes('vspo') || g.title.includes('ぶいすぽ');
        const isProxy = checkIsProxyProduct(g);
        if (sourceTab === 'Hololive') return isHololive;
        if (sourceTab === 'VSPO') return isVspo;
        if (sourceTab === '代理商品') return isProxy;
        if (sourceTab === 'other') return !isHololive && !isVspo && !isProxy;
        return true;
      });
    }
    if (activeTab === 'proxy') {
      tabGroups = tabGroups.filter(g => checkIsProxyProduct(g));
    } else if (activeTab === 'multi') {
      tabGroups = tabGroups.filter(g => !checkIsProxyProduct(g));
    }
    return tabGroups.filter(g => {
      const { gap: shortage } = getGroupDemandAndPurchased(g.id);
      if (shortage <= 0) return false;
      if (!g.closing_date) return false;
      const todayStr = new Date().toISOString().split('T')[0];
      const todayTime = new Date(todayStr).getTime();
      const closingTime = new Date(g.closing_date).getTime();
      if (isNaN(closingTime)) return false;
      const diffDays = Math.ceil((closingTime - todayTime) / (1000 * 60 * 60 * 24));
      return diffDays >= 0 && diffDays <= 7;
    });
  }, [groups, variants, categories, batchItems, privateOrderItems, inventory, salesOrderItems, sourceTab, activeTab]);

  const cardCounts = useMemo(() => {
    let tabGroups = [...groups];
    if (sourceTab !== 'all') {
      tabGroups = tabGroups.filter(g => {
        const lowerTitle = (g.title || '').toLowerCase();
        const isHololive = lowerTitle.includes('hololive');
        const isVspo = lowerTitle.includes('vspo') || g.title.includes('ぶいすぽ');
        const isProxy = checkIsProxyProduct(g);
        if (sourceTab === 'Hololive') return isHololive;
        if (sourceTab === 'VSPO') return isVspo;
        if (sourceTab === '代理商品') return isProxy;
        if (sourceTab === 'other') return !isHololive && !isVspo && !isProxy;
        return true;
      });
    }
    if (activeTab === 'proxy') {
      tabGroups = tabGroups.filter(g => checkIsProxyProduct(g));
    } else if (activeTab === 'multi') {
      tabGroups = tabGroups.filter(g => !checkIsProxyProduct(g));
    }
    const today = new Date().toISOString().split('T')[0];
    const todayTime = new Date(today).getTime();
    let urgent3Count = 0;
    let pendingCount = 0;
    let completedCount = 0;
    let activeCount = 0;
    tabGroups.forEach(g => {
      const { purchased, gap: shortage } = getGroupDemandAndPurchased(g.id);
      const isActive = !g.closing_date || g.closing_date >= today;
      if (g.closing_date && isActive) {
        const closingTime = new Date(g.closing_date).getTime();
        if (!isNaN(closingTime)) {
          const diffDays = Math.ceil((closingTime - todayTime) / (1000 * 60 * 60 * 24));
          if (diffDays >= 0 && diffDays <= 3) {
            urgent3Count++;
          }
        }
      }
      if (shortage > 0 && purchased === 0) {
        pendingCount++;
      }
      if (shortage === 0) {
        completedCount++;
      }
      if (isActive) {
        activeCount++;
      }
    });
    return {
      urgent3: urgent3Count,
      pending: pendingCount,
      completed: completedCount,
      active: activeCount
    };
  }, [groups, variants, categories, batchItems, privateOrderItems, activeTab, sourceTab, inventory, salesOrderItems]);

  useEffect(() => {
    loadData();
  }, []);`;

if (!content.includes(targetEffect)) {
  console.error("Target loadData effect not found!");
  process.exit(1);
}
content = content.replace(targetEffect, memoInsertions);

// Locate the loadData definition
const loadDataStr = `  const loadData = async () => {
    const [fetchedGroups, fetchedVars, fetchedCats, fetchedBatchItems, fetchedPrivateItems, fetchedInventory, fetchedOrderItems] = await Promise.all([
      db.getProductGroups(),
      db.getProductVariants(),
      db.getProductCategories(),
      db.getPurchaseBatchItems(),
      db.getPrivateOrderItems(),
      db.getInventory(),
      db.getSalesOrderItems()
    ]);
    setGroups(fetchedGroups);
    setVariants(fetchedVars);
    setCategories(fetchedCats);
    setBatchItems(fetchedBatchItems);
    setPrivateOrderItems(fetchedPrivateItems);
    setInventory(fetchedInventory);
    setSalesOrderItems(fetchedOrderItems);
  };`;

const loadDataIndex = content.indexOf(loadDataStr);
if (loadDataIndex === -1) {
  console.error("loadData function not found!");
  process.exit(1);
}

const beforePatch = content.substring(0, loadDataIndex + loadDataStr.length);

const patchCode = `

  const handleResetFilters = () => {
    setSearchTerm('');
    setFilterSource('all');
    setFilterStatus('all');
    setFilterType('all');
    setProxyFilter('all');
    setCardFilter('all');
    setSortMode('closing_urgent');
    setActiveTab('all');
    setSourceTab('all');
  };

  const renderClosingDateWithSubtext = (closingDate: string | undefined | null) => {
    if (!closingDate) return <span style={{ color: '#94a3b8' }}>-</span>;
    const todayStr = new Date().toISOString().split('T')[0];
    const todayTime = new Date(todayStr).getTime();
    const closingTime = new Date(closingDate).getTime();
    if (isNaN(closingTime)) return <span>{closingDate}</span>;

    const diffDays = Math.ceil((closingTime - todayTime) / (1000 * 60 * 60 * 24));
    
    let subtext = '';
    let color = '#64748b';
    if (diffDays < 0) {
      subtext = '已逾期';
      color = '#ef4444';
    } else if (diffDays <= 3) {
      subtext = \`(\${diffDays}天內結單)\`;
      color = '#ef4444'; // Red
    } else if (diffDays <= 7) {
      subtext = \`(\${diffDays}天內結單)\`;
      color = '#f97316'; // Orange
    } else if (diffDays <= 14) {
      subtext = \`(\${diffDays}天內結單)\`;
      color = '#eab308'; // Yellow
    } else {
      subtext = \`(剩 \${diffDays} 天)\`;
      color = '#475569';
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, color: diffDays <= 3 ? '#ef4444' : '#334155' }}>
          {closingDate}
        </span>
        {subtext && (
          <span style={{ fontSize: '11px', fontWeight: 700, color, marginTop: '2px' }}>
            {subtext}
          </span>
        )}
      </div>
    );
  };

  const getRowBgColor = (closingDate: string | undefined | null) => {
    if (!closingDate) return '#ffffff';
    const todayStr = new Date().toISOString().split('T')[0];
    const todayTime = new Date(todayStr).getTime();
    const closingTime = new Date(closingDate).getTime();
    if (isNaN(closingTime)) return '#ffffff';
    
    const diffDays = Math.ceil((closingTime - todayTime) / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) return '#fff1f2'; // 淡紅 (逾期)
    if (diffDays <= 3) return '#fff1f2'; // 淡紅
    if (diffDays <= 7) return '#fff7ed'; // 淡橘
    if (diffDays <= 14) return '#fefbeb'; // 淡黃
    return '#ffffff';
  };

  const getShortageBadge = (shortage: number, purchased: number) => {
    if (shortage <= 0) {
      return <span className="badge badge-green">已足夠</span>;
    }
    if (purchased === 0) {
      return <span className="badge badge-red">缺 \${shortage}</span>;
    }
    if (shortage <= 1) {
      return <span className="badge badge-yellow">缺 \${shortage}</span>;
    }
    return <span className="badge badge-orange">缺 \${shortage}</span>;
  };

  const getRemainingDays = (closingDate: string | undefined | null) => {
    if (!closingDate) return { text: '-', color: '#64748b', fontWeight: 400 };
    const todayStr = new Date().toISOString().split('T')[0];
    const todayTime = new Date(todayStr).getTime();
    const closingTime = new Date(closingDate).getTime();
    if (isNaN(closingTime)) return { text: '-', color: '#64748b', fontWeight: 400 };
    
    const diffDays = Math.ceil((closingTime - todayTime) / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) {
      return { text: '已逾期', color: '#ef4444', fontWeight: 700 };
    } else if (diffDays <= 3) {
      return { text: \`🔥 剩 \${diffDays} 天\`, color: '#ef4444', fontWeight: 700 };
    } else if (diffDays <= 7) {
      return { text: \`⚠️ 剩 \${diffDays} 天\`, color: '#f97316', fontWeight: 700 };
    } else if (diffDays <= 14) {
      return { text: \`📅 剩 \${diffDays} 天\`, color: '#eab308', fontWeight: 700 };
    } else if (diffDays >= 30) {
      return { text: '✓ 30 天以上', color: '#166534', fontWeight: 500 };
    } else {
      return { text: \`📅 剩 \${diffDays} 天\`, color: '#334155', fontWeight: 500 };
    }
  };

  const handleUpdateProxyPlatformDemand = async (groupId: string, platform: 'myacg' | 'waca', totalValue: number) => {
    if (isNaN(totalValue) || totalValue < 0) totalValue = 0;
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    if (groupVars.length === 0) return;
    
    // Update the first variant
    const targetVar = groupVars[0];
    const allVars = await db.getProductVariants();
    const target = allVars.find(v => v.id === targetVar.id);
    if (target) {
      if (platform === 'myacg') {
        const auto = calculateFinalMyacgDemand(target.myacg_item_code, inventory, salesOrderItems);
        target.myacg_manual_adjustment = totalValue - auto;
      } else {
        const auto = target.waca_auto_quantity || 0;
        target.waca_manual_adjustment = totalValue - auto;
      }
      await db.saveProductVariants(allVars);
      setVariants(variants.map(v => v.id === target.id ? target : v));
    }
  };

  const handleUpdateProxyOrderedQty = async (groupId: string, orderedValue: number) => {
    if (isNaN(orderedValue) || orderedValue < 0) orderedValue = 0;
    const catIds = new Set(categories.filter(c => c.product_group_id === groupId).map(c => c.id));
    const groupVars = variants.filter(v => v.product_group_id === groupId || (v.product_category_id && catIds.has(v.product_category_id)));
    if (groupVars.length === 0) return;
    
    const targetVar = groupVars[0];
    const allBatchItems = await db.getPurchaseBatchItems();
    const varBatchItems = allBatchItems.filter(item => item.product_variant_id === targetVar.id);
    
    if (varBatchItems.length > 0) {
      const firstItem = varBatchItems[0];
      const otherIds = new Set(varBatchItems.slice(1).map(item => item.id));
      const updatedItems = allBatchItems.map(item => {
        if (item.id === firstItem.id) {
          return { ...item, quantity: orderedValue };
        }
        return item;
      }).filter(item => !otherIds.has(item.id));
      
      await db.savePurchaseBatchItems(updatedItems);
      setBatchItems(updatedItems);
    } else {
      const batches = await db.getPurchaseBatches();
      let groupBatch = batches.find(b => b.product_group_id === groupId);
      if (!groupBatch) {
        groupBatch = {
          id: 'batch_' + Math.random().toString(36).substr(2, 9),
          product_group_id: groupId,
          name: '預設採購批次',
          date: new Date().toISOString().split('T')[0],
          note: '',
          created_at: new Date().toISOString()
        };
        batches.push(groupBatch);
        await db.savePurchaseBatches(batches);
      }
      const newItem = {
        id: 'pbi_' + Math.random().toString(36).substr(2, 9),
        purchase_batch_id: groupBatch.id,
        product_variant_id: targetVar.id,
        quantity: orderedValue,
        cost: 0,
        note: ''
      };
      allBatchItems.push(newItem);
      await db.savePurchaseBatchItems(allBatchItems);
      setBatchItems(allBatchItems);
    }
  };

  const handleUpdateGroupField = async (groupId: string, field: string, value: any) => {
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return { ...g, [field]: value } as ProductGroup;
      }
      return g;
    });
    setGroups(updatedGroups);
    await db.saveProductGroups(updatedGroups);
  };

  const handleRowClick = (id: string, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || 
        (e.target as HTMLElement).tagName === 'SELECT' || 
        (e.target as HTMLElement).tagName === 'BUTTON' ||
        (e.target as HTMLElement).closest('button')) {
      return;
    }
    if (editMode) return;
    navigate(\`/purchase-records/\${id}\`);
  };

  return (
    <div className="purchase-container">
      <style>{\`
        .purchase-container {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #334155;
          background-color: #f8fafc;
          padding: 16px;
          min-height: 100vh;
        }
        .purchase-header {
          margin-bottom: 24px;
        }
        .purchase-title {
          font-size: 24px;
          font-weight: 700;
          color: #1e293b;
          margin: 0 0 6px 0;
        }
        .purchase-subtitle {
          font-size: 14px;
          color: #64748b;
          margin: 0;
        }
        
        /* Cards section */
        .status-cards-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
          margin-bottom: 24px;
        }
        .status-card {
          background-color: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 20px;
          cursor: pointer;
          box-shadow: 0 1px 3px rgba(0,0,0,0.02), 0 1px 2px rgba(0,0,0,0.01);
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          display: flex;
          align-items: center;
          gap: 16px;
          user-select: none;
        }
        .status-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -4px rgba(0, 0, 0, 0.05);
          border-color: #cbd5e1;
        }
        .status-card.active-card {
          background-color: #ffffff;
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -4px rgba(0, 0, 0, 0.05);
        }
        .icon-circle {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          flex-shrink: 0;
        }
        .card-value {
          font-size: 26px;
          font-weight: 700;
          color: #1e293b;
          line-height: 1.2;
        }
        .card-label {
          font-size: 14px;
          font-weight: 600;
          color: #475569;
        }
        .card-desc {
          font-size: 12px;
          color: #64748b;
          margin-top: 2px;
        }

        /* Urgent Tasks */
        .urgent-section {
          background-color: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 24px;
          margin-bottom: 24px;
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02);
        }
        .urgent-title {
          font-size: 16px;
          font-weight: 700;
          color: #e11d48;
          margin: 0 0 16px 0;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .urgent-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 16px;
        }
        .urgent-card {
          background-color: #fff1f2;
          border: 1px solid #ffe4e6;
          border-radius: 10px;
          padding: 16px;
          cursor: pointer;
          transition: all 0.2s ease;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 12px;
          box-shadow: 0 1px 2px rgba(225, 29, 72, 0.02);
        }
        .urgent-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(225, 29, 72, 0.08);
          border-color: #fecdd3;
        }
        .urgent-card-title {
          font-size: 13px;
          font-weight: 600;
          color: #1e293b;
          line-height: 1.4;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .urgent-card-meta {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          align-items: center;
        }
        .urgent-arrow {
          margin-left: auto;
          color: #e11d48;
          font-weight: bold;
          font-size: 16px;
          display: flex;
          align-items: center;
        }

        /* Toolbar */
        .filter-toolbar {
          background-color: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 20px;
          margin-bottom: 20px;
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02);
        }
        .toolbar-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 16px;
          align-items: end;
        }
        .toolbar-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .toolbar-field label {
          font-size: 13px;
          font-weight: 600;
          color: #475569;
        }
        .search-wrapper {
          display: flex;
          align-items: center;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 0 12px;
          height: 38px;
          background-color: #f8fafc;
          transition: border-color 0.15s ease;
        }
        .search-wrapper:focus-within {
          border-color: #2563eb;
          background-color: #ffffff;
        }
        .search-wrapper input {
          border: none;
          background: transparent;
          outline: none;
          width: 100%;
          font-size: 13px;
          color: #334155;
        }
        .toolbar-select {
          width: 100%;
          height: 38px;
          font-size: 13px;
          border-radius: 8px;
          border: 1px solid #cbd5e1;
          padding: 0 8px;
          background-color: #ffffff;
          color: #334155;
          outline: none;
          cursor: pointer;
          transition: border-color 0.15s ease;
        }
        .toolbar-select:focus {
          border-color: #2563eb;
        }
        .toolbar-actions {
          display: flex;
          gap: 8px;
          height: 38px;
        }
        .btn-filter {
          flex: 1;
          background-color: #ffffff;
          color: #475569;
          font-weight: 600;
          font-size: 13px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.15s ease;
        }
        .btn-filter:hover {
          background-color: #f8fafc;
          border-color: #94a3b8;
        }
        .btn-reset {
          flex: 1;
          background-color: #ffffff;
          color: #475569;
          font-weight: 600;
          font-size: 13px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.15s ease;
        }
        .btn-reset:hover {
          background-color: #f8fafc;
          border-color: #94a3b8;
        }

        /* Table styling */
        .table-card {
          background-color: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02), 0 2px 4px -1px rgba(0,0,0,0.01);
          overflow: hidden;
        }
        .records-table {
          width: 100%;
          border-collapse: collapse;
          margin: 0;
          font-size: 13px;
          text-align: left;
        }
        .records-table th {
          background-color: #f8fafc;
          color: #475569;
          font-weight: 600;
          padding: 14px 16px;
          border-bottom: 1px solid #e2e8f0;
          text-align: center;
        }
        .records-table th.align-left {
          text-align: left;
        }
        .records-table td {
          padding: 16px 16px;
          border-bottom: 1px solid #f1f5f9;
          vertical-align: middle;
          transition: background-color 0.2s ease;
          white-space: normal;
          word-break: break-word;
        }
        .records-table tr:hover td {
          background-color: rgba(248, 250, 252, 0.5);
        }
        
        /* Input styling inside table */
        .table-input {
          width: 100%;
          height: 30px;
          font-size: 13px;
          border-radius: 6px;
          border: 1px solid #cbd5e1;
          padding: 0 6px;
          text-align: center;
          outline: none;
          transition: border-color 0.15s ease;
          background-color: #ffffff;
        }
        .table-input:focus {
          border-color: #2563eb;
        }

        /* Badges */
        .badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 6px 12px;
          border-radius: 9999px;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
          white-space: nowrap;
        }
        .badge-red {
          background-color: #fef2f2;
          color: #ef4444;
          border: 1px solid #fee2e2;
        }
        .badge-orange {
          background-color: #fff7ed;
          color: #ea580c;
          border: 1px solid #ffedd5;
        }
        .badge-yellow {
          background-color: #fefbeb;
          color: #eab308;
          border: 1px solid #fef9c3;
        }
        .badge-green {
          background-color: #f0fdf4;
          color: #166534;
          border: 1px solid #dcfce7;
        }
        .badge-gray {
          background-color: #f1f5f9;
          color: #475569;
          border: 1px solid #e2e8f0;
        }
        
        .badge-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          font-weight: 600;
          color: #334155;
        }
      \`}</style>

      {/* Navigation Path & Header */}
      <div className="purchase-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500, marginBottom: '6px' }}>
            Workspace / 主系統
          </div>
          <h1 className="purchase-title">訂購紀錄表</h1>
          <p className="purchase-subtitle">
            追蹤商品採購進度，協助您入貨與結單行程規劃與進度管理。
          </p>
        </div>
        
        {/* Top-right desktop/mobile toggle buttons */}
        <div style={{ display: 'flex', gap: '0', border: '1px solid #e2e8f0', borderRadius: '6px', overflow: 'hidden' }}>
          <button style={{ padding: '6px 12px', fontSize: '12px', fontWeight: 600, backgroundColor: '#eff6ff', color: '#2563eb', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
            🖥️ 桌面版
          </button>
          <button style={{ padding: '6px 12px', fontSize: '12px', fontWeight: 600, backgroundColor: '#ffffff', color: '#64748b', border: 'none', borderLeft: '1px solid #e2e8f0', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
            📱 手機版
          </button>
        </div>
      </div>

      {/* 4 Work Status Cards */}
      <div className="status-cards-grid">
        {/* Card 1: 3天內結單 */}
        <div 
          className={\`status-card \${cardFilter === 'urgent3' ? 'active-card' : ''}\`}
          onClick={() => setCardFilter(cardFilter === 'urgent3' ? 'all' : 'urgent3')}
          style={{
            borderColor: cardFilter === 'urgent3' ? '#f43f5e' : '#e2e8f0',
            borderWidth: cardFilter === 'urgent3' ? '2px' : '1px'
          }}
        >
          <div className="icon-circle" style={{ backgroundColor: '#fff1f2' }}>
            🔥
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>3天內結單</div>
            <div className="card-value">
              {cardCounts.urgent3} <span style={{ fontSize: '14px', fontWeight: 500, color: '#64748b' }}>項</span>
            </div>
            <div className="card-desc">需盡快處理</div>
          </div>
        </div>

        {/* Card 2: 尚未下單 */}
        <div 
          className={\`status-card \${cardFilter === 'pending' ? 'active-card' : ''}\`}
          onClick={() => setCardFilter(cardFilter === 'pending' ? 'all' : 'pending')}
          style={{
            borderColor: cardFilter === 'pending' ? '#ea580c' : '#e2e8f0',
            borderWidth: cardFilter === 'pending' ? '2px' : '1px'
          }}
        >
          <div className="icon-circle" style={{ backgroundColor: '#fff7ed' }}>
            ⚠️
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>尚未下單</div>
            <div className="card-value">
              {cardCounts.pending} <span style={{ fontSize: '14px', fontWeight: 500, color: '#64748b' }}>項</span>
            </div>
            <div className="card-desc">待採購商品</div>
          </div>
        </div>

        {/* Card 3: 已下單完成 */}
        <div 
          className={\`status-card \${cardFilter === 'completed' ? 'active-card' : ''}\`}
          onClick={() => setCardFilter(cardFilter === 'completed' ? 'all' : 'completed')}
          style={{
            borderColor: cardFilter === 'completed' ? '#10b981' : '#e2e8f0',
            borderWidth: cardFilter === 'completed' ? '2px' : '1px'
          }}
        >
          <div className="icon-circle" style={{ backgroundColor: '#f0fdf4' }}>
            📦
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>已下單完成</div>
            <div className="card-value">
              {cardCounts.completed} <span style={{ fontSize: '14px', fontWeight: 500, color: '#64748b' }}>項</span>
            </div>
            <div className="card-desc">已完成採購</div>
          </div>
        </div>

        {/* Card 4: 開單中商品 */}
        <div 
          className={\`status-card \${cardFilter === 'active' ? 'active-card' : ''}\`}
          onClick={() => setCardFilter(cardFilter === 'active' ? 'all' : 'active')}
          style={{
            borderColor: cardFilter === 'active' ? '#3b82f6' : '#e2e8f0',
            borderWidth: cardFilter === 'active' ? '2px' : '1px'
          }}
        >
          <div className="icon-circle" style={{ backgroundColor: '#eff6ff' }}>
            📋
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>開單中商品</div>
            <div className="card-value">
              {cardCounts.active} <span style={{ fontSize: '14px', fontWeight: 500, color: '#64748b' }}>項</span>
            </div>
            <div className="card-desc">目前進行中</div>
          </div>
        </div>
      </div>

      {/* 今日需處理區 (7天內結單) */}
      <div className="urgent-section">
        <h3 className="urgent-title">
          <span>🔥 今日需處理 (7天內結單)</span>
        </h3>
        {urgentProxyGroups.length === 0 ? (
          <div style={{ fontSize: '13px', color: '#64748b', textAlign: 'center', padding: '16px 0' }}>
            目前沒有即將結單商品
          </div>
        ) : (
          <div className="urgent-grid">
            {urgentProxyGroups.slice(0, 3).map(g => {
              const { gap: shortage } = getGroupDemandAndPurchased(g.id);
              const remainingInfo = getRemainingDays(g.closing_date);
              
              // Use light red for <= 3 days, light orange for <= 7 days
              const cardBgColor = remainingInfo.text.includes('🔥') || remainingInfo.text.includes('已逾期') ? '#fff1f2' : '#fff7ed';
              const cardBorderColor = remainingInfo.text.includes('🔥') || remainingInfo.text.includes('已逾期') ? '#ffe4e6' : '#ffedd5';
              const dateText = g.closing_date ? \`\${new Date(g.closing_date).getMonth() + 1}/\${new Date(g.closing_date).getDate()}\` : '-';

              return (
                <div 
                  key={g.id} 
                  className="urgent-card"
                  onClick={(e) => handleRowClick(g.id, e)}
                  style={{
                    backgroundColor: cardBgColor,
                    borderColor: cardBorderColor
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#e11d48' }}>
                      \${dateText} 結單
                    </div>
                    <div className="urgent-card-title">{g.title}</div>
                  </div>
                  <div className="urgent-card-meta">
                    <span className="badge badge-red">缺 \${shortage}</span>
                    <span className="urgent-arrow">→</span>
                  </div>
                </div>
              );
            })}

            {/* Summary Card */}
            <div 
              className="urgent-card"
              style={{
                backgroundColor: '#eff6ff',
                borderColor: '#bfdbfe',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px'
              }}
              onClick={() => setCardFilter('urgent3')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ fontSize: '24px' }}>📅</div>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#1e293b' }}>
                    共 \${urgentProxyGroups.length} 項
                  </div>
                  <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 500 }}>
                    需要處理
                  </div>
                </div>
              </div>
              <div style={{ fontSize: '16px', color: '#2563eb', fontWeight: 'bold' }}>
                →
              </div>
            </div>
          </div>
        )}
      </div>

      {/*白色卡片搜尋與篩選工具列 */}
      <div className="filter-toolbar">
        {/* Row 1: Search */}
        <div className="search-wrapper" style={{ marginBottom: '16px' }}>
          <Search size={16} style={{ color: '#94a3b8', marginRight: '8px' }} />
          <input 
            type="text" 
            placeholder="搜尋商品名稱、商品編號、月份、類型..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Row 2: Selects & Actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          {/* Left selects */}
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="toolbar-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
              <label style={{ whiteSpace: 'nowrap' }}>商品來源</label>
              <select 
                className="toolbar-select" 
                value={sourceTab} 
                onChange={e => setSourceTab(e.target.value as any)}
                style={{ width: '110px', height: '36px' }}
              >
                <option value="all">全部</option>
                <option value="Hololive">Hololive</option>
                <option value="VSPO">VSPO</option>
                <option value="代理商品">代理商品</option>
                <option value="other">其他</option>
              </select>
            </div>

            <div className="toolbar-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
              <label style={{ whiteSpace: 'nowrap' }}>商品狀態</label>
              <select 
                className="toolbar-select" 
                value={filterStatus} 
                onChange={e => setFilterStatus(e.target.value)}
                style={{ width: '100px', height: '36px' }}
              >
                <option value="all">全部</option>
                <option value="開單中">開單中</option>
                <option value="已結單">已結單</option>
              </select>
            </div>

            <div className="toolbar-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
              <label style={{ whiteSpace: 'nowrap' }}>商品種類</label>
              <select 
                className="toolbar-select" 
                value={activeTab} 
                onChange={e => setActiveTab(e.target.value as any)}
                style={{ width: '110px', height: '36px' }}
              >
                <option value="all">全部</option>
                <option value="proxy">代理版商品</option>
                <option value="multi">多規格商品</option>
              </select>
            </div>

            <div className="toolbar-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
              <label style={{ whiteSpace: 'nowrap' }}>代理類別</label>
              <select 
                className="toolbar-select" 
                value={proxyFilter} 
                onChange={e => setProxyFilter(e.target.value as any)}
                style={{ width: '100px', height: '36px' }}
              >
                <option value="all">全部</option>
                <option value="pending">待採購</option>
                <option value="partial">部分採購</option>
                <option value="completed">已完成</option>
                <option value="urgent">即將結單</option>
              </select>
            </div>
          </div>

          {/* Right actions and sorting */}
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="toolbar-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
              <label style={{ whiteSpace: 'nowrap' }}>排序</label>
              <select 
                className="toolbar-select" 
                value={sortMode} 
                onChange={e => setSortMode(e.target.value)}
                style={{ width: '150px', height: '36px' }}
              >
                <option value="closing_urgent">結單日 (近期)</option>
                <option value="created_desc">建立時間 (新到舊)</option>
                <option value="closing_asc">結單日 (由近到遠)</option>
              </select>
            </div>

            <div className="toolbar-actions" style={{ height: '36px' }}>
              <button className="btn-filter" onClick={loadData}>
                🎛️ 篩選
              </button>
              <button className="btn-reset" onClick={handleResetFilters}>
                🔄 重設
              </button>
            </div>
          </div>
        </div>

        <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500, marginTop: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          共 <span style={{ color: '#2563eb', fontWeight: 700, fontSize: '15px' }}>{filteredAndSortedGroups.length}</span> 筆商品符合條件
        </div>
      </div>

      {/* Main Table */}
      {filteredAndSortedGroups.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={groups.length === 0 ? "尚未有訂購紀錄" : "找不到符合的紀錄"}
          description={groups.length === 0 ? "您可以透過匯入商品清單來自動產生母體，或手動建立。" : "請嘗試調整搜尋關鍵字或篩選條件。"}
          actionLabel={groups.length === 0 ? "前往商品清單匯入" : ""}
          onAction={() => groups.length === 0 ? navigate('/inventory') : undefined}
        />
      ) : (
        <div className="table-card">
          <table className="records-table">
            <thead>
              <tr>
                <th style={{ width: '13%', textAlign: 'center' }}>結單日</th>
                <th style={{ width: '8%', textAlign: 'center' }}>狀態</th>
                <th style={{ width: '33%' }} className="align-left">商品名稱 / 種類</th>
                <th style={{ width: '8%', textAlign: 'center' }}>缺口</th>
                <th style={{ width: '16%', textAlign: 'center' }}>下單進度</th>
                <th style={{ width: '12%', textAlign: 'center' }}>結單日</th>
                <th style={{ width: '10%', textAlign: 'center' }}>備註</th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSortedGroups.map(g => {
                const isProxy = checkIsProxyProduct(g);
                const { demand, purchased, gap } = getGroupDemandAndPurchased(g.id);
                const status = getGroupStatus(g);
                const rowBg = getRowBgColor(g.closing_date);

                const proxyDetails = (() => {
                  const catIds = new Set(categories.filter(c => c.product_group_id === g.id).map(c => c.id));
                  const groupVars = variants.filter(v => v.product_group_id === g.id || (v.product_category_id && catIds.has(v.product_category_id)));
                  
                  let myacgQty = 0;
                  let wacaQty = 0;
                  let privateQty = 0;
                  let orderedQty = 0;
                  
                  groupVars.forEach(v => {
                    myacgQty += calculateFinalMyacgDemand(v.myacg_item_code, inventory, salesOrderItems) + (v.myacg_manual_adjustment || 0);
                    wacaQty += (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                    privateQty += privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
                    orderedQty += batchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((sum, item) => sum + item.quantity, 0);
                  });
                  
                  const totalDemand = myacgQty + wacaQty + privateQty;
                  const shortage = Math.max(totalDemand - orderedQty, 0);
                  
                  return {
                    myacgQty,
                    wacaQty,
                    privateQty,
                    totalDemand,
                    orderedQty,
                    shortage
                  };
                })();

                return (
                  <tr 
                    key={g.id} 
                    onClick={(e) => handleRowClick(g.id, e)}
                    style={{ backgroundColor: rowBg, cursor: editMode ? 'default' : 'pointer' }}
                  >
                    {/* 1. 結單日 (官方結單日) */}
                    <td style={{ textAlign: 'center' }}>
                      {editMode ? (
                        <input 
                          className="table-input" 
                          type="date" 
                          value={g.closing_date || ''} 
                          onChange={e => handleUpdateGroupField(g.id, 'closing_date', e.target.value)} 
                        />
                      ) : (
                        renderClosingDateWithSubtext(g.closing_date)
                      )}
                    </td>

                    {/* 2. 狀態 */}
                    <td style={{ textAlign: 'center' }}>
                      <span className="badge-status">
                        <span style={{ 
                          width: '8px', 
                          height: '8px', 
                          borderRadius: '50%', 
                          backgroundColor: status.active ? '#22c55e' : '#64748b',
                          display: 'inline-block',
                          marginRight: '6px'
                        }}></span>
                        {status.text.replace(/^[🟢⚫]\s*/, '')}
                      </span>
                    </td>

                    {/* 3. 商品名稱 / 種類 */}
                    <td className="align-left" style={{ fontWeight: 600, color: '#1e293b' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {editMode ? (
                          <input 
                            className="table-input" 
                            style={{ textAlign: 'left', padding: '0 8px' }}
                            value={g.title || ''} 
                            onChange={e => handleUpdateGroupField(g.id, 'title', e.target.value)} 
                          />
                        ) : (
                          <div>{g.normalized_title || g.title}</div>
                        )}
                        {g.listing_type && (
                          <div>
                            <span className="badge badge-gray" style={{ padding: '2px 8px', fontSize: '11px', borderRadius: '4px' }}>
                              {g.listing_type}
                            </span>
                          </div>
                        )}
                      </div>
                    </td>

                    {/* 4. 缺口 */}
                    <td style={{ textAlign: 'center' }}>
                      {getShortageBadge(gap, purchased)}
                    </td>

                    {/* 5. 下單進度 */}
                    <td style={{ textAlign: 'center' }}>
                      {editMode && isProxy ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start', paddingLeft: '8px' }}>
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '11px' }}>
                            <span style={{ color: '#64748b', minWidth: '42px', textAlign: 'right' }}>買動漫:</span>
                            <input 
                              type="number" 
                              className="table-input" 
                              style={{ width: '48px', height: '22px', fontSize: '11px', textAlign: 'center' }} 
                              value={proxyDetails.myacgQty} 
                              onChange={e => handleUpdateProxyPlatformDemand(g.id, 'myacg', parseInt(e.target.value) || 0)} 
                            />
                          </div>
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '11px' }}>
                            <span style={{ color: '#64748b', minWidth: '42px', textAlign: 'right' }}>WACA:</span>
                            <input 
                              type="number" 
                              className="table-input" 
                              style={{ width: '48px', height: '22px', fontSize: '11px', textAlign: 'center' }} 
                              value={proxyDetails.wacaQty} 
                              onChange={e => handleUpdateProxyPlatformDemand(g.id, 'waca', parseInt(e.target.value) || 0)} 
                            />
                          </div>
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '11px' }}>
                            <span style={{ color: '#64748b', minWidth: '42px', textAlign: 'right' }}>已下單:</span>
                            <input 
                              type="number" 
                              className="table-input" 
                              style={{ width: '48px', height: '22px', fontSize: '11px', textAlign: 'center' }} 
                              value={proxyDetails.orderedQty} 
                              onChange={e => handleUpdateProxyOrderedQty(g.id, parseInt(e.target.value) || 0)} 
                            />
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, color: '#475569' }}>已下單 {purchased} / {demand}</span>
                          {editMode && !isProxy && (
                            <span style={{ fontSize: '10px', color: '#94a3b8' }}>(多規格需至詳情頁編輯)</span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* 6. 結單日 (下單日期) */}
                    <td style={{ textAlign: 'center' }}>
                      {editMode ? (
                        <input 
                          className="table-input" 
                          type="date" 
                          value={g.purchase_date || ''} 
                          onChange={e => handleUpdateGroupField(g.id, 'purchase_date', e.target.value)} 
                        />
                      ) : (
                        <span style={{ 
                          fontWeight: 600, 
                          color: g.purchase_date ? '#475569' : '#94a3b8' 
                        }}>
                          {g.purchase_date || '-'}
                        </span>
                      )}
                    </td>

                    {/* 7. 備註 */}
                    <td style={{ textAlign: 'center' }}>
                      {editMode ? (
                        <input 
                          className="table-input" 
                          style={{ textAlign: 'left', padding: '0 8px' }}
                          value={g.note || ''} 
                          onChange={e => handleUpdateGroupField(g.id, 'note', e.target.value)} 
                        />
                      ) : (
                        <span style={{ color: '#64748b' }}>{g.note || '-'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Floating Action Button (FAB) */}
      <button
        onClick={() => {
          const nextMode = !editMode;
          setEditMode(nextMode);
          localStorage.setItem('purchase_records_edit_mode', String(nextMode));
        }}
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: 9999,
          height: '46px',
          padding: '0 24px',
          fontWeight: 700,
          fontSize: '14px',
          borderRadius: '9999px',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          backgroundColor: editMode ? '#ea580c' : '#2563eb',
          color: '#ffffff',
          boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
          transition: 'all 0.2s ease',
          outline: 'none'
        }}
      >
        {editMode ? '✏️ 編輯模式' : '🔒 鎖定模式'}
      </button>
    </div>
  );
}
`;

const finalContent = beforePatch + patchCode;
fs.writeFileSync(filePath, finalContent, 'utf8');
console.log("Successfully patched PurchaseRecords.tsx and cleaned unused variables!");
