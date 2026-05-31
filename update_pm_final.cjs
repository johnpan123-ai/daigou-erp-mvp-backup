const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// Replace pNeed/pExcess calculation
code = code.replace(/pNeed \+= Math\.max\(tDemand - tPurchased, 0\);/g, 'pDiff += (tPurchased - tDemand);');
code = code.replace(/pExcess \+= Math\.max\(tPurchased - tDemand, 0\);/g, '');

// Replace the UI badges in category card
// {pNeed > 0 && <span style={{ color: '#ef4444', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>總缺貨 {pNeed} 件</span>}
// {pNeed === 0 && pExcess > 0 && <span style={{ color: '#f97316', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>多買 {pExcess} 件</span>}
const oldBadges = `{pNeed > 0 && <span style={{ color: '#ef4444', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>總缺貨 {pNeed} 件</span>}
                      {pNeed === 0 && pExcess > 0 && <span style={{ color: '#f97316', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>多買 {pExcess} 件</span>}`;

const newBadges = `{pDiff < 0 && <span style={{ color: '#ef4444', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>總缺貨 {Math.abs(pDiff)} 件</span>}
                      {pDiff > 0 && <span style={{ color: '#22c55e', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>多買 {pDiff} 件</span>}`;

code = code.replace(oldBadges, newBadges);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Fixed final leftovers');
