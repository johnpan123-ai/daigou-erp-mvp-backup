const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Rename filterMode to viewMode
code = code.replace("const [filterMode, setFilterMode] = useState<'all' | 'abnormal'>('all');", 
                    "const [viewMode, setViewMode] = useState<'standard' | 'shortage'>('standard');");

// 2. Add View Mode Toggle to the top right tool bar
const searchBarHtml = `<div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: '6px', border: '1px solid #cbd5e1', padding: '0 12px', height: '36px', width: '240px' }}>`;
const newSearchBarHtml = `<div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: '6px', padding: '4px', gap: '4px' }}>
                <button 
                  className="btn" 
                  style={{ fontSize: '13px', padding: '6px 12px', backgroundColor: viewMode === 'standard' ? '#fff' : 'transparent', color: viewMode === 'standard' ? '#0f172a' : '#64748b', boxShadow: viewMode === 'standard' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', border: 'none', borderRadius: '4px', fontWeight: viewMode === 'standard' ? 600 : 500 }} 
                  onClick={() => setViewMode('standard')}
                >顯示全部商品</button>
                <button 
                  className="btn" 
                  style={{ fontSize: '13px', padding: '6px 12px', backgroundColor: viewMode === 'shortage' ? '#fff' : 'transparent', color: viewMode === 'shortage' ? '#ef4444' : '#64748b', boxShadow: viewMode === 'shortage' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', border: 'none', borderRadius: '4px', fontWeight: viewMode === 'shortage' ? 600 : 500 }} 
                  onClick={() => {
                    setViewMode('shortage');
                    if (isEditMode) handleEditModeToggle();
                  }}
                >缺貨模式</button>
              </div>\n              ` + searchBarHtml;
code = code.replace(searchBarHtml, newSearchBarHtml);


// 3. Edit mode protection
const editModeToggle = `const handleEditModeToggle = () => {`;
const editModeProtection = `const handleEditModeToggle = () => {
    if (viewMode === 'shortage') {
      alert("缺貨模式僅供查看，請切回顯示全部商品編輯數量");
      return;
    }`;
code = code.replace(editModeToggle, editModeProtection);

// 4. Update RenderSkuRow signature and body
const oldRenderSkuRowStart = `const RenderSkuRow = ({ v, inv, title, searchTerm, isSingle, isEditMode, editDrafts, handleDraftChange, privateOrderItems, purchaseBatchItems, group }: {`;
const newRenderSkuRowStart = `const RenderSkuRow = ({ v, inv, title, searchTerm, isSingle, isEditMode, editDrafts, handleDraftChange, privateOrderItems, purchaseBatchItems, group, viewMode }: {`;
code = code.replace(oldRenderSkuRowStart, newRenderSkuRowStart);

const oldRenderSkuRowProps = `  group: ProductGroup\n}) => {`;
const newRenderSkuRowProps = `  group: ProductGroup,\n  viewMode: 'standard' | 'shortage'\n}) => {`;
code = code.replace(oldRenderSkuRowProps, newRenderSkuRowProps);

const oldRenderSkuRowReturn = `  return (
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
  );`;

const newRenderSkuRowReturn = `  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: isSingle ? 'none' : '1px solid #f1f5f9', backgroundColor: isEditMode ? '#fef9c3' : 'transparent' }}>
      
      {/* Left Info Area */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '14px', minWidth: '150px' }}>
          <HighlightText text={isSingle && title.startsWith('__single__') ? (v.variant_name || group.title) : v.variant_name} highlight={searchTerm} />
        </div>
        
        {viewMode === 'standard' && (
          <>
            <div style={{ fontSize: '12px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '8px', minWidth: '150px' }}>
              <span>SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} /></span>
              {v.catalog_missing && <span style={{ padding: '2px 6px', backgroundColor: '#fee2e2', color: '#ef4444', borderRadius: '4px', fontSize: '11px', fontWeight: 600 }}>缺失</span>}
            </div>
            <div style={{ fontSize: '13px', color: '#475569', minWidth: '60px' }}>¥{price}</div>
          </>
        )}
        
        <RenderStatusBadge demand={totalDemand} purchased={totalPurchased} />
      </div>

      {/* Right Quantities Area */}
      {viewMode === 'standard' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', fontSize: '13px', minWidth: '280px', justifyContent: 'flex-end' }}>
          
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '50px' }}>
            {isSingle && <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '2px' }}>買動漫</span>}
            {isEditMode ? (
              <input type="number" min="0" style={{ width: '100%', height: '26px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.m ?? myacgDemand} onChange={e => handleDraftChange(v.id, 'm', parseInt(e.target.value))} />
            ) : (
              <span style={{ fontWeight: 600, color: myacgDemand > 0 ? '#334155' : '#94a3b8' }}>{myacgDemand > 0 ? myacgDemand : '-'}</span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '50px' }}>
            {isSingle && <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '2px' }}>WACA</span>}
            {isEditMode ? (
              <input type="number" min="0" style={{ width: '100%', height: '26px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.w ?? wacaDemand} onChange={e => handleDraftChange(v.id, 'w', parseInt(e.target.value))} />
            ) : (
              <span style={{ fontWeight: 600, color: wacaDemand > 0 ? '#334155' : '#94a3b8' }}>{wacaDemand > 0 ? wacaDemand : '-'}</span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '50px' }}>
            {isSingle && <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '2px' }}>私下</span>}
            {isEditMode ? (
              <input type="number" min="0" style={{ width: '100%', height: '26px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.p ?? privateDemand} onChange={e => handleDraftChange(v.id, 'p', parseInt(e.target.value))} />
            ) : (
              <span style={{ fontWeight: 600, color: privateDemand > 0 ? '#db2777' : '#94a3b8', backgroundColor: privateDemand > 0 && !isSingle ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>{privateDemand > 0 ? privateDemand : '-'}</span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '50px' }}>
            {isSingle && <span style={{ color: '#64748b', fontSize: '11px', marginBottom: '2px' }}>已採購</span>}
            {isEditMode ? (
              <input type="number" min="0" style={{ width: '100%', height: '26px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.pu ?? totalPurchased} onChange={e => handleDraftChange(v.id, 'pu', parseInt(e.target.value))} />
            ) : (
              <span style={{ fontWeight: 600, color: totalPurchased > 0 ? '#2563eb' : '#94a3b8' }}>{totalPurchased > 0 ? totalPurchased : '-'}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );`;

code = code.replace(oldRenderSkuRowReturn, newRenderSkuRowReturn);

// 5. Update the filter loop for viewMode
const oldFilter = `              // 2. Abnormal Filter
              if (filterMode === 'abnormal') {
                let hasAbnormal = false;
                for (const v of groupItems) {
                  const m = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                  const w = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                  const p = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
                  const d = m + w + p;
                  const pb = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
                  if (Math.max(d - pb, 0) > 0 || Math.max(pb - d, 0) > 0) {
                    hasAbnormal = true;
                    break;
                  }
                }
                if (!hasAbnormal) return false;
              }`;

// Let's rewrite the iteration logic inside `sortedGroupEntries.filter...map`. 
// Because we need to map over `filteredItems` instead of `groupItems`.
// Let's replace the whole block from `.filter(` to `.map(`

const startFilterMapIdx = code.indexOf(`{sortedGroupEntries.filter(([title, groupItems]) => {`);
const endFilterMapIdx = code.indexOf(`// Compute Group Aggregates`, startFilterMapIdx);

if (startFilterMapIdx !== -1 && endFilterMapIdx !== -1) {
  const replacement = `{sortedGroupEntries.map(([title, fullGroupItems]) => {
              // Pre-filter items for Shortage Mode
              let groupItems = fullGroupItems;
              if (viewMode === 'shortage') {
                groupItems = fullGroupItems.filter(v => {
                  const mDemand = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                  const wDemand = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                  const pDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.private_manual_adjustment || 0);
                  const tDemand = mDemand + wDemand + pDemand;
                  const tPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.purchased_manual_adjustment || 0);
                  return (tPurchased - tDemand) !== 0; // Only short or excess
                });
                
                // Sort shortages first
                groupItems.sort((a, b) => {
                  const getDiff = (v: ProductVariant) => {
                    const md = (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0);
                    const wd = (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0);
                    const pd = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.private_manual_adjustment || 0);
                    const td = md + wd + pd;
                    const tp = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.purchased_manual_adjustment || 0);
                    return tp - td;
                  };
                  return getDiff(a) - getDiff(b);
                });
              }

              // 1. Search Filter
              if (searchTerm) {
                const lowerSearch = searchTerm.toLowerCase();
                const groupMatch = title.toLowerCase().includes(lowerSearch);
                const hasMatch = groupItems.some(v => 
                  (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                  (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                );
                if (!groupMatch && !hasMatch) return null;
              }

              if (groupItems.length === 0) return null;

              const lowerSearch = searchTerm.toLowerCase();
              const isSearchMatched = searchTerm.trim() !== '' && (
                title.toLowerCase().includes(lowerSearch) || 
                groupItems.some(v => 
                  (v.variant_name && v.variant_name.toLowerCase().includes(lowerSearch)) ||
                  (v.myacg_item_code && v.myacg_item_code.toLowerCase().includes(lowerSearch))
                )
              );
              const isExpanded = isSearchMatched ? true : manualExpandedGroups.has(title);
              
              `;
  
  code = code.substring(0, startFilterMapIdx) + replacement + code.substring(endFilterMapIdx);
}

// 6. Update single render and group render to pass viewMode
code = code.replace(/<RenderSkuRow([^>]+)\/>/g, "<RenderSkuRow$1 viewMode={viewMode} />");

// 7. Update Group Headers
const oldCatHeader = `                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px' }}>
                        <HighlightText text={title} highlight={searchTerm} />
                      </div>
                      <span style={{ backgroundColor: '#f1f5f9', color: '#64748b', padding: '2px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 500 }}>
                        共 {groupItems.length} 款
                      </span>
                      <RenderStatusBadge demand={pDemand} purchased={pPurchased} style={{ marginLeft: '8px' }} />
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '13px', color: '#64748b' }}>
                      <span>總需求 {pDemand}</span>
                      <span>已採購 {pPurchased}</span>
                      <RenderStatusBadge demand={pDemand} purchased={pPurchased} />
                      <span>私下 {pManual}</span>
                      <div style={{ color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
                        {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                      </div>
                    </div>`;

const newCatHeader = `                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '15px' }}>
                        <HighlightText text={title} highlight={searchTerm} />
                      </div>
                      {viewMode === 'standard' ? (
                        <>
                          <span style={{ backgroundColor: '#f1f5f9', color: '#64748b', padding: '2px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 500 }}>
                            共 {groupItems.length} 款
                          </span>
                          <RenderStatusBadge demand={pDemand} purchased={pPurchased} style={{ marginLeft: '8px' }} />
                        </>
                      ) : (
                        <span style={{ backgroundColor: '#fee2e2', color: '#ef4444', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px' }}>
                          待處理 {groupItems.length}
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '13px', color: '#64748b' }}>
                      {viewMode === 'standard' && (
                        <>
                          <span>總需求 {pDemand}</span>
                          <span>已採購 {pPurchased}</span>
                          <span>待採購 {Math.max(pDemand - pPurchased, 0)}</span>
                          <span>私下 {pManual}</span>
                        </>
                      )}
                      <div style={{ color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
                        {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                      </div>
                    </div>`;
code = code.replace(oldCatHeader, newCatHeader);


// 8. Update Table Header for Compact Mode
const oldTableHeader = `<div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 20px', backgroundColor: '#fafafa', color: '#64748b', fontSize: '12px', fontWeight: 500 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '24px', width: '320px', justifyContent: 'flex-end' }}>
                          <div style={{ width: '60px', textAlign: 'center' }}>買動漫</div>
                          <div style={{ width: '60px', textAlign: 'center' }}>WACA</div>
                          <div style={{ width: '60px', textAlign: 'center' }}>私下登記</div>
                          <div style={{ width: '60px', textAlign: 'center' }}>已採購</div>
                        </div>
                      </div>`;
const newTableHeader = `{viewMode === 'standard' && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 16px', backgroundColor: '#fafafa', color: '#64748b', fontSize: '11px', fontWeight: 600 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', width: '280px', justifyContent: 'flex-end' }}>
                            <div style={{ width: '50px', textAlign: 'center' }}>買動漫</div>
                            <div style={{ width: '50px', textAlign: 'center' }}>WACA</div>
                            <div style={{ width: '50px', textAlign: 'center' }}>私下</div>
                            <div style={{ width: '50px', textAlign: 'center' }}>已採購</div>
                          </div>
                        </div>
                      )}`;
code = code.replace(oldTableHeader, newTableHeader);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Refactored to Compact and Shortage modes.");
