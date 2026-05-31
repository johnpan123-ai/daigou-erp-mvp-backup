const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Update the Header Button Text
const old_header_btns = `              isEditMode ? (
                <>
                  <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff', color: '#64748b', borderColor: '#cbd5e1' }}>
                    <X size={16} />
                    取消
                  </button>
                  <button className="btn btn-primary" onClick={handleSaveEdits} style={{ backgroundColor: '#2563eb' }}>
                    <CheckSquare size={16} />
                    儲存修改
                  </button>
                </>
              ) : (
                <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff', borderColor: '#cbd5e1', color: '#334155' }}>
                  <Edit2 size={16} />
                  編輯數量
                </button>
              )`;

const new_header_btns = `              isEditMode ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ color: '#d97706', fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    🔓 編輯模式
                  </span>
                  <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff', color: '#64748b', borderColor: '#cbd5e1' }}>
                    <X size={16} />
                    取消
                  </button>
                  <button className="btn btn-primary" onClick={handleSaveEdits} style={{ backgroundColor: '#2563eb' }}>
                    <CheckSquare size={16} />
                    儲存修改
                  </button>
                </div>
              ) : (
                <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff', borderColor: '#cbd5e1', color: '#334155' }}>
                  🔒 鎖定中
                </button>
              )`;

code = code.replace(old_header_btns, new_header_btns);


// 2. Refactor Render Component Structure
// First, insert a reusable SkuRow function right below RenderStatusBadge
const skuRowFunc = `
const RenderSkuRow = ({ v, inv, title, searchTerm, isSingle, isEditMode, editDrafts, handleDraftChange, privateOrderItems, purchaseBatchItems, group }) => {
  const price = inv ? inv.final_price : 0;
  
  const myacgDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
  const wacaDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
  const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
  const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0) + (v.private_manual_adjustment || 0);
  const totalDemand = myacgDemand + wacaDemand + privateDemand;

  const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
  const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0) + (v.purchased_manual_adjustment || 0);
  
  const draft = editDrafts[v.id];

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isSingle ? '16px 20px' : '12px 20px', borderBottom: isSingle ? 'none' : '1px solid #f1f5f9', backgroundColor: isEditMode ? '#fef9c3' : 'transparent' }}>
      
      {/* Left Info Area */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
        <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <HighlightText text={isSingle && title.startsWith('__single__') ? (v.variant_name || group.title) : v.variant_name} highlight={searchTerm} />
          <RenderStatusBadge demand={totalDemand} purchased={totalPurchased} />
        </div>
        
        <div style={{ fontSize: '12px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span>SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} /></span>
          <span>|</span>
          <span>單價: ¥{price}</span>
          {v.catalog_missing && <span style={{ padding: '2px 6px', backgroundColor: '#fee2e2', color: '#ef4444', borderRadius: '4px', fontSize: '11px', fontWeight: 600 }}>商品主檔缺失</span>}
        </div>
      </div>

      {/* Right Quantities Area */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '24px', fontSize: '13px', minWidth: '320px', justifyContent: 'flex-end' }}>
        
        {/* MyACG */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '60px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>買動漫</span>}
          {isEditMode ? (
            <input 
              type="number" min="0"
              style={{ width: '100%', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} 
              value={draft?.m ?? myacgDemand}
              onChange={e => handleDraftChange(v.id, 'm', parseInt(e.target.value))}
            />
          ) : (
            <span style={{ fontWeight: 600, color: myacgDemand > 0 ? '#334155' : '#94a3b8' }}>{myacgDemand > 0 ? myacgDemand : '-'}</span>
          )}
        </div>

        {/* WACA */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '60px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>WACA</span>}
          {isEditMode ? (
            <input 
              type="number" min="0"
              style={{ width: '100%', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} 
              value={draft?.w ?? wacaDemand}
              onChange={e => handleDraftChange(v.id, 'w', parseInt(e.target.value))}
            />
          ) : (
            <span style={{ fontWeight: 600, color: wacaDemand > 0 ? '#334155' : '#94a3b8' }}>{wacaDemand > 0 ? wacaDemand : '-'}</span>
          )}
        </div>

        {/* Private */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '60px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>私下</span>}
          {isEditMode ? (
            <input 
              type="number" min="0"
              style={{ width: '100%', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} 
              value={draft?.p ?? privateDemand}
              onChange={e => handleDraftChange(v.id, 'p', parseInt(e.target.value))}
            />
          ) : (
            <span style={{ fontWeight: 600, color: privateDemand > 0 ? '#db2777' : '#94a3b8', backgroundColor: privateDemand > 0 && !isSingle ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>{privateDemand > 0 ? privateDemand : '-'}</span>
          )}
        </div>

        {/* Purchased */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '60px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>已採購</span>}
          {isEditMode ? (
            <input 
              type="number" min="0"
              style={{ width: '100%', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} 
              value={draft?.pu ?? totalPurchased}
              onChange={e => handleDraftChange(v.id, 'pu', parseInt(e.target.value))}
            />
          ) : (
            <span style={{ fontWeight: 600, color: totalPurchased > 0 ? '#2563eb' : '#94a3b8' }}>{totalPurchased > 0 ? totalPurchased : '-'}</span>
          )}
        </div>
      </div>
    </div>
  );
};
`;

code = code.replace("export default function PurchaseManagement() {", skuRowFunc + "\nexport default function PurchaseManagement() {");


// 3. Replace Single Item Rendering logic
const old_single = `// SINGLE ITEM RENDERING
              if (groupItems.length === 1) {
                const v = groupItems[0];
                const inv = inventoryMap.get(v.myacg_item_code);
                const price = inv ? inv.final_price : 0;
                
                return (
                  <div key={v.id} className="card shadow-sm rounded-lg overflow-hidden bg-white" style={{ borderTop: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderLeft: \`4px solid \${borderColor}\` }}>
                    <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <HighlightText text={title.startsWith('__single__') ? (v.variant_name || group.title) : title} highlight={searchTerm} />
                          <RenderStatusBadge demand={pDemand} purchased={pPurchased} />
                        </div>
                        
                        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                          SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} /> | 單價: ¥{price}
                          {v.catalog_missing && <span style={{ marginLeft: '8px', padding: '2px 6px', backgroundColor: '#fee2e2', color: '#ef4444', borderRadius: '4px', fontSize: '11px', fontWeight: 600 }}>商品主檔缺失</span>}
                        </div>

                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '24px', fontSize: '13px' }}>
                        
                        
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '60px' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>買動漫</span>
                          <input 
                            type="number" 
                            style={{ width: '100%', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                            value={pMyacg || ''}
                            placeholder="0"
                            onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                          />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '60px' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>WACA</span>
                          <input 
                            type="number" 
                            style={{ width: '100%', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                            value={pWaca || ''}
                            placeholder="0"
                            onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                          />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>私下</span>
                          <span style={{ fontWeight: 600, color: pManual > 0 ? '#db2777' : '#94a3b8', backgroundColor: pManual > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>{pManual}</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '4px' }}>已採購</span>
                          <span style={{ fontWeight: 600, color: pPurchased > 0 ? '#2563eb' : '#94a3b8' }}>{pPurchased}</span>
                        </div>
                      </div>

                    </div>
                  </div>
                );
              }`;

const new_single = `// SINGLE ITEM RENDERING
              if (groupItems.length === 1) {
                const v = groupItems[0];
                return (
                  <div key={v.id} className="card shadow-sm rounded-lg overflow-hidden bg-white" style={{ borderTop: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderLeft: \`4px solid \${borderColor}\` }}>
                    <RenderSkuRow v={v} inv={inventoryMap.get(v.myacg_item_code)} title={title} searchTerm={searchTerm} isSingle={true} isEditMode={isEditMode} editDrafts={editDrafts} handleDraftChange={handleDraftChange} privateOrderItems={privateOrderItems} purchaseBatchItems={purchaseBatchItems} group={group} />
                  </div>
                );
              }`;

code = code.replace(old_single, new_single);

// 4. Replace Group Table Rendering with unified div layout
// We need to find the whole Expanded SKU Table block and replace it.
const searchStart = "{/* Expanded SKU Table */}";
const searchEnd = "</tbody>\n                      </table>\n                    </div>\n                  )}\n                </div>\n              );";
const startIdx = code.indexOf(searchStart);
const endIdx = code.indexOf(searchEnd) + searchEnd.length;

if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
  const newTable = `{/* Expanded SKU List */}
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid #f1f5f9' }}>
                      {/* Table Header Row (matches Right Quantities Area alignment) */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 20px', backgroundColor: '#fafafa', color: '#64748b', fontSize: '12px', fontWeight: 500 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '24px', width: '320px', justifyContent: 'flex-end' }}>
                          <div style={{ width: '60px', textAlign: 'center' }}>買動漫</div>
                          <div style={{ width: '60px', textAlign: 'center' }}>WACA</div>
                          <div style={{ width: '60px', textAlign: 'center' }}>私下登記</div>
                          <div style={{ width: '60px', textAlign: 'center' }}>已採購</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {groupItems.map((v) => (
                          <RenderSkuRow key={v.id} v={v} inv={inventoryMap.get(v.myacg_item_code)} title={title} searchTerm={searchTerm} isSingle={false} isEditMode={isEditMode} editDrafts={editDrafts} handleDraftChange={handleDraftChange} privateOrderItems={privateOrderItems} purchaseBatchItems={purchaseBatchItems} group={group} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );`;
  code = code.substring(0, startIdx) + newTable + code.substring(endIdx);
}

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("SKU Layout unified.");
