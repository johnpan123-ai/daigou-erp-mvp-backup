const fs = require('fs');
const path = require('path');

const fp = path.join(__dirname, '..', 'src', 'providers', 'cloud', 'supabaseProvider.ts');
const content = fs.readFileSync(fp, 'utf8');
const lines = content.split('\n');

let start = -1;
let end = -1;

lines.forEach((line, idx) => {
  if (line.includes('pullSalesOrders()') || line.includes('pullSalesOrderItems()')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
