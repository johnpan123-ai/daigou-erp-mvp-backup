const fs = require('fs');
const lines = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8').split('\n');
console.log(lines.slice(708, 715).join('\n'));
