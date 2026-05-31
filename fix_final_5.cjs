const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

code = code.replace(/  const \[expandedGroups, setExpandedGroups\] = useState<Set<string>>\(new Set\(\)\);\n/g, '');
code = code.replace(/  const \[expandedOrderRows, setExpandedOrderRows\] = useState<Set<string>>\(new Set\(\)\);\n/g, '');
code = code.replace(/    setExpandedGroups\(groupCatTitles\);\n/g, '');

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Final fixes 5 applied');
