const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. 商品名稱 (RenderSkuRow)
code = code.replace(
  `<div style={{ fontWeight: 600, color: '#1e293b', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>`,
  `<div style={{ fontWeight: 700, color: '#1e293b', fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>`
);

// 2. SKU 顏色再淡一點、維持 12px (Currently 11px)
code = code.replace(
  `<div style={{ fontSize: '11px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '6px' }}>`,
  `<div style={{ fontSize: '12px', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '6px' }}>`
);

// 3. 數量欄位 14px, 600
// Replace all inputs in RenderSkuRow
code = code.replaceAll(
  `fontSize: '13px', backgroundColor: '#fff' }}`,
  `fontSize: '14px', fontWeight: 600, backgroundColor: '#fff' }}`
);
// Replace all spans displaying the numbers
code = code.replaceAll(
  `<span style={{ fontWeight: 600, color: myacgDemand > 0 ? '#334155' : '#94a3b8' }}>{myacgDemand > 0 ? myacgDemand : '-'}</span>`,
  `<span style={{ fontWeight: 600, fontSize: '14px', color: myacgDemand > 0 ? '#1e293b' : '#cbd5e1' }}>{myacgDemand > 0 ? myacgDemand : '-'}</span>`
);
code = code.replaceAll(
  `<span style={{ fontWeight: 600, color: wacaDemand > 0 ? '#334155' : '#94a3b8' }}>{wacaDemand > 0 ? wacaDemand : '-'}</span>`,
  `<span style={{ fontWeight: 600, fontSize: '14px', color: wacaDemand > 0 ? '#1e293b' : '#cbd5e1' }}>{wacaDemand > 0 ? wacaDemand : '-'}</span>`
);
code = code.replaceAll(
  `<span style={{ fontWeight: 600, color: privateDemand > 0 ? '#db2777' : '#94a3b8', backgroundColor: privateDemand > 0 && !isSingle ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>{privateDemand > 0 ? privateDemand : '-'}</span>`,
  `<span style={{ fontWeight: 600, fontSize: '14px', color: privateDemand > 0 ? '#db2777' : '#cbd5e1', backgroundColor: privateDemand > 0 && !isSingle ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>{privateDemand > 0 ? privateDemand : '-'}</span>`
);
code = code.replaceAll(
  `<span style={{ fontWeight: 600, color: totalPurchased > 0 ? '#2563eb' : '#94a3b8' }}>{totalPurchased > 0 ? totalPurchased : '-'}</span>`,
  `<span style={{ fontWeight: 600, fontSize: '14px', color: totalPurchased > 0 ? '#2563eb' : '#cbd5e1' }}>{totalPurchased > 0 ? totalPurchased : '-'}</span>`
);

// 4. 群組 Header (16px, 700)
// There are multiple group headers (standard and shortage mode)
code = code.replaceAll(
  `<div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px' }}>`,
  `<div style={{ fontWeight: 700, color: '#1e293b', fontSize: '16px' }}>`
);
code = code.replaceAll(
  `<div style={{ fontWeight: 600, color: '#334155', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>`,
  `<div style={{ fontWeight: 700, color: '#1e293b', fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>`
);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Hierarchy fixed');
