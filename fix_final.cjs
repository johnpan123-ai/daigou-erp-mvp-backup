const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Re-add manualExpandedGroups toggle logic but call it something else to avoid conflict, or just rename the existing toggleGroup.
// Let's just define toggleManualGroup
const toggleManualGroup = `
  const toggleManualGroup = (title: string) => {
    const newSet = new Set(manualExpandedGroups);
    if (newSet.has(title)) newSet.delete(title);
    else newSet.add(title);
    setManualExpandedGroups(newSet);
  };
`;
code = code.replace('  const [filterMode, setFilterMode]', toggleManualGroup + '\n  const [filterMode, setFilterMode]');

// replace toggleGroup(title) with toggleManualGroup(title) in my new JSX
code = code.replace(/onClick=\{\(\) => toggleGroup\(title\)\}/g, 'onClick={() => toggleManualGroup(title)}');

// Fix unused setSalesOrders and setSalesOrderItems which should have been used in loadData.
// Oh wait, my `apply_state.cjs` changes WERE wiped! I never ran apply_state.cjs AFTER git checkout!
// I need to add them to loadData!

const loadDataEnd = `
    setPurchaseBatches(groupBatches);
    setPurchaseBatchItems(groupBatchItems);
  };
`;
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
code = code.replace(loadDataEnd, newLoadDataEnd);

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Final fixes applied');
