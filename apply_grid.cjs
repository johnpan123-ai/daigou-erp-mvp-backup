const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

const oldBlockStart = `  // 顯示全部商品模式 (viewMode === 'standard')
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isSingle ? '12px 16px' : '6px 16px', borderBottom: isSingle ? 'none' : '1px solid #f1f5f9', backgroundColor: isEditMode ? '#fef9c3' : 'transparent' }}>
      
      {/* 左側資訊區 (Name, Price, Status 靠左聚集) */}
      <div style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
        {/* 欄位 1: 商品名稱 / SKU */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', width: '350px', flexShrink: 1 }}>
          <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <HighlightText text={isSingle && title.startsWith('__single__') ? (v.variant_name || group.title) : v.variant_name} highlight={searchTerm} />
          </div>
          <div style={{ fontSize: '11px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} /></span>
            {v.catalog_missing && <span style={{ padding: '1px 4px', backgroundColor: '#fee2e2', color: '#ef4444', borderRadius: '3px', fontSize: '10px', fontWeight: 600 }}>商品主檔缺失</span>}
          </div>
        </div>

        {/* 欄位 2: 單價 */}
        <div style={{ width: '100px', fontSize: '13px', color: '#475569', fontWeight: 500, textAlign: 'center' }}>
          ¥{price}
        </div>

        {/* 欄位 3: 狀態 */}
        <div style={{ width: '120px', display: 'flex', justifyContent: 'center' }}>
          <RenderStatusBadge demand={totalDemand} purchased={totalPurchased} />
        </div>
      </div>

      {/* 欄位 4~7: 數量區 (靠右聚集) */}
      <div style={{ display: 'flex', alignItems: 'center', fontSize: '13px' }}>
        
        {/* MyACG */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '80px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>買動漫</span>}
          {isEditMode ? (
            <input type="number" min="0" style={{ width: '60px', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.m ?? myacgDemand} onChange={e => handleDraftChange(v.id, 'm', parseInt(e.target.value))} />
          ) : (
            <span style={{ fontWeight: 600, color: myacgDemand > 0 ? '#334155' : '#94a3b8' }}>{myacgDemand > 0 ? myacgDemand : '-'}</span>
          )}
        </div>

        {/* WACA */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '80px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>WACA</span>}
          {isEditMode ? (
            <input type="number" min="0" style={{ width: '60px', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.w ?? wacaDemand} onChange={e => handleDraftChange(v.id, 'w', parseInt(e.target.value))} />
          ) : (
            <span style={{ fontWeight: 600, color: wacaDemand > 0 ? '#334155' : '#94a3b8' }}>{wacaDemand > 0 ? wacaDemand : '-'}</span>
          )}
        </div>

        {/* Private */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '80px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>私下登記</span>}
          {isEditMode ? (
            <input type="number" min="0" style={{ width: '60px', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.p ?? privateDemand} onChange={e => handleDraftChange(v.id, 'p', parseInt(e.target.value))} />
          ) : (
            <span style={{ fontWeight: 600, color: privateDemand > 0 ? '#db2777' : '#94a3b8', backgroundColor: privateDemand > 0 && !isSingle ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>{privateDemand > 0 ? privateDemand : '-'}</span>
          )}
        </div>

        {/* Purchased */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '80px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>已採購</span>}
          {isEditMode ? (
            <input type="number" min="0" style={{ width: '60px', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.pu ?? totalPurchased} onChange={e => handleDraftChange(v.id, 'pu', parseInt(e.target.value))} />
          ) : (
            <span style={{ fontWeight: 600, color: totalPurchased > 0 ? '#2563eb' : '#94a3b8' }}>{totalPurchased > 0 ? totalPurchased : '-'}</span>
          )}
        </div>
      </div>
    </div>
  );
};`;

const newBlock = `  // 顯示全部商品模式 (viewMode === 'standard')
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '30% 12% 12% 12% 12% 12% 10%', alignItems: 'center', padding: isSingle ? '8px 16px' : '4px 16px', borderBottom: isSingle ? 'none' : '1px solid #f1f5f9', backgroundColor: isEditMode ? '#fef9c3' : 'transparent', minHeight: '40px' }}>
      
      {/* 欄位 1: 商品名稱 / SKU */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingRight: '8px' }}>
        <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <HighlightText text={isSingle && title.startsWith('__single__') ? (v.variant_name || group.title) : v.variant_name} highlight={searchTerm} />
        </div>
        <div style={{ fontSize: '11px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span>SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} /></span>
          {v.catalog_missing && <span style={{ padding: '1px 4px', backgroundColor: '#fee2e2', color: '#ef4444', borderRadius: '3px', fontSize: '10px', fontWeight: 600 }}>商品主檔缺失</span>}
        </div>
      </div>

      {/* 欄位 2: 單價 */}
      <div style={{ fontSize: '13px', color: '#475569', fontWeight: 500, textAlign: 'center' }}>
        ¥{price}
      </div>

      {/* 欄位 3: 狀態 */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <RenderStatusBadge demand={totalDemand} purchased={totalPurchased} />
      </div>

      {/* 欄位 4: 買動漫 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>買動漫</span>}
        {isEditMode ? (
          <input type="number" min="0" style={{ width: '60px', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.m ?? myacgDemand} onChange={e => handleDraftChange(v.id, 'm', parseInt(e.target.value))} />
        ) : (
          <span style={{ fontWeight: 600, color: myacgDemand > 0 ? '#334155' : '#94a3b8' }}>{myacgDemand > 0 ? myacgDemand : '-'}</span>
        )}
      </div>

      {/* 欄位 5: WACA */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>WACA</span>}
        {isEditMode ? (
          <input type="number" min="0" style={{ width: '60px', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.w ?? wacaDemand} onChange={e => handleDraftChange(v.id, 'w', parseInt(e.target.value))} />
        ) : (
          <span style={{ fontWeight: 600, color: wacaDemand > 0 ? '#334155' : '#94a3b8' }}>{wacaDemand > 0 ? wacaDemand : '-'}</span>
        )}
      </div>

      {/* 欄位 6: 私下登記 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>私下登記</span>}
        {isEditMode ? (
          <input type="number" min="0" style={{ width: '60px', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.p ?? privateDemand} onChange={e => handleDraftChange(v.id, 'p', parseInt(e.target.value))} />
        ) : (
          <span style={{ fontWeight: 600, color: privateDemand > 0 ? '#db2777' : '#94a3b8', backgroundColor: privateDemand > 0 && !isSingle ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>{privateDemand > 0 ? privateDemand : '-'}</span>
        )}
      </div>

      {/* 欄位 7: 已採購 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>已採購</span>}
        {isEditMode ? (
          <input type="number" min="0" style={{ width: '60px', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.pu ?? totalPurchased} onChange={e => handleDraftChange(v.id, 'pu', parseInt(e.target.value))} />
        ) : (
          <span style={{ fontWeight: 600, color: totalPurchased > 0 ? '#2563eb' : '#94a3b8' }}>{totalPurchased > 0 ? totalPurchased : '-'}</span>
        )}
      </div>

    </div>
  );
};`;

if (code.includes(oldBlockStart)) {
  code = code.replace(oldBlockStart, newBlock);
} else {
  console.log('Error: Could not find oldBlockStart in code.');
}

const oldTableHeader = `{viewMode === 'standard' && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', backgroundColor: '#fafafa', color: '#64748b', fontSize: '12px', fontWeight: 600, borderBottom: '1px solid #e2e8f0' }}>
                          
                          {/* 左側資訊區 (Name, Price, Status 靠左聚集) */}
                          <div style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
                            <div style={{ width: '350px', flexShrink: 1 }}>商品名稱 / SKU</div>
                            <div style={{ width: '100px', textAlign: 'center' }}>單價</div>
                            <div style={{ width: '120px', textAlign: 'center' }}>狀態</div>
                          </div>
                          
                          {/* 數量區 (靠右聚集) */}
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            <div style={{ width: '80px', textAlign: 'center' }}>買動漫</div>
                            <div style={{ width: '80px', textAlign: 'center' }}>WACA</div>
                            <div style={{ width: '80px', textAlign: 'center' }}>私下登記</div>
                            <div style={{ width: '80px', textAlign: 'center' }}>已採購</div>
                          </div>
                        </div>
                      )}`;

const newTableHeader = `{viewMode === 'standard' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '30% 12% 12% 12% 12% 12% 10%', alignItems: 'center', padding: '8px 16px', backgroundColor: '#fafafa', color: '#64748b', fontSize: '12px', fontWeight: 600, borderBottom: '1px solid #e2e8f0', minHeight: '36px' }}>
                          <div style={{ paddingRight: '8px' }}>商品名稱 / SKU</div>
                          <div style={{ textAlign: 'center' }}>單價</div>
                          <div style={{ textAlign: 'center' }}>狀態</div>
                          <div style={{ textAlign: 'center' }}>買動漫</div>
                          <div style={{ textAlign: 'center' }}>WACA</div>
                          <div style={{ textAlign: 'center' }}>私下登記</div>
                          <div style={{ textAlign: 'center' }}>已採購</div>
                        </div>
                      )}`;

if (code.includes(oldTableHeader)) {
  code = code.replace(oldTableHeader, newTableHeader);
} else {
  console.log('Error: Could not find oldTableHeader in code.');
}

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Applied absolute percentage grid.");
