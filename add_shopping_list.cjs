const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Force sort by shortage if viewMode === 'shortage'
const oldSortCheck = `  if (sortMode === 'shortage') {`;
const newSortCheck = `  if (sortMode === 'shortage' || viewMode === 'shortage') {`;
code = code.replace(oldSortCheck, newSortCheck);

// 2. Inject Shopping List Rendering
const searchStart = `              // Decide Border Color`;
const searchEnd = `              // CATEGORY CARD RENDERING`;

const startIdx = code.indexOf(searchStart);
const endIdx = code.indexOf(searchEnd);

if (startIdx !== -1 && endIdx !== -1) {
  const customRender = `              // SHORTAGE MODE RENDERING (Shopping List)
              if (viewMode === 'shortage') {
                if (fullGroupItems.length === 1) {
                  const v = groupItems[0];
                  const mDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                  const wDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                  const pDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.private_manual_adjustment || 0);
                  const totalDemand = mDemand + wDemand + pDemand;
                  const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.purchased_manual_adjustment || 0);
                  const diff = totalPurchased - totalDemand;

                  return (
                    <div key={v.id} style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
                      <div style={{ fontWeight: 600, color: '#0f172a', fontSize: '15px' }}>
                        <HighlightText text={v.variant_name || group.title} highlight={searchTerm} /> {diff < 0 ? \`× \${Math.abs(diff)}\` : ''}
                      </div>
                      {diff > 0 && <span style={{ backgroundColor: '#ffedd5', color: '#f97316', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', marginLeft: '12px' }}>多買 {diff}</span>}
                    </div>
                  );
                }

                return (
                  <div key={title} style={{ backgroundColor: '#fff', borderBottom: '1px solid #e2e8f0' }}>
                    <div 
                      style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', backgroundColor: '#f8fafc' }}
                      onClick={() => toggleManualGroup(title)}
                    >
                      <div style={{ fontWeight: 600, color: '#334155', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        <HighlightText text={title} highlight={searchTerm} />
                      </div>
                      <span style={{ backgroundColor: '#fee2e2', color: '#ef4444', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px' }}>
                        待處理 {groupItems.length}
                      </span>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: '8px 0' }}>
                        {groupItems.map(v => {
                          const mDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                          const wDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                          const pDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.private_manual_adjustment || 0);
                          const totalDemand = mDemand + wDemand + pDemand;
                          const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.purchased_manual_adjustment || 0);
                          const diff = totalPurchased - totalDemand;

                          return (
                            <div key={v.id} style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', paddingLeft: '40px' }}>
                              <div style={{ color: '#1e293b', fontSize: '14px', fontWeight: 500 }}>
                                <HighlightText text={v.variant_name} highlight={searchTerm} /> {diff < 0 ? \`× \${Math.abs(diff)}\` : ''}
                              </div>
                              {diff > 0 && <span style={{ backgroundColor: '#ffedd5', color: '#f97316', fontWeight: 600, fontSize: '12px', padding: '2px 6px', borderRadius: '4px', marginLeft: '12px' }}>多買 {diff}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              // Decide Border Color`;

  code = code.substring(0, startIdx) + customRender + code.substring(startIdx);
  
  // Wait, I also need to remove the wrapper around the whole Card List Area which currently sets `gap: '16px'`.
  // Wait! `gap: '16px'` adds space between every item. In a list view, we usually want `borderBottom` and `gap: 0`.
  // If I can't easily change `gap: '16px'` to `gap: viewMode === 'shortage' ? 0 : '16px'`, then my items will have 16px gaps.
  // Let's replace `<div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, paddingBottom: '40px' }}>`
  // with `<div style={{ display: 'flex', flexDirection: 'column', gap: viewMode === 'shortage' ? 0 : '16px', flex: 1, paddingBottom: '40px' }}>`
}

const oldListWrapper = `<div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, paddingBottom: '40px' }}>`;
const newListWrapper = `<div style={{ display: 'flex', flexDirection: 'column', gap: viewMode === 'shortage' ? 0 : '16px', flex: 1, paddingBottom: '40px' }}>`;
code = code.replace(oldListWrapper, newListWrapper);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Shortage mode upgraded to List format.");
