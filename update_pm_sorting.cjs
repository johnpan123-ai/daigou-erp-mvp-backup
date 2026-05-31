const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

const searchGrouping = `  // Grouping Variants by Category or Single Item
  const groupedVariants: Record<string, ProductVariant[]> = {};
  variants.forEach(v => {
    let groupKey = '';
    if (v.product_category_id) {
      const cat = categoryMap.get(v.product_category_id);
      groupKey = cat ? cat.title : \`__single__\${v.id}\`;
    } else {
      groupKey = \`__single__\${v.id}\`;
    }
    
    if (!groupedVariants[groupKey]) groupedVariants[groupKey] = [];
    groupedVariants[groupKey].push(v);
  });`;
  
const insertSorting = searchGrouping + `

  // Sort variants inside each group
  Object.values(groupedVariants).forEach(groupItems => {
    groupItems.sort((a, b) => {
      const aSort = a.sort_order ?? 9999;
      const bSort = b.sort_order ?? 9999;
      if (aSort !== bSort) return aSort - bSort;
      return (a.myacg_item_code || '').localeCompare(b.myacg_item_code || '');
    });
  });

  const sortedGroupEntries = Object.entries(groupedVariants).sort(([titleA, itemsA], [titleB, itemsB]) => {
    let sortA = 9999;
    let sortB = 9999;

    const catA = itemsA[0]?.product_category_id ? categoryMap.get(itemsA[0].product_category_id) : null;
    const catB = itemsB[0]?.product_category_id ? categoryMap.get(itemsB[0].product_category_id) : null;

    if (catA) sortA = catA.sort_order ?? 9999;
    else if (itemsA[0]) sortA = itemsA[0].sort_order ?? 9999;

    if (catB) sortB = catB.sort_order ?? 9999;
    else if (itemsB[0]) sortB = itemsB[0].sort_order ?? 9999;

    if (sortA !== sortB) return sortA - sortB;

    return titleA.localeCompare(titleB);
  });
`;

code = code.replace(searchGrouping, insertSorting);

const searchJSX = `{Object.entries(groupedVariants).filter(([title, groupItems]) => {`;
const replaceJSX = `{sortedGroupEntries.filter(([title, groupItems]) => {`;
code = code.replace(searchJSX, replaceJSX);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('PurchaseManagement.tsx updated for sorting');
