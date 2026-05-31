const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Sort logic update
// Before:
// sum + Math.max((myacgDemand + wacaDemand + privateDemand) - totalPurchased, 0)
// getShortage(itemsB) - getShortage(itemsA) -> descending shortage
// Now we want to sort by Difference ascending: totalPurchased - totalDemand
const oldSortLogic = `      const getShortage = (items: ProductVariant[]) => items.reduce((sum, v) => {
        const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
        const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
        const privateDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        return sum + Math.max((myacgDemand + wacaDemand + privateDemand) - totalPurchased, 0);
      }, 0);
      return getShortage(itemsB) - getShortage(itemsA);`;

const newSortLogic = `      const getDiff = (items: ProductVariant[]) => items.reduce((sum, v) => {
        const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
        const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
        const privateDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        return sum + (totalPurchased - (myacgDemand + wacaDemand + privateDemand));
      }, 0);
      return getDiff(itemsA) - getDiff(itemsB); // Ascending diff (most negative/shortage first)`;

code = code.replace(oldSortLogic, newSortLogic);


// 2. Variables computation in single item rendering & group headers
// Before:
// let pMyacg = 0, pWaca = 0, pManual = 0, pNeed = 0, pExcess = 0, pPurchased = 0, pDemand = 0;
// pNeed += Math.max(tDemand - tPurchased, 0);
// pExcess += Math.max(tPurchased - tDemand, 0);
// After:
// let pMyacg = 0, pWaca = 0, pManual = 0, pDiff = 0, pPurchased = 0, pDemand = 0;
// pDiff += (tPurchased - tDemand);

code = code.replace(/let pMyacg = 0, pWaca = 0, pManual = 0, pNeed = 0, pExcess = 0, pPurchased = 0, pDemand = 0;/, 'let pMyacg = 0, pWaca = 0, pManual = 0, pDiff = 0, pPurchased = 0, pDemand = 0;');
code = code.replace(/pNeed \+= Math\.max\(tDemand - tPurchased, 0\);/g, 'pDiff += (tPurchased - tDemand);');
code = code.replace(/pExcess \+= Math\.max\(tPurchased - tDemand, 0\);/g, '');


// 3. Border Color logic
// Before:
// let borderColor = "#cbd5e1";
// if (pNeed > 0) borderColor = "#ef4444";
// else if (pExcess > 0) borderColor = "#f97316";
// After:
// let borderColor = "#cbd5e1";
// if (pDiff < 0) borderColor = "#ef4444";
// else if (pDiff > 0) borderColor = "#f97316"; // or green

code = code.replace(/let borderColor = "#cbd5e1";\s*if \(pNeed > 0\) borderColor = "#ef4444";\s*else if \(pExcess > 0\) borderColor = "#f97316";/g, 'let borderColor = "#cbd5e1";\n              if (pDiff < 0) borderColor = "#ef4444";\n              else if (pDiff > 0) borderColor = "#22c55e";');

// 4. Single item rendering UI: replace pNeed and pExcess with pDiff
// Before:
/*
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>還缺</span>
                          <span style={{ fontWeight: 700, color: pNeed > 0 ? '#ef4444' : '#cbd5e1', fontSize: '16px' }}>{pNeed > 0 ? pNeed : '-'}</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>多買</span>
                          <span style={{ fontWeight: 700, color: pExcess > 0 ? '#f97316' : '#cbd5e1', fontSize: '16px' }}>{pExcess > 0 ? pExcess : '-'}</span>
                        </div>
*/
const singleItemUIBefore = `<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>還缺</span>
                          <span style={{ fontWeight: 700, color: pNeed > 0 ? '#ef4444' : '#cbd5e1', fontSize: '16px' }}>{pNeed > 0 ? pNeed : '-'}</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>多買</span>
                          <span style={{ fontWeight: 700, color: pExcess > 0 ? '#f97316' : '#cbd5e1', fontSize: '16px' }}>{pExcess > 0 ? pExcess : '-'}</span>
                        </div>`;

const singleItemUIAfter = `<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>差異</span>
                          <span style={{ fontWeight: 700, color: pDiff < 0 ? '#ef4444' : pDiff > 0 ? '#22c55e' : '#cbd5e1', fontSize: '16px' }}>{pDiff < 0 ? pDiff : pDiff > 0 ? '+' + pDiff : '0'}</span>
                        </div>`;

code = code.replace(singleItemUIBefore, singleItemUIAfter);

// 5. Group Header logic:
// Before:
// <span>還缺 {pNeed}</span>
// <span>多買 {pExcess}</span>
// After:
// <span>差異 {pDiff < 0 ? pDiff : pDiff > 0 ? '+' + pDiff : '0'}</span>

code = code.replace(/<span>還缺 \{pNeed\}<\/span>\s*<span>多買 \{pExcess\}<\/span>/, '<span>差異 {pDiff < 0 ? pDiff : pDiff > 0 ? \'+\'+pDiff : \'0\'}</span>');


// 6. Table Header logic:
// <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>還缺</th>
// <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>多買</th>
code = code.replace(/<th style=\{\{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 \}\}>還缺<\/th>\s*<th style=\{\{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 \}\}>多買<\/th>/, '<th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>差異</th>');


// 7. Table Row UI
// Inside table rows, it computes:
// const vNeed = Math.max((vMyacgDemand + vWacaDemand + vPrivateDemand) - vTotalPurchased, 0);
// const vExcess = Math.max(vTotalPurchased - (vMyacgDemand + vWacaDemand + vPrivateDemand), 0);
// We replace with:
// const vDiff = vTotalPurchased - (vMyacgDemand + vWacaDemand + vPrivateDemand);

const vMathBefore = `const vNeed = Math.max((vMyacgDemand + vWacaDemand + vPrivateDemand) - vTotalPurchased, 0);
                                const vExcess = Math.max(vTotalPurchased - (vMyacgDemand + vWacaDemand + vPrivateDemand), 0);`;

const vMathAfter = `const vDiff = vTotalPurchased - (vMyacgDemand + vWacaDemand + vPrivateDemand);`;

code = code.replace(vMathBefore, vMathAfter);


// 8. Table Row cells
// <td style={{ padding: '12px', textAlign: 'center', fontWeight: 600, color: vNeed > 0 ? '#ef4444' : '#cbd5e1' }}>{vNeed > 0 ? vNeed : '-'}</td>
// <td style={{ padding: '12px', textAlign: 'center', fontWeight: 600, color: vExcess > 0 ? '#f97316' : '#cbd5e1' }}>{vExcess > 0 ? vExcess : '-'}</td>
const vCellsBefore = `<td style={{ padding: '12px', textAlign: 'center', fontWeight: 600, color: vNeed > 0 ? '#ef4444' : '#cbd5e1' }}>{vNeed > 0 ? vNeed : '-'}</td>
                                  <td style={{ padding: '12px', textAlign: 'center', fontWeight: 600, color: vExcess > 0 ? '#f97316' : '#cbd5e1' }}>{vExcess > 0 ? vExcess : '-'}</td>`;

const vCellsAfter = `<td style={{ padding: '12px', textAlign: 'center', fontWeight: 600, color: vDiff < 0 ? '#ef4444' : vDiff > 0 ? '#22c55e' : '#cbd5e1' }}>{vDiff === 0 ? '0' : vDiff > 0 ? '+'+vDiff : vDiff}</td>`;

code = code.replace(vCellsBefore, vCellsAfter);


// 9. Table Row BG
// let trBg = '#fff';
// if (vNeed > 0) trBg = '#fef2f2';
// else if (vExcess > 0) trBg = '#fff7ed';
const bgBefore = `let trBg = '#fff';
                                if (vNeed > 0) trBg = '#fef2f2';
                                else if (vExcess > 0) trBg = '#fff7ed';`;
const bgAfter = `let trBg = '#fff';
                                if (vDiff < 0) trBg = '#fef2f2';
                                else if (vDiff > 0) trBg = '#f0fdf4';`;
code = code.replace(bgBefore, bgAfter);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('PurchaseManagement diff logic applied.');
