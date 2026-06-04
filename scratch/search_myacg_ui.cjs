const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '../src/pages/PurchaseManagement.tsx'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes('myacg') || line.includes('manual_adjustment') || line.includes('買動漫') || line.includes('myacg_manual_adjustment')) {
    console.log(`L${idx + 1}: ${line.trim()}`);
  }
});
