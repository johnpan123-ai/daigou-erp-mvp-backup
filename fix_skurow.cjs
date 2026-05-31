const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// The block we want to replace starts at `return (` and ends at `{/* Right Quantities Area */}`
const oldBlockStart = `  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: isSingle ? 'none' : '1px solid #f1f5f9', backgroundColor: isEditMode ? '#fef9c3' : 'transparent' }}>
      
      {/* Left Info Area */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, flexWrap: 'wrap', justifyContent: viewMode === 'shortage' ? 'space-between' : 'flex-start' }}>
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
      </div>`;

const newBlock = `  return (
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
        
      </div>`;

if (code.includes(oldBlockStart)) {
  code = code.replace(oldBlockStart, newBlock);
} else {
  console.log("Could not find the block to replace.");
}

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Done");
