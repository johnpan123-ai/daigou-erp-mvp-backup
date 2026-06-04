const fs = require('fs');
const path = require('path');

const fp = path.join(__dirname, '..', 'src', 'lib', 'db.ts');
const content = fs.readFileSync(fp, 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes('syncProductGroupsWithInventory')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
