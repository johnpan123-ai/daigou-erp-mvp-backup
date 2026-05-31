const fs = require('fs');

let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// Replace ?? 9999 with ?? 999999 for robust sorting
code = code.replace(/a\.sort_order \?\? 9999/g, 'a.sort_order ?? 999999');
code = code.replace(/b\.sort_order \?\? 9999/g, 'b.sort_order ?? 999999');
code = code.replace(/sortA = 9999/g, 'sortA = 999999');
code = code.replace(/sortB = 9999/g, 'sortB = 999999');
code = code.replace(/catA\.sort_order \?\? 9999/g, 'catA.sort_order ?? 999999');
code = code.replace(/itemsA\[0\]\.sort_order \?\? 9999/g, 'itemsA[0].sort_order ?? 999999');
code = code.replace(/catB\.sort_order \?\? 9999/g, 'catB.sort_order ?? 999999');
code = code.replace(/itemsB\[0\]\.sort_order \?\? 9999/g, 'itemsB[0].sort_order ?? 999999');

const singleBadge = `
                        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                          SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} /> | 單價: ¥{price}
                          {v.catalog_missing && <span style={{ marginLeft: '8px', padding: '2px 6px', backgroundColor: '#fee2e2', color: '#ef4444', borderRadius: '4px', fontSize: '11px', fontWeight: 600 }}>商品主檔缺失</span>}
                        </div>
`;
code = code.replace(/<div style=\{\{ fontSize: '12px', color: '#64748b', marginTop: '4px' \}\}>\s*SKU: <HighlightText text=\{v.myacg_item_code\} highlight=\{searchTerm\} \/> \| 單價: ¥\{price\}\s*<\/div>/, singleBadge);


const categoryBadge = `
                                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                                    SKU: <HighlightText text={v.myacg_item_code} highlight={searchTerm} />
                                    {v.catalog_missing && <span style={{ marginLeft: '8px', padding: '2px 6px', backgroundColor: '#fee2e2', color: '#ef4444', borderRadius: '4px', fontSize: '10px', fontWeight: 600 }}>商品主檔缺失</span>}
                                  </div>
`;
code = code.replace(/<div style=\{\{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' \}\}>\s*SKU: <HighlightText text=\{v.myacg_item_code\} highlight=\{searchTerm\} \/>\s*<\/div>/, categoryBadge);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('PurchaseManagement badges applied');
