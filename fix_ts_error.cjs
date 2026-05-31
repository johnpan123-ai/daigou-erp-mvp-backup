const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

const badShortageBlock = `  // 缺貨模式目前已經跳過 RenderSkuRow，直接由父層處理。
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
  }`;

const goodShortageBlock = `  // 缺貨模式目前已經跳過 RenderSkuRow，直接由父層處理。
  // 若單品觸發 RenderSkuRow(viewMode='shortage') 則仍需處理：
  if (viewMode === 'shortage') {
    const diff = totalPurchased - totalDemand;
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isSingle ? '12px 16px' : '8px 16px', borderBottom: isSingle ? 'none' : '1px solid #e2e8f0', backgroundColor: '#fff' }}>
        <div style={{ fontWeight: 600, color: '#0f172a', fontSize: '15px' }}>
          <HighlightText text={isSingle && title.startsWith('__single__') ? (v.variant_name || group.title) : v.variant_name} highlight={searchTerm} /> {diff < 0 ? \`× \${Math.abs(diff)}\` : ''}
        </div>
        {diff > 0 && <span style={{ backgroundColor: '#ffedd5', color: '#f97316', fontWeight: 600, fontSize: '13px', padding: '2px 8px', borderRadius: '4px' }}>多買 {diff}</span>}
      </div>
    );
  }`;

if (code.includes(badShortageBlock)) {
  code = code.replace(badShortageBlock, goodShortageBlock);
  fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
  console.log('Fixed TS Error.');
} else {
  console.log('Block not found.');
}
