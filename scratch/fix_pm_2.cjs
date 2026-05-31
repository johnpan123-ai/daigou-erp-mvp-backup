const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'src', 'pages', 'PurchaseManagement.tsx');
let content = fs.readFileSync(targetFile, 'utf8');

// 1. Remove "const price = inv ? inv.final_price : 0;" inside single item card block
const singlePriceVar = "const price = inv ? inv.final_price : 0;";
content = content.replace(singlePriceVar, "");

// 2. Remove "const price = inv ? inv.final_price : 0;" inside category card rows block
// Let's do it after the previous point. Actually, both are exactly the same string.
// Let's replace the second occurrence as well.
content = content.replace(singlePriceVar, "");

fs.writeFileSync(targetFile, content, 'utf8');
console.log("Successfully removed unused price variables.");
