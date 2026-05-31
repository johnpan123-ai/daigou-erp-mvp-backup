const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

code = code.replace(/  const toggleGroup = \(title: string\) => \{[\s\S]*?  \};/m, '');
code = code.replace(/  const toggleOrderRow = \(vId: string\) => \{[\s\S]*?  \};/m, '');

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log('Final fixes 4 applied');
