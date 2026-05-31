const fs = require('fs');
let content = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');
content = content.replace(/\\\`/g, '`');
content = content.replace(/\\\$\{/g, '${');
fs.writeFileSync('src/pages/PurchaseManagement.tsx', content, 'utf8');
console.log('Fixed backslashes');
