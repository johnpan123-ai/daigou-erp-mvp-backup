const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

const regex = /setPurchaseBatches\(groupBatches\);\s*setPurchaseBatchItems\(groupBatchItems\);\s*\/\/ Expand all groups by default\s*const groupCatTitles = new Set\(allCats\.filter\(c => c\.product_group_id === id\)\.map\(c => c\.title\)\);\s*setExpandedGroups\(groupCatTitles\);\s*\};/m;

const newLoadDataEnd = `
    setPurchaseBatches(groupBatches);
    setPurchaseBatchItems(groupBatchItems);

    const allSO = await db.getSalesOrders();
    const allSOI = await db.getSalesOrderItems();
    const groupVariantCodes = new Set(groupVars.map(v => v.myacg_item_code));
    const groupSOI = allSOI.filter(i => groupVariantCodes.has(i.myacg_item_code));
    const groupSOIds = new Set(groupSOI.map(i => i.order_id));
    const groupSO = allSO.filter(o => groupSOIds.has(o.id));

    setSalesOrders(groupSO);
    setSalesOrderItems(groupSOI);
  };
`;

code = code.replace(regex, newLoadDataEnd);

// To fix unused imports and unused functions:
code = code.replace("import React, { useState, useEffect } from 'react';", "import { useState, useEffect } from 'react';");
code = code.replace(/import { Filter, ListOrdered } from 'lucide-react';\n/g, '');

const filterRegex = /import { ChevronRight.*Filter, ListOrdered } from 'lucide-react';/;
if (filterRegex.test(code)) {
    code = code.replace(', Filter, ListOrdered', '');
}

code = code.replace(/const toggleOrderRow = \(orderId: string\) => \{[^}]+\};/g, '');
code = code.replace(/const toggleGroup = \(categoryId: string\) => \{[^}]+\};/g, '');


fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Final fixes 2 applied');
