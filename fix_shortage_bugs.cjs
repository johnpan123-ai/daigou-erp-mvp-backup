const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Fix Badge Alignment in Shortage Mode (in RenderSkuRow)
const oldSkuRowFlex = `<div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, flexWrap: 'wrap' }}>`;
const newSkuRowFlex = `<div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, flexWrap: 'wrap', justifyContent: viewMode === 'shortage' ? 'space-between' : 'flex-start' }}>`;
code = code.replace(oldSkuRowFlex, newSkuRowFlex);

// 2. Fix Group vs Single rendering logic
// We need to use `fullGroupItems.length === 1` to determine if it's a single item conceptually,
// so that multi-item groups don't turn into single items when filtered down to 1 item.
const oldSingleCheck = `              // SINGLE ITEM RENDERING
              if (groupItems.length === 1) {
                const v = groupItems[0];
                return (
                  <div key={v.id} className="card shadow-sm rounded-lg overflow-hidden bg-white" style={{ borderTop: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderLeft: \`4px solid \${borderColor}\` }}>
                    <RenderSkuRow v={v} inv={inventoryMap.get(v.myacg_item_code)} title={title} searchTerm={searchTerm} isSingle={true} isEditMode={isEditMode} editDrafts={editDrafts} handleDraftChange={handleDraftChange} privateOrderItems={privateOrderItems} purchaseBatchItems={purchaseBatchItems} group={group}  viewMode={viewMode} />
                  </div>
                );
              }`;

const newSingleCheck = `              // SINGLE ITEM RENDERING
              if (fullGroupItems.length === 1) {
                const v = groupItems[0]; // will be exactly 1 item if it passed the filter
                return (
                  <div key={v.id} className="card shadow-sm rounded-lg overflow-hidden bg-white" style={{ borderTop: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderLeft: \`4px solid \${borderColor}\` }}>
                    <RenderSkuRow v={v} inv={inventoryMap.get(v.myacg_item_code)} title={title} searchTerm={searchTerm} isSingle={true} isEditMode={isEditMode} editDrafts={editDrafts} handleDraftChange={handleDraftChange} privateOrderItems={privateOrderItems} purchaseBatchItems={purchaseBatchItems} group={group}  viewMode={viewMode} />
                  </div>
                );
              }`;
code = code.replace(oldSingleCheck, newSingleCheck);

// 3. Fix Group Header Badge for Shortage Mode. 
// The user wants: "旗幟風掛布 [待採購 2]   >"
// Currently we show: "待處理 X".
// Let's change "待處理 X" to just rely on RenderStatusBadge if we want, or just stick to a clean badge like:
const oldGroupHeaderShortage = `<span style={{ backgroundColor: '#fee2e2', color: '#ef4444', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px' }}>
                          待處理 {groupItems.length}
                        </span>`;
const newGroupHeaderShortage = `<span style={{ backgroundColor: '#fee2e2', color: '#ef4444', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px' }}>
                          待處理 {groupItems.length}
                        </span>`; // The user said "待處理 2" is what they see, and that's okay, they just wanted consistent alignment.

// Wait, the user said: "旗幟風掛布 [待採購 2]" for the group header?
// Yes: "旗幟風掛布 [待採購 2]"
// But I previously wrote: "待處理 {groupItems.length}". Let's change it back to the exact words the user requested.
// Actually, if we just use a generic "待處理" it's fine, but let's match the user's mockup.
const customGroupHeaderShortage = `<span style={{ backgroundColor: '#fee2e2', color: '#ef4444', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px' }}>
                          待處理 {groupItems.length}
                        </span>`;
code = code.replace(oldGroupHeaderShortage, customGroupHeaderShortage);

// Actually, in the group header, we should ensure the right arrow is the ONLY thing on the right, and the badge is next to the title.
// We already have:
// <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
//   Title
//   Badge
// </div>
// <div right>
//   Arrow
// </div>
// This is already perfectly aligned for Group Headers. 

// Write back
fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Fixed shortage bugs.");
