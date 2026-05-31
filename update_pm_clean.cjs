const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Sort logic
const oldSort = `      const getShortage = (items: ProductVariant[]) => items.reduce((sum, v) => {
        const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
        const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
        const privateDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        return sum + Math.max((myacgDemand + wacaDemand + privateDemand) - totalPurchased, 0);
      }, 0);
      return getShortage(itemsB) - getShortage(itemsA);`;

const newSort = `      const getDiff = (items: ProductVariant[]) => items.reduce((sum, v) => {
        const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
        const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
        const privateDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        return sum + (totalPurchased - (myacgDemand + wacaDemand + privateDemand));
      }, 0);
      return getDiff(itemsA) - getDiff(itemsB);`;
code = code.replace(oldSort, newSort);

// 2. Variables computation
const oldVars = "let pMyacg = 0, pWaca = 0, pManual = 0, pNeed = 0, pExcess = 0, pPurchased = 0, pDemand = 0;";
const newVars = "let pMyacg = 0, pWaca = 0, pManual = 0, pDiff = 0, pPurchased = 0, pDemand = 0;";
code = code.replace(oldVars, newVars);

const oldNeedCalc = "pNeed += Math.max(tDemand - tPurchased, 0);";
const newNeedCalc = "pDiff += (tPurchased - tDemand);";
code = code.replace(new RegExp(oldNeedCalc.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'g'), newNeedCalc);

const oldExcessCalc = "pExcess += Math.max(tPurchased - tDemand, 0);";
code = code.replace(new RegExp(oldExcessCalc.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'g'), "");

// 3. Border Color
const oldBorder = `let borderColor = "#cbd5e1";
              if (pNeed > 0) borderColor = "#ef4444";
              else if (pExcess > 0) borderColor = "#f97316";`;
const newBorder = `let borderColor = "#cbd5e1";
              if (pDiff < 0) borderColor = "#ef4444";
              else if (pDiff > 0) borderColor = "#22c55e";`;
code = code.replace(oldBorder, newBorder);

// 4. Single item UI
const oldSingleUI = `<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>還缺</span>
                          <span style={{ fontWeight: 700, color: pNeed > 0 ? '#ef4444' : '#cbd5e1', fontSize: '16px' }}>{pNeed > 0 ? pNeed : '-'}</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>多買</span>
                          <span style={{ fontWeight: 700, color: pExcess > 0 ? '#f97316' : '#cbd5e1', fontSize: '16px' }}>{pExcess > 0 ? pExcess : '-'}</span>
                        </div>`;
const newSingleUI = `<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>差異</span>
                          <span style={{ fontWeight: 700, color: pDiff < 0 ? '#ef4444' : pDiff > 0 ? '#22c55e' : '#cbd5e1', fontSize: '16px' }}>{pDiff === 0 ? '0' : pDiff > 0 ? '+' + pDiff : pDiff}</span>
                        </div>`;
code = code.replace(oldSingleUI, newSingleUI);

// 5. Group Header
const oldGroupHeader = `<span>還缺 {pNeed}</span>
                      <span>多買 {pExcess}</span>`;
const newGroupHeader = `<span>差異 {pDiff === 0 ? '0' : pDiff > 0 ? '+' + pDiff : pDiff}</span>`;
code = code.replace(oldGroupHeader, newGroupHeader);

// 6. Table Header
const oldTableHeader = `<th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>還缺</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>多買</th>`;
const newTableHeader = `<th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>差異</th>`;
code = code.replace(oldTableHeader, newTableHeader);

// 7. Table Row Math
const oldRowMath = `const vNeed = Math.max((vMyacgDemand + vWacaDemand + vPrivateDemand) - vTotalPurchased, 0);
                                const vExcess = Math.max(vTotalPurchased - (vMyacgDemand + vWacaDemand + vPrivateDemand), 0);`;
const newRowMath = `const vDiff = vTotalPurchased - (vMyacgDemand + vWacaDemand + vPrivateDemand);`;
code = code.replace(oldRowMath, newRowMath);

// 8. Table Row Cells
const oldRowCells = `<td style={{ padding: '12px', textAlign: 'center', fontWeight: 600, color: vNeed > 0 ? '#ef4444' : '#cbd5e1' }}>{vNeed > 0 ? vNeed : '-'}</td>
                                  <td style={{ padding: '12px', textAlign: 'center', fontWeight: 600, color: vExcess > 0 ? '#f97316' : '#cbd5e1' }}>{vExcess > 0 ? vExcess : '-'}</td>`;
const newRowCells = `<td style={{ padding: '12px', textAlign: 'center', fontWeight: 600, color: vDiff < 0 ? '#ef4444' : vDiff > 0 ? '#22c55e' : '#cbd5e1' }}>{vDiff === 0 ? '0' : vDiff > 0 ? '+' + vDiff : vDiff}</td>`;
code = code.replace(oldRowCells, newRowCells);

// 9. Table Row BG
const oldRowBg = `let trBg = '#fff';
                                if (vNeed > 0) trBg = '#fef2f2';
                                else if (vExcess > 0) trBg = '#fff7ed';`;
const newRowBg = `let trBg = '#fff';
                                if (vDiff < 0) trBg = '#fef2f2';
                                else if (vDiff > 0) trBg = '#f0fdf4';`;
code = code.replace(oldRowBg, newRowBg);

// 10. Update dropdown option text
code = code.replace('<option value="shortage">缺貨最多</option>', '<option value="shortage">缺貨最多</option>');

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Done!');
