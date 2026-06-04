const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '../src/pages/PurchaseRecords.tsx'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes('onClick') || line.includes('handleAdd') || line.includes('create') || line.includes('UUID') || line.includes('random')) {
    console.log(`L${idx + 1}: ${line.trim()}`);
  }
});
