const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '../src/pages/OrdersImport.tsx'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes('pendingGroups') || line.includes('createdGroups') || line.includes('catalog_missing') || line.includes('saveProductGroups')) {
    console.log(`L${idx + 1}: ${line.trim()}`);
  }
});
