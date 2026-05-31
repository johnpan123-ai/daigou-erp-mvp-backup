const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'pages', 'PurchaseRecords.tsx');
let content = fs.readFileSync(filePath, 'utf8');

const targetStr = `  const handleRowClick = (id: string, e: React.MouseEvent) => {
    // Don't navigate if clicking inputs/buttons
    if ((e.target as HTMLElement).tagName === 'INPUT' || 
        (e.target as HTMLElement).tagName === 'SELECT' || 
        (e.target as HTMLElement).tagName === 'BUTTON' ||
        (e.target as HTMLElement).closest('button')) {
      return;
    }
    if (editMode) return;
    navigate(\`/purchase-records/\${id}\`);
  };`;

const targetIndex = content.indexOf(targetStr);
if (targetIndex === -1) {
  console.error("Target handleRowClick function not found!");
  process.exit(1);
}

const beforeReturn = content.substring(0, targetIndex + targetStr.length);

const patchCode = `

  const handleResetFilters = () => {
    setSearchTerm('');
    setFilterSource('all');
    setFilterStatus('all');
    setFilterType('all');
    setProxyFilter('all');
    setCardFilter('all');
    setSortMode('closing_urgent');
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
      subtext = '(已結單)';
      color = '#64748b';
    } else if (diffDays <= 3) {
      subtext = \`(\${diffDays}天內結單)\`;
      color = '#ef4444'; // Red
    } else if (diffDays <= 7) {
      subtext = \`(\${diffDays}天內結單)\`;
      color = '#f97316'; // Orange
    } else if (diffDays <= 14) {
      subtext = \`(\${diffDays}天內結單)\`;
      color = '#2563eb'; // Blue
    } else {
      subtext = \`(剩 \${diffDays} 天)\`;
      color = '#475569';
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, color: diffDays <= 3 && diffDays >= 0 ? '#ef4444' : '#334155' }}>
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
    
    if (diffDays < 0) return '#ffffff';
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

        /* Double layer tabs */
        .tabs-container {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 20px;
          background-color: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.02);
        }
        .tab-row {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .tab-btn {
          padding: 6px 14px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid transparent;
          background: none;
          border-radius: 6px;
          color: #64748b;
          transition: all 0.2s;
          outline: none;
        }
        .tab-btn:hover {
          color: #334155;
          background-color: #f1f5f9;
        }
        .tab-btn.active {
          color: #2563eb;
          background-color: #eff6ff;
          border-color: #bfdbfe;
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
          color: #ea580c;
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
      <div className="purchase-header">
        <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 500, marginBottom: '6px' }}>
          Workspace / 主系統
        </div>
        <h1 className="purchase-title">訂購紀錄表</h1>
        <p className="purchase-subtitle">
          追蹤商品採購進度，協助您入貨與結單行程規劃與進度管理。
        </p>
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
            {urgentProxyGroups.map(g => {
              const { gap: shortage } = getGroupDemandAndPurchased(g.id);
              const remainingInfo = getRemainingDays(g.closing_date);
              
              // Use light red for <= 3 days, light orange for <= 7 days
              const cardBgColor = remainingInfo.text.includes('🔥') ? '#fff1f2' : '#fff7ed';
              const cardBorderColor = remainingInfo.text.includes('🔥') ? '#ffe4e6' : '#ffedd5';
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
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#64748b' }}>
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

      {/* Double layer tabs */}
      <div className="tabs-container">
        {/* 第一層：商品來源 */}
        <div className="tab-row" style={{ borderBottom: '1px solid #f1f5f9', paddingBottom: '6px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#475569', alignSelf: 'center', marginRight: '8px' }}>來源分類：</span>
          <button 
            className={\`tab-btn \${sourceTab === 'all' ? 'active' : ''}\`}
            onClick={() => setSourceTab('all')}
          >
            全部商品 ({tabCounts.source.all})
          </button>
          <button 
            className={\`tab-btn \${sourceTab === 'Hololive' ? 'active' : ''}\`}
            onClick={() => setSourceTab('Hololive')}
          >
            Hololive ({tabCounts.source.hololive})
          </button>
          <button 
            className={\`tab-btn \${sourceTab === 'VSPO' ? 'active' : ''}\`}
            onClick={() => setSourceTab('VSPO')}
          >
            VSPO ({tabCounts.source.vspo})
          </button>
          <button 
            className={\`tab-btn \${sourceTab === '代理商品' ? 'active' : ''}\`}
            onClick={() => setSourceTab('代理商品')}
          >
            代理商品 ({tabCounts.source.proxy})
          </button>
          <button 
            className={\`tab-btn \${sourceTab === 'other' ? 'active' : ''}\`}
            onClick={() => setSourceTab('other')}
          >
            其他 ({tabCounts.source.other})
          </button>
        </div>

        {/* 第二層：商品型態 */}
        <div className="tab-row">
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#475569', alignSelf: 'center', marginRight: '8px' }}>商品型態：</span>
          <button 
            className={\`tab-btn \${activeTab === 'all' ? 'active' : ''}\`}
            onClick={() => setActiveTab('all')}
          >
            全部型態 ({tabCounts.type.all})
          </button>
          <button 
            className={\`tab-btn \${activeTab === 'proxy' ? 'active' : ''}\`}
            onClick={() => setActiveTab('proxy')}
          >
            代理版商品 ({tabCounts.type.proxy})
          </button>
          <button 
            className={\`tab-btn \${activeTab === 'multi' ? 'active' : ''}\`}
            onClick={() => setActiveTab('multi')}
          >
            多規格商品 ({tabCounts.type.multi})
          </button>
        </div>
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
                value={filterSource} 
                onChange={e => setFilterSource(e.target.value)}
                style={{ width: '110px', height: '36px' }}
              >
                <option value="all">全部</option>
                <option value="Hololive">Hololive</option>
                <option value="VSPO">VSPO</option>
                <option value="代理商品">代理商品</option>
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
                value={filterType} 
                onChange={e => setFilterType(e.target.value)}
                style={{ width: '110px', height: '36px' }}
              >
                <option value="all">全部</option>
                <option value="一般預購">一般預購</option>
                <option value="現貨">現貨</option>
                <option value="現地代購">現地代購</option>
                <option value="日本代購">日本代購</option>
                <option value="代理版">代理版</option>
              </select>
            </div>

            {activeTab === 'proxy' && (
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
            )}
          </div>

          {/* Right actions and sorting */}
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="toolbar-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
              <label style={{ whiteSpace: 'nowrap' }}>排序</label>
              <select 
                className="toolbar-select" 
                value={sortMode} 
                onChange={e => setSortMode(e.target.value)}
                style={{ width: '170px', height: '36px' }}
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
          {activeTab === 'proxy' ? (
            <table className="records-table">
              <thead>
                <tr>
                  <th style={{ width: '25%' }} className="align-left">商品名稱</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>買動漫數量</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>WACA數量</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>私下訂購</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>已下單</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>缺少數量</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>採購狀態</th>
                  <th style={{ width: '13%', textAlign: 'center' }}>官方結單日</th>
                  <th style={{ width: '12%', textAlign: 'center' }}>剩餘天數</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>發售月份</th>
                </tr>
              </thead>
              <tbody>
                {filteredAndSortedGroups.map(g => {
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
                  
                  const rowBg = getRowBgColor(g.closing_date);
                  const remainingInfo = getRemainingDays(g.closing_date);
                  const shortage = proxyDetails.shortage;
                  const statusInfo = getPurchaseStatus(shortage, proxyDetails.orderedQty);

                  return (
                    <tr 
                      key={g.id} 
                      onClick={(e) => handleRowClick(g.id, e)}
                      style={{ backgroundColor: rowBg, cursor: editMode ? 'default' : 'pointer' }}
                    >
                      <td className="align-left" style={{ fontWeight: 600, color: '#1e293b' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div>{g.title}</div>
                          {g.listing_type && (
                            <div>
                              <span className="badge badge-gray" style={{ padding: '2px 8px', fontSize: '11px', borderRadius: '4px' }}>
                                {g.listing_type}
                              </span>
                            </div>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {editMode ? (
                          <input 
                            className="table-input" 
                            type="number" 
                            min="0" 
                            value={proxyDetails.myacgQty || 0} 
                            onChange={e => handleUpdateProxyPlatformDemand(g.id, 'myacg', parseInt(e.target.value) || 0)} 
                          />
                        ) : (
                          <span style={{ fontWeight: 600, color: '#475569' }}>{proxyDetails.myacgQty}</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {editMode ? (
                          <input 
                            className="table-input" 
                            type="number" 
                            min="0" 
                            value={proxyDetails.wacaQty || 0} 
                            onChange={e => handleUpdateProxyPlatformDemand(g.id, 'waca', parseInt(e.target.value) || 0)} 
                          />
                        ) : (
                          <span style={{ fontWeight: 600, color: '#475569' }}>{proxyDetails.wacaQty}</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: '#475569' }}>
                        {proxyDetails.privateQty}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {editMode ? (
                          <input 
                            className="table-input" 
                            type="number" 
                            min="0" 
                            value={proxyDetails.orderedQty || 0} 
                            onChange={e => handleUpdateProxyOrderedQty(g.id, parseInt(e.target.value) || 0)} 
                          />
                        ) : (
                          <span style={{ fontWeight: 600, color: '#475569' }}>{proxyDetails.orderedQty}</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {getShortageBadge(shortage, proxyDetails.orderedQty)}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '4px 10px',
                          borderRadius: '9999px',
                          fontSize: '11px',
                          fontWeight: 600,
                          backgroundColor: statusInfo.backgroundColor,
                          color: statusInfo.color,
                          border: statusInfo.border
                        }}>
                          {statusInfo.text}
                        </span>
                      </td>
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
                      <td style={{ textAlign: 'center', color: remainingInfo.color, fontWeight: remainingInfo.fontWeight }}>
                        {remainingInfo.text}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {editMode ? (
                          <input 
                            className="table-input" 
                            type="text" 
                            placeholder="例如：2026-11"
                            value={g.release_month || ''} 
                            onChange={e => handleUpdateGroupField(g.id, 'release_month', e.target.value)} 
                          />
                        ) : (
                          <span style={{ fontWeight: 500, color: '#475569' }}>{g.release_month || '-'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="records-table">
              <thead>
                <tr>
                  <th style={{ width: '15%', textAlign: 'center' }}>購買結單日</th>
                  <th style={{ width: '12%', textAlign: 'center' }}>狀態</th>
                  <th style={{ width: '35%' }} className="align-left">商品名稱 / 種類</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>缺口</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>下單進度</th>
                  <th style={{ width: '12%', textAlign: 'center' }}>結單日</th>
                  <th style={{ width: '6%', textAlign: 'center' }}>官網</th>
                </tr>
              </thead>
              <tbody>
                {filteredAndSortedGroups.map(g => {
                  const { demand, purchased, gap } = getGroupDemandAndPurchased(g.id);
                  const status = getGroupStatus(g);
                  const rowBg = getRowBgColor(g.closing_date);

                  return (
                    <tr 
                      key={g.id} 
                      onClick={(e) => handleRowClick(g.id, e)}
                      style={{ backgroundColor: rowBg, cursor: editMode ? 'default' : 'pointer' }}
                    >
                      <td style={{ textAlign: 'center' }}>
                        {editMode ? (
                          <input 
                            className="table-input" 
                            type="date" 
                            value={g.purchase_date || ''} 
                            onChange={e => handleUpdateGroupField(g.id, 'purchase_date', e.target.value)} 
                          />
                        ) : (
                          renderClosingDateWithSubtext(g.purchase_date)
                        )}
                      </td>
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
                      <td style={{ textAlign: 'center' }}>
                        {getShortageBadge(gap, purchased)}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: '#475569' }}>
                        已下單 {purchased} / {demand}
                      </td>
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
                      <td style={{ textAlign: 'center' }}>
                        {editMode ? (
                          <input 
                            className="table-input" 
                            placeholder="官網連結"
                            value={g.product_url || ''} 
                            onChange={e => handleUpdateGroupField(g.id, 'product_url', e.target.value)} 
                          />
                        ) : g.product_url ? (
                          <a 
                            href={g.product_url} 
                            target="_blank" 
                            rel="noreferrer" 
                            style={{ color: '#2563eb', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                            onClick={e => e.stopPropagation()}
                          >
                            🔗 官網
                          </a>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
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

const afterReturnIndex = content.indexOf('  return (', targetIndex);
if (afterReturnIndex === -1) {
  console.error("Return statement not found!");
  process.exit(1);
}

const finalContent = beforeReturn + patchCode;
fs.writeFileSync(filePath, finalContent, 'utf8');
console.log("Successfully patched PurchaseRecords.tsx!");
