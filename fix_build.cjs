const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Remove the old filterMode buttons block, keeping only the sort select.
const oldFilterBlock = `<div style={{ display: 'flex', backgroundColor: '#f1f5f9', padding: '4px', borderRadius: '8px' }}>
              <div 
                style={{ padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', borderRadius: '6px', color: filterMode === 'abnormal' ? '#2563eb' : '#64748b', backgroundColor: filterMode === 'abnormal' ? '#fff' : 'transparent', boxShadow: filterMode === 'abnormal' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none' }}
                onClick={() => setFilterMode('abnormal')}
              >只顯示異常 (缺貨/多買)</div>
              <div 
                style={{ padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', borderRadius: '6px', color: filterMode === 'all' ? '#1e293b' : '#64748b', backgroundColor: filterMode === 'all' ? '#fff' : 'transparent', boxShadow: filterMode === 'all' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none' }}
                onClick={() => setFilterMode('all')}
              >顯示全部商品</div>
            </div>

            <div style={{ margin: '0 16px', width: '1px', height: '24px', backgroundColor: '#e2e8f0' }}></div>`;

code = code.replace(oldFilterBlock, '');

// 2. Add some fallback to fix any remaining 'filterMode' to 'viewMode' if missed
// but since we deleted the block, there shouldn't be any.

// Write back
fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Old filterMode removed.");
