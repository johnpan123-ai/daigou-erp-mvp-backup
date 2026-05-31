const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Insert Component
const helperCode = `
const RenderStatusBadge = ({ demand, purchased, style = {} }: { demand: number, purchased: number, style?: React.CSSProperties }) => {
  if (demand === 0) {
    return <span style={{ backgroundColor: '#f1f5f9', color: '#64748b', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap', ...style }}>無需求</span>;
  }
  if (purchased === 0 && demand > 0) {
    return <span style={{ backgroundColor: '#fee2e2', color: '#ef4444', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap', ...style }}>待採購 {demand}</span>;
  }
  if (purchased < demand) {
    return <span style={{ backgroundColor: '#fee2e2', color: '#ef4444', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap', ...style }}>缺貨 {demand - purchased}</span>;
  }
  if (purchased > demand) {
    return <span style={{ backgroundColor: '#ffedd5', color: '#f97316', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap', ...style }}>多買 {purchased - demand}</span>;
  }
  return <span style={{ backgroundColor: '#dcfce7', color: '#22c55e', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap', ...style }}>完成</span>;
};
`;

code = code.replace("export default function PurchaseManagement() {", helperCode + "\nexport default function PurchaseManagement() {");

// 2. Group Card Title Pills
const old_pills = `{pDiff < 0 && <span style={{ backgroundColor: '#fee2e2', color: '#ef4444', fontWeight: 600, fontSize: '13px', marginLeft: '8px', padding: '2px 8px', borderRadius: '4px' }}>缺貨 {Math.abs(pDiff)}</span>}
                      {pDiff > 0 && <span style={{ backgroundColor: '#ffedd5', color: '#f97316', fontWeight: 600, fontSize: '13px', marginLeft: '8px', padding: '2px 8px', borderRadius: '4px' }}>多買 {pDiff}</span>}
                      {pDiff === 0 && <span style={{ backgroundColor: '#dcfce7', color: '#22c55e', fontWeight: 600, fontSize: '13px', marginLeft: '8px', padding: '2px 8px', borderRadius: '4px' }}>剛好</span>}`;
const new_pills = `<RenderStatusBadge demand={pDemand} purchased={pPurchased} style={{ marginLeft: '8px' }} />`;
code = code.replace(old_pills, new_pills);

// 3. Group Card Summary String
const old_summary = "<span>狀態: {pDiff < 0 ? `缺貨 ${Math.abs(pDiff)}` : pDiff > 0 ? `多買 ${pDiff}` : '剛好'}</span>";
const new_summary = "<RenderStatusBadge demand={pDemand} purchased={pPurchased} />";
code = code.replace(old_summary, new_summary);

// 4. Single Item Layout Change (Add Badge to Title)
const old_single_title = `<div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px' }}>
                          <HighlightText text={title.startsWith('__single__') ? (v.variant_name || group.title) : title} highlight={searchTerm} />
                        </div>`;
const new_single_title = `<div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <HighlightText text={title.startsWith('__single__') ? (v.variant_name || group.title) : title} highlight={searchTerm} />
                          <RenderStatusBadge demand={pDemand} purchased={pPurchased} />
                        </div>`;
code = code.replace(old_single_title, new_single_title);

// 5. Single Item Remove Right Area Badge
const old_single_right_badge = `<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>狀態</span>
                          <span style={{ fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', backgroundColor: pDiff < 0 ? '#fee2e2' : pDiff > 0 ? '#ffedd5' : '#dcfce7', color: pDiff < 0 ? '#ef4444' : pDiff > 0 ? '#f97316' : '#22c55e' }}>{pDiff < 0 ? \`缺貨 \${Math.abs(pDiff)}\` : pDiff > 0 ? \`多買 \${pDiff}\` : '剛好'}</span>
                        </div>
                        <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0' }}></div>`;
code = code.replace(old_single_right_badge, "");

// 6. Table Rows Badge
const old_tds = `<td style={{ padding: '12px', textAlign: 'center' }}>
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

const new_tds = `<td style={{ padding: '12px', textAlign: 'center' }}>
                                  <RenderStatusBadge demand={totalDemand} purchased={totalPurchased} />
                                </td>`;
code = code.replace(old_tds, new_tds);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Status badge component inserted and refactored.");
