const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Refactor Shortage Mode (Shopping List)
// We replace the entire Shortage Mode rendering block.
const oldShortageBlockStart = `              // SHORTAGE MODE RENDERING (Shopping List)
              if (viewMode === 'shortage') {`;
const oldShortageBlockEnd = `              // Decide Border Color`;

const startIdx = code.indexOf(oldShortageBlockStart);
const endIdx = code.indexOf(oldShortageBlockEnd);

if (startIdx !== -1 && endIdx !== -1) {
  const newShortageBlock = `              // SHORTAGE MODE RENDERING (Shopping List)
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
                    <div key={v.id} style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ fontWeight: 700, color: '#1e293b', fontSize: '16px' }}>
                          <HighlightText text={v.variant_name || group.title} highlight={searchTerm} />
                        </div>
                        {diff < 0 && <span style={{ color: '#ef4444', fontWeight: 700, fontSize: '15px' }}>待採購 {Math.abs(diff)}</span>}
                        {diff > 0 && <span style={{ color: '#f97316', fontWeight: 600, fontSize: '14px' }}>多買 {diff}</span>}
                      </div>
                    </div>
                  );
                }

                // Group Mode
                return (
                  <div key={title} style={{ backgroundColor: '#fff', borderBottom: '1px solid #e2e8f0', padding: '12px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div style={{ fontWeight: 700, color: '#1e293b', fontSize: '16px' }}>
                        <HighlightText text={title} highlight={searchTerm} />
                      </div>
                      {pDiff < 0 && <span style={{ color: '#ef4444', fontWeight: 700, fontSize: '15px' }}>
                        待採購 {Math.abs(pDiff)}
                      </span>}
                      {pDiff > 0 && <span style={{ color: '#f97316', fontWeight: 600, fontSize: '14px' }}>
                        多買 {pDiff}
                      </span>}
                    </div>

                    <div style={{ paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {groupItems.map(v => {
                        const mDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                        const wDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                        const pDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.private_manual_adjustment || 0);
                        const totalDemand = mDemand + wDemand + pDemand;
                        const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.purchased_manual_adjustment || 0);
                        const diff = totalPurchased - totalDemand;

                        return (
                          <div key={v.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ color: '#334155', fontSize: '15px', fontWeight: 500 }}>
                              <HighlightText text={v.variant_name} highlight={searchTerm} /> {diff < 0 ? \`×\${Math.abs(diff)}\` : ''}
                            </div>
                            {diff > 0 && <span style={{ color: '#f97316', fontWeight: 600, fontSize: '13px' }}>多買 {diff}</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              // Decide Border Color`;

  code = code.substring(0, startIdx) + newShortageBlock + code.substring(endIdx);
} else {
  console.log("Could not replace shortage mode");
}

// 2. Standardize Wording in Badges and Text
// Check RenderStatusBadge
code = code.replaceAll('待處理', '待採購');
code = code.replaceAll('完成', '已完成');
// But be careful not to replace things like `isEditMode ? '已完成' : '...'` unnecessarily if they mean something else, 
// but "完成" to "已完成" in RenderStatusBadge is safe.

// Let's specifically target RenderStatusBadge for "已完成"
code = code.replace(
  `return <span style={{ backgroundColor: '#dcfce7', color: '#22c55e', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap', ...style }}>完成</span>;`,
  `return <span style={{ backgroundColor: '#dcfce7', color: '#22c55e', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px', whiteSpace: 'nowrap', ...style }}>已完成</span>;`
);

// We should also replace the wording in the group header badge in standard mode
code = code.replaceAll('待採購 {Math.abs(pDiff)}件', '待採購 {Math.abs(pDiff)}');
code = code.replaceAll('待採購 {groupItems.length}', '待採購 {groupItems.length}');

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Shortage Mode redesigned and wording standardized.');
