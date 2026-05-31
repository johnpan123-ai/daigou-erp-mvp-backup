const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Add Edit Mode State
const stateAddition = `  const [activeTab, setActiveTab] = useState<'variants' | 'purchase_batches' | 'private_orders'>('variants');
  const [isEditMode, setIsEditMode] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<string, {m: number, w: number, p: number, pu: number}>>({});

  const handleEditModeToggle = () => {
    if (!isEditMode) {
      // Enter edit mode, initialize drafts
      const drafts: Record<string, {m: number, w: number, p: number, pu: number}> = {};
      variants.forEach(v => {
        drafts[v.id] = {
          m: (v.myacg_auto_quantity || 0) + (v.myacg_manual_adjustment || 0),
          w: (v.waca_auto_quantity || 0) + (v.waca_manual_adjustment || 0),
          p: (v.private_manual_adjustment || 0),
          pu: (v.purchased_manual_adjustment || 0)
        };
      });
      setEditDrafts(drafts);
      setIsEditMode(true);
    } else {
      // Cancel edit mode
      setIsEditMode(false);
      setEditDrafts({});
    }
  };

  const handleSaveEdits = async () => {
    const allVars = await db.getProductVariants();
    const updated = allVars.map(v => {
      const draft = editDrafts[v.id];
      if (draft) {
        return {
          ...v,
          myacg_manual_adjustment: draft.m - (v.myacg_auto_quantity || 0),
          waca_manual_adjustment: draft.w - (v.waca_auto_quantity || 0),
          private_manual_adjustment: draft.p,
          purchased_manual_adjustment: draft.pu
        };
      }
      return v;
    });
    await db.saveProductVariants(updated);
    setIsEditMode(false);
    setEditDrafts({});
    await loadData();
  };

  const handleDraftChange = (id: string, field: 'm'|'w'|'p'|'pu', val: number) => {
    if (isNaN(val) || val < 0) val = 0;
    setEditDrafts(prev => ({
      ...prev,
      [id]: {
        ...prev[id],
        [field]: val
      }
    }));
  };
`;
code = code.replace(/  const \[activeTab, setActiveTab\] = useState<'variants' \| 'purchase_batches' \| 'private_orders'>\('variants'\);/, stateAddition);


// 2. Add Top Right Toggle Button
const headerAddition = `          <h1 style={{ marginBottom: '4px', fontSize: '20px', fontWeight: 600 }}>{group?.title || '載入中...'}</h1>
          <p className="text-muted text-sm" style={{ margin: 0 }}>採購管理與對帳，SKU 母體資訊明細。</p>
        </div>
        <div className="flex gap-sm">
          {activeTab === 'variants' && (
            isEditMode ? (
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
              <button className="btn btn-secondary" onClick={handleEditModeToggle} style={{ backgroundColor: '#fff' }}>
                <Edit2 size={16} />
                編輯數量
              </button>
            )
          )}
          <button className="btn btn-secondary" onClick={() => navigate('/inventory')} style={{ backgroundColor: '#fff' }}>`;
code = code.replace(/          <h1 style=\{\{ marginBottom: '4px', fontSize: '20px', fontWeight: 600 \}\}>\{group\?\.title \|\| '載入中\.\.\.'\}<\/h1>\s*<p className="text-muted text-sm" style=\{\{ margin: 0 \}\}>採購管理與對帳，SKU 母體資訊明細。<\/p>\s*<\/div>\s*<div className="flex gap-sm">\s*<button className="btn btn-secondary" onClick=\{\(\) => navigate\('\/inventory'\)\} style=\{\{ backgroundColor: '#fff' \}\}>/, headerAddition);


// 3. Variables computation changes
const varsBefore = `                const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
                const priDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);

                pMyacg += mDemand;
                pWaca += wDemand;
                pManual += priDemand;
                
                const tDemand = mDemand + wDemand + priDemand;
                pDemand += tDemand;
                
                const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
                const tPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);`;

const varsAfter = `                const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
                const priDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0) + (v.private_manual_adjustment || 0);

                pMyacg += mDemand;
                pWaca += wDemand;
                pManual += priDemand;
                
                const tDemand = mDemand + wDemand + priDemand;
                pDemand += tDemand;
                
                const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
                const tPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0) + (v.purchased_manual_adjustment || 0);`;

code = code.replace(varsBefore, varsAfter);


const getDiffBefore = `        const privateDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);
        const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0);`;

const getDiffAfter = `        const privateDemand = privateOrderItems.filter(poi => poi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.private_manual_adjustment || 0);
        const totalPurchased = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id).reduce((s, i) => s + i.quantity, 0) + (v.purchased_manual_adjustment || 0);`;
code = code.replace(getDiffBefore, getDiffAfter);


// 4. Update the Table Row map variables
const trMapBefore = `                            const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
                            const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0);
        
                            const totalDemand = myacgDemand + wacaDemand + privateDemand;
    
                            const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
                            const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0);`;

const trMapAfter = `                            const vPrivateItems = privateOrderItems.filter(poi => poi.product_variant_id === v.id);
                            const privateDemand = vPrivateItems.reduce((sum, item) => sum + item.quantity, 0) + (v.private_manual_adjustment || 0);
        
                            const totalDemand = myacgDemand + wacaDemand + privateDemand;
    
                            const vBatchItems = purchaseBatchItems.filter(pbi => pbi.product_variant_id === v.id);
                            const totalPurchased = vBatchItems.reduce((sum, item) => sum + item.quantity, 0) + (v.purchased_manual_adjustment || 0);
                            
                            const draft = editDrafts[v.id];`;
code = code.replace(trMapBefore, trMapAfter);

// Update table header widths
code = code.replace(/<th style=\{\{ padding: '10px 12px', textAlign: 'center', fontWeight: 500, width: '80px' \}\}>買動漫<\/th>\s*<th style=\{\{ padding: '10px 12px', textAlign: 'center', fontWeight: 500, width: '80px' \}\}>WACA<\/th>\s*<th style=\{\{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 \}\}>私下登記<\/th>\s*<th style=\{\{ padding: '10px 12px', textAlign: 'center', fontWeight: 500 \}\}>已採購<\/th>/,
`<th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500, width: '100px' }}>買動漫</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500, width: '100px' }}>WACA</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500, width: '100px' }}>私下登記</th>
                            <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500, width: '100px' }}>已採購</th>`);


// 5. Replace table row body logic
const trBgBefore = `let trBg = '#fff';
                                if (vDiff < 0) trBg = '#fef2f2';
                                else if (vDiff > 0) trBg = '#f0fdf4';`;
const trBgAfter = `let trBg = isEditMode ? '#fef9c3' : '#fff';
                                if (!isEditMode) {
                                  if (vDiff < 0) trBg = '#fef2f2';
                                  else if (vDiff > 0) trBg = '#f0fdf4';
                                }`;
code = code.replace(trBgBefore, trBgAfter);

const trInputBefore = `                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  <input 
                                    type="number" 
                                    style={{ width: '100%', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                                    value={myacgDemand || ''}
                                    placeholder="0"
                                    onChange={e => handleUpdatePlatformDemand(v.id, 'myacg', parseInt(e.target.value))}
                                  />
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  <input 
                                    type="number" 
                                    style={{ width: '100%', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                                    value={wacaDemand || ''}
                                    placeholder="0"
                                    onChange={e => handleUpdatePlatformDemand(v.id, 'waca', parseInt(e.target.value))}
                                  />
                                </td>
                                
                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  <span style={{ fontWeight: 600, color: privateDemand > 0 ? '#db2777' : '#94a3b8', backgroundColor: privateDemand > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>
                                    {privateDemand > 0 ? privateDemand : '-'}
                                  </span>
                                </td>

                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  <span style={{ fontWeight: 600, color: totalPurchased > 0 ? '#2563eb' : '#94a3b8' }}>
                                    {totalPurchased > 0 ? totalPurchased : '-'}
                                  </span>
                                </td>`;

const trInputAfter = `                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  {isEditMode ? (
                                    <input 
                                      type="number" min="0"
                                      style={{ width: '100%', maxWidth: '80px', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                                      value={draft?.m ?? myacgDemand}
                                      onChange={e => handleDraftChange(v.id, 'm', parseInt(e.target.value))}
                                    />
                                  ) : (
                                    <span style={{ fontWeight: 600, color: myacgDemand > 0 ? '#334155' : '#94a3b8' }}>{myacgDemand > 0 ? myacgDemand : '-'}</span>
                                  )}
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  {isEditMode ? (
                                    <input 
                                      type="number" min="0"
                                      style={{ width: '100%', maxWidth: '80px', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                                      value={draft?.w ?? wacaDemand}
                                      onChange={e => handleDraftChange(v.id, 'w', parseInt(e.target.value))}
                                    />
                                  ) : (
                                    <span style={{ fontWeight: 600, color: wacaDemand > 0 ? '#334155' : '#94a3b8' }}>{wacaDemand > 0 ? wacaDemand : '-'}</span>
                                  )}
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  {isEditMode ? (
                                    <input 
                                      type="number" min="0"
                                      style={{ width: '100%', maxWidth: '80px', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                                      value={draft?.p ?? privateDemand}
                                      onChange={e => handleDraftChange(v.id, 'p', parseInt(e.target.value))}
                                    />
                                  ) : (
                                    <span style={{ fontWeight: 600, color: privateDemand > 0 ? '#db2777' : '#94a3b8', backgroundColor: privateDemand > 0 ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>
                                      {privateDemand > 0 ? privateDemand : '-'}
                                    </span>
                                  )}
                                </td>
                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                  {isEditMode ? (
                                    <input 
                                      type="number" min="0"
                                      style={{ width: '100%', maxWidth: '80px', height: '28px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px' }} 
                                      value={draft?.pu ?? totalPurchased}
                                      onChange={e => handleDraftChange(v.id, 'pu', parseInt(e.target.value))}
                                    />
                                  ) : (
                                    <span style={{ fontWeight: 600, color: totalPurchased > 0 ? '#2563eb' : '#94a3b8' }}>
                                      {totalPurchased > 0 ? totalPurchased : '-'}
                                    </span>
                                  )}
                                </td>`;

code = code.replace(trInputBefore, trInputAfter);


// Same replacement for single item view (no table, just stats)
// Actually single item view just shows stats, no inputs were there. Wait! The user says "買動漫、WACA、私下登記全部改成 Input". Did I put inputs in single item view?
// No, I didn't. In single item view it's just:
// <span style={{ fontWeight: 600, color: '#334155' }}>{pMyacg}</span>
// No inputs in single item view. It only has stats. I don't need to change it, it's already text only.


fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('PurchaseManagement Edit Mode applied.');
