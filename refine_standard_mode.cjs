const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// The block we want to replace starts at `return (` and ends at the end of RenderSkuRow
const oldBlockStart = `  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isSingle ? '16px 20px' : '12px 16px', borderBottom: isSingle ? 'none' : '1px solid #f1f5f9', backgroundColor: isEditMode ? '#fef9c3' : 'transparent' }}>
      
      {/* Left Info Area */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: viewMode === 'shortage' ? 'space-between' : 'flex-start' }}>
          <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '14px' }}>
            <HighlightText text={isSingle && title.startsWith('__single__') ? (v.variant_name || group.title) : v.variant_name} highlight={searchTerm} />
          </div>
          <RenderStatusBadge demand={totalDemand} purchased={totalPurchased} />
        </div>
        
        {viewMode === 'standard' && (
          <div style={{ fontSize: '12px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} /></span>
            <span>｜</span>
            <span>¥{price}</span>
            {v.catalog_missing && <span style={{ padding: '2px 6px', backgroundColor: '#fee2e2', color: '#ef4444', borderRadius: '4px', fontSize: '11px', fontWeight: 600 }}>商品主檔缺失</span>}
          </div>
        )}
        
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
  );
};`;

const newBlock = `  // 缺貨模式目前已經跳過 RenderSkuRow，直接由父層處理。
  // 若單品觸發 RenderSkuRow(viewMode='shortage') 則仍需處理：
  if (viewMode === 'shortage') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isSingle ? '12px 16px' : '8px 16px', borderBottom: isSingle ? 'none' : '1px solid #e2e8f0', backgroundColor: '#fff' }}>
        <div style={{ fontWeight: 600, color: '#0f172a', fontSize: '15px' }}>
          <HighlightText text={isSingle && title.startsWith('__single__') ? (v.variant_name || group.title) : v.variant_name} highlight={searchTerm} /> {diff < 0 ? \`× \${Math.abs(diff)}\` : ''}
        </div>
        {diff > 0 && <span style={{ backgroundColor: '#ffedd5', color: '#f97316', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px' }}>多買 {diff}</span>}
      </div>
    );
  }

  // 顯示全部商品模式 (viewMode === 'standard')
  // padding 減少 25%，例如: 6px 16px
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: isSingle ? '12px 16px' : '6px 16px', borderBottom: isSingle ? 'none' : '1px solid #f1f5f9', backgroundColor: isEditMode ? '#fef9c3' : 'transparent' }}>
      
      {/* 欄位 1: 商品名稱 / SKU */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: '150px' }}>
        <div style={{ fontWeight: 600, color: '#1e293b', fontSize: '14px' }}>
          <HighlightText text={isSingle && title.startsWith('__single__') ? (v.variant_name || group.title) : v.variant_name} highlight={searchTerm} />
        </div>
        <div style={{ fontSize: '11px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span>SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} /></span>
          {v.catalog_missing && <span style={{ padding: '1px 4px', backgroundColor: '#fee2e2', color: '#ef4444', borderRadius: '3px', fontSize: '10px', fontWeight: 600 }}>商品主檔缺失</span>}
        </div>
      </div>

      {/* 欄位 2: 單價 */}
      <div style={{ width: '70px', fontSize: '13px', color: '#475569', fontWeight: 500, textAlign: 'right', paddingRight: '20px' }}>
        ¥{price}
      </div>

      {/* 欄位 3: 狀態 */}
      <div style={{ width: '80px', display: 'flex', justifyContent: 'center' }}>
        <RenderStatusBadge demand={totalDemand} purchased={totalPurchased} />
      </div>

      {/* 欄位 4~7: 數量區 (固定寬度靠右) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '13px', minWidth: '240px', justifyContent: 'flex-end', paddingLeft: '20px' }}>
        
        {/* MyACG */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '48px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>買動漫</span>}
          {isEditMode ? (
            <input type="number" min="0" style={{ width: '100%', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.m ?? myacgDemand} onChange={e => handleDraftChange(v.id, 'm', parseInt(e.target.value))} />
          ) : (
            <span style={{ fontWeight: 600, color: myacgDemand > 0 ? '#334155' : '#94a3b8' }}>{myacgDemand > 0 ? myacgDemand : '-'}</span>
          )}
        </div>

        {/* WACA */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '48px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>WACA</span>}
          {isEditMode ? (
            <input type="number" min="0" style={{ width: '100%', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.w ?? wacaDemand} onChange={e => handleDraftChange(v.id, 'w', parseInt(e.target.value))} />
          ) : (
            <span style={{ fontWeight: 600, color: wacaDemand > 0 ? '#334155' : '#94a3b8' }}>{wacaDemand > 0 ? wacaDemand : '-'}</span>
          )}
        </div>

        {/* Private */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '48px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>私下</span>}
          {isEditMode ? (
            <input type="number" min="0" style={{ width: '100%', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.p ?? privateDemand} onChange={e => handleDraftChange(v.id, 'p', parseInt(e.target.value))} />
          ) : (
            <span style={{ fontWeight: 600, color: privateDemand > 0 ? '#db2777' : '#94a3b8', backgroundColor: privateDemand > 0 && !isSingle ? '#fce7f3' : 'transparent', padding: '2px 8px', borderRadius: '12px' }}>{privateDemand > 0 ? privateDemand : '-'}</span>
          )}
        </div>

        {/* Purchased */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '48px' }}>
          {isSingle && <span style={{ color: '#64748b', fontSize: '10px', marginBottom: '2px' }}>已採購</span>}
          {isEditMode ? (
            <input type="number" min="0" style={{ width: '100%', height: '24px', textAlign: 'center', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '13px', backgroundColor: '#fff' }} value={draft?.pu ?? totalPurchased} onChange={e => handleDraftChange(v.id, 'pu', parseInt(e.target.value))} />
          ) : (
            <span style={{ fontWeight: 600, color: totalPurchased > 0 ? '#2563eb' : '#94a3b8' }}>{totalPurchased > 0 ? totalPurchased : '-'}</span>
          )}
        </div>
      </div>
    </div>
  );
};`;

if (code.includes(oldBlockStart)) {
  code = code.replace(oldBlockStart, newBlock);
} else {
  console.log("Could not find the block to replace.");
}

// 2. Adjust Table Header (Header for the columns we just created)
// The user wants: 商品名稱/SKU | 單價 | 狀態 | 買動漫 | WACA | 私下登記 | 已採購
const oldTableHeader = `{viewMode === 'standard' && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 16px', backgroundColor: '#fafafa', color: '#64748b', fontSize: '11px', fontWeight: 600 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', width: '280px', justifyContent: 'flex-end' }}>
                            <div style={{ width: '50px', textAlign: 'center' }}>買動漫</div>
                            <div style={{ width: '50px', textAlign: 'center' }}>WACA</div>
                            <div style={{ width: '50px', textAlign: 'center' }}>私下</div>
                            <div style={{ width: '50px', textAlign: 'center' }}>已採購</div>
                          </div>
                        </div>
                      )}`;
const newTableHeader = `{viewMode === 'standard' && (
                        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 16px', backgroundColor: '#fafafa', color: '#64748b', fontSize: '11px', fontWeight: 600, borderBottom: '1px solid #f1f5f9' }}>
                          <div style={{ flex: 1 }}>商品名稱 / SKU</div>
                          <div style={{ width: '70px', textAlign: 'right', paddingRight: '20px' }}>單價</div>
                          <div style={{ width: '80px', textAlign: 'center' }}>狀態</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', minWidth: '240px', justifyContent: 'flex-end', paddingLeft: '20px' }}>
                            <div style={{ width: '48px', textAlign: 'center' }}>買動漫</div>
                            <div style={{ width: '48px', textAlign: 'center' }}>WACA</div>
                            <div style={{ width: '48px', textAlign: 'center' }}>私下登記</div>
                            <div style={{ width: '48px', textAlign: 'center' }}>已採購</div>
                          </div>
                        </div>
                      )}`;
if (code.includes(oldTableHeader)) {
  code = code.replace(oldTableHeader, newTableHeader);
}

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Refined Standard mode layout.");
