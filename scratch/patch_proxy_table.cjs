const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'pages', 'PurchaseRecords.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize line endings to LF
content = content.replace(/\r\n/g, '\n');

// 1. Insert Tabs before {/*白色卡片搜尋與篩選工具列 */}
const targetToolbar = '      {/*白色卡片搜尋與篩選工具列 */}';
const toolbarIndex = content.indexOf(targetToolbar);
if (toolbarIndex === -1) {
  console.error("Toolbar target not found!");
  process.exit(1);
}

const tabsJsx = `      {/* Tabs */}
      <div style={{ display: 'flex', gap: '24px', borderBottom: '1px solid #e2e8f0', paddingBottom: '0px', marginBottom: '20px' }}>
        <button 
          onClick={() => setActiveTab('all')}
          style={{
            padding: '12px 8px',
            fontSize: '15px',
            fontWeight: 700,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'all' ? '3px solid #2563eb' : '3px solid transparent',
            color: activeTab === 'all' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          全部商品 <span style={{ fontSize: '12px', fontWeight: 500, backgroundColor: activeTab === 'all' ? '#dbeafe' : '#f1f5f9', color: activeTab === 'all' ? '#2563eb' : '#64748b', padding: '2px 8px', borderRadius: '12px' }}>{groups.length}</span>
        </button>
        <button 
          onClick={() => setActiveTab('proxy')}
          style={{
            padding: '12px 8px',
            fontSize: '15px',
            fontWeight: 700,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'proxy' ? '3px solid #2563eb' : '3px solid transparent',
            color: activeTab === 'proxy' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          代理版商品 <span style={{ fontSize: '12px', fontWeight: 500, backgroundColor: activeTab === 'proxy' ? '#dbeafe' : '#f1f5f9', color: activeTab === 'proxy' ? '#2563eb' : '#64748b', padding: '2px 8px', borderRadius: '12px' }}>{groups.filter(checkIsProxyProduct).length}</span>
        </button>
        <button 
          onClick={() => setActiveTab('multi')}
          style={{
            padding: '12px 8px',
            fontSize: '15px',
            fontWeight: 700,
            cursor: 'pointer',
            border: 'none',
            background: 'none',
            borderBottom: activeTab === 'multi' ? '3px solid #2563eb' : '3px solid transparent',
            color: activeTab === 'multi' ? '#2563eb' : '#64748b',
            transition: 'all 0.2s',
            marginBottom: '-1px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          多規格商品 <span style={{ fontSize: '12px', fontWeight: 500, backgroundColor: activeTab === 'multi' ? '#dbeafe' : '#f1f5f9', color: activeTab === 'multi' ? '#2563eb' : '#64748b', padding: '2px 8px', borderRadius: '12px' }}>{groups.filter(g => !checkIsProxyProduct(g)).length}</span>
        </button>
      </div>\n\n`;

content = content.substring(0, toolbarIndex) + tabsJsx + content.substring(toolbarIndex);

// 2. Remove the "商品種類" select dropdown field dynamically
const targetSelectText = '商品種類';
const selectTextIdx = content.indexOf(targetSelectText);
if (selectTextIdx === -1) {
  console.error("Select text '商品種類' not found!");
  process.exit(1);
}

// Search backward for the opening <div of the select block
const divStartIdx = content.lastIndexOf('<div className="toolbar-field"', selectTextIdx);
// Search forward for the closing </div> of the select block
const divEndIdx = content.indexOf('</div>', selectTextIdx);

if (divStartIdx === -1 || divEndIdx === -1) {
  console.error("Could not find surrounding div container!");
  process.exit(1);
}

const endOffset = divEndIdx + '</div>'.length;
content = content.substring(0, divStartIdx) + content.substring(endOffset);

// 3. Find and replace table-card section
const tableCardStart = content.indexOf('<div className="table-card">');
const fabStart = content.indexOf('{/* Floating Action Button (FAB) */}');
if (tableCardStart === -1 || fabStart === -1) {
  console.error("Table card or FAB not found!");
  process.exit(1);
}

// Extract the original table body block from the file
const originalTableBlock = content.substring(tableCardStart, fabStart).trim();

// Use index search to extract the inner table JSX cleanly
const tableStart = originalTableBlock.indexOf('<table');
const tableEnd = originalTableBlock.lastIndexOf('</table>') + '</table>'.length;
if (tableStart === -1 || tableEnd === -1) {
  console.error("Could not locate inner table tags!");
  process.exit(1);
}
const innerTable = originalTableBlock.substring(tableStart, tableEnd);

// Construct the new conditional JSX with LF endings
const proxyTableJsx = `        <div className="table-card">
          {activeTab === 'proxy' ? (
            <table className="records-table">
              <thead>
                <tr>
                  <th style={{ width: '32%', textAlign: 'left' }} className="align-left">商品名稱</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>買動漫數量</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>WACA數量</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>私下訂購數量</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>總需求</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>已下單數量</th>
                  <th style={{ width: '8%', textAlign: 'center' }}>缺少數量</th>
                  <th style={{ width: '13%', textAlign: 'center' }}>官方結單日</th>
                  <th style={{ width: '13%', textAlign: 'center' }}>下單日期</th>
                </tr>
              </thead>
              <tbody>
                {filteredAndSortedGroups.map(g => {
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
                      {/* 1. 商品名稱 */}
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

                      {/* 2. 買動漫數量 */}
                      <td style={{ textAlign: 'center' }}>
                        {editMode ? (
                          <input 
                            type="number" 
                            className="table-input" 
                            style={{ width: '60px', height: '28px', textAlign: 'center' }} 
                            value={proxyDetails.myacgQty} 
                            onChange={e => handleUpdateProxyPlatformDemand(g.id, 'myacg', parseInt(e.target.value) || 0)} 
                          />
                        ) : (
                          <span style={{ fontWeight: 600, color: '#334155' }}>{proxyDetails.myacgQty}</span>
                        )}
                      </td>

                      {/* 3. WACA數量 */}
                      <td style={{ textAlign: 'center' }}>
                        {editMode ? (
                          <input 
                            type="number" 
                            className="table-input" 
                            style={{ width: '60px', height: '28px', textAlign: 'center' }} 
                            value={proxyDetails.wacaQty} 
                            onChange={e => handleUpdateProxyPlatformDemand(g.id, 'waca', parseInt(e.target.value) || 0)} 
                          />
                        ) : (
                          <span style={{ fontWeight: 600, color: '#334155' }}>{proxyDetails.wacaQty}</span>
                        )}
                      </td>

                      {/* 4. 私下訂購數量 */}
                      <td style={{ textAlign: 'center', fontWeight: 600, color: '#64748b' }}>
                        {proxyDetails.privateQty}
                      </td>

                      {/* 5. 總需求 */}
                      <td style={{ textAlign: 'center', fontWeight: 700, color: '#1e293b' }}>
                        {proxyDetails.totalDemand}
                      </td>

                      {/* 6. 已下單數量 */}
                      <td style={{ textAlign: 'center' }}>
                        {editMode ? (
                          <input 
                            type="number" 
                            className="table-input" 
                            style={{ width: '60px', height: '28px', textAlign: 'center' }} 
                            value={proxyDetails.orderedQty} 
                            onChange={e => handleUpdateProxyOrderedQty(g.id, parseInt(e.target.value) || 0)} 
                          />
                        ) : (
                          <span style={{ fontWeight: 600, color: '#334155' }}>{proxyDetails.orderedQty}</span>
                        )}
                      </td>

                      {/* 7. 缺少數量 */}
                      <td style={{ textAlign: 'center' }}>
                        {getShortageBadge(proxyDetails.shortage, g.closing_date)}
                      </td>

                      {/* 8. 官方結單日 */}
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

                      {/* 9. 下單日期 */}
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
                            fontWeight: 700, 
                            color: getDateTextColor(g.purchase_date) 
                          }}>
                            {g.purchase_date || '-'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            ${innerTable}
          )}
        </div>
      )}`;

// Replace table card section cleanly
content = content.substring(0, tableCardStart) + proxyTableJsx + '\n\n      ' + content.substring(fabStart);

fs.writeFileSync(filePath, content, 'utf8');
console.log("Successfully patched proxy table structure with robust string slice!");
