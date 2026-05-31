const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Update <th>差異</th> to <th>狀態</th>
code = code.replace(
    "<th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>差異</th>",
    "<th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 }}>狀態</th>"
);

// 2. Update Group Card Title Pills
const old_pills = `{pDiff < 0 && <span style={{ color: '#ef4444', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>總缺貨 {Math.abs(pDiff)} 件</span>}
                      {pDiff > 0 && <span style={{ color: '#22c55e', fontWeight: 600, fontSize: '14px', marginLeft: '8px' }}>多買 {pDiff} 件</span>}`;
const new_pills = `{pDiff < 0 && <span style={{ backgroundColor: '#fee2e2', color: '#ef4444', fontWeight: 600, fontSize: '13px', marginLeft: '8px', padding: '2px 8px', borderRadius: '4px' }}>缺貨 {Math.abs(pDiff)}</span>}
                      {pDiff > 0 && <span style={{ backgroundColor: '#ffedd5', color: '#f97316', fontWeight: 600, fontSize: '13px', marginLeft: '8px', padding: '2px 8px', borderRadius: '4px' }}>多買 {pDiff}</span>}
                      {pDiff === 0 && <span style={{ backgroundColor: '#dcfce7', color: '#22c55e', fontWeight: 600, fontSize: '13px', marginLeft: '8px', padding: '2px 8px', borderRadius: '4px' }}>剛好</span>}`;
code = code.replace(old_pills, new_pills);

// 3. Update Group Card Summary String
const old_summary = "<span>差異 {pDiff === 0 ? '0' : pDiff > 0 ? '+' + pDiff : pDiff}</span>";
const new_summary = "<span>狀態: {pDiff < 0 ? `缺貨 ${Math.abs(pDiff)}` : pDiff > 0 ? `多買 ${pDiff}` : '剛好'}</span>";
code = code.replace(old_summary, new_summary);

// 4. Update Single Item `差異` column
const old_single_title = "<span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>差異</span>";
const new_single_title = "<span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>狀態</span>";
code = code.replace(old_single_title, new_single_title);

const old_single_val = "<span style={{ fontWeight: 700, color: pDiff < 0 ? '#ef4444' : pDiff > 0 ? '#22c55e' : '#cbd5e1', fontSize: '16px' }}>{pDiff === 0 ? '0' : pDiff > 0 ? '+' + pDiff : pDiff}</span>";
const new_single_val = `<span style={{ fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', backgroundColor: pDiff < 0 ? '#fee2e2' : pDiff > 0 ? '#ffedd5' : '#dcfce7', color: pDiff < 0 ? '#ef4444' : pDiff > 0 ? '#f97316' : '#22c55e' }}>{pDiff < 0 ? \`缺貨 \${Math.abs(pDiff)}\` : pDiff > 0 ? \`多買 \${pDiff}\` : '剛好'}</span>`;
code = code.replace(old_single_val, new_single_val);


// 5. Fix Table Row (combining the two TDs into one status TD)
const old_tds = `                                <td style={{ padding: '12px', textAlign: 'center', fontWeight: needToBuy > 0 ? 600 : 400, color: needToBuy > 0 ? '#ef4444' : '#cbd5e1' }}>
                                  {needToBuy > 0 ? needToBuy : '-'}
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center', fontWeight: excessBuy > 0 ? 600 : 400, color: excessBuy > 0 ? '#f97316' : '#cbd5e1' }}>
                                  {excessBuy > 0 ? excessBuy : '-'}
                                </td>`;

const new_tds = `                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  {(() => {
                                    const diff = totalPurchased - totalDemand;
                                    const bgColor = diff < 0 ? '#fee2e2' : diff > 0 ? '#ffedd5' : '#dcfce7';
                                    const textColor = diff < 0 ? '#ef4444' : diff > 0 ? '#f97316' : '#22c55e';
                                    const text = diff < 0 ? \`缺貨 \${Math.abs(diff)}\` : diff > 0 ? \`多買 \${diff}\` : '剛好';
                                    return (
                                      <span style={{ backgroundColor: bgColor, color: textColor, fontWeight: 600, fontSize: '12px', padding: '4px 8px', borderRadius: '12px', whiteSpace: 'nowrap' }}>
                                        {text}
                                      </span>
                                    );
                                  })()}
                                </td>`;
code = code.replace(old_tds, new_tds);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Status unified via Node");
