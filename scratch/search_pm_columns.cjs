const fs = require('fs');
const path = require('path');

const fp = path.join(__dirname, '..', 'src', 'pages', 'PurchaseManagement.tsx');
const content = fs.readFileSync(fp, 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes('買動漫') || line.includes('myacgDemand') || line.includes('mDemand')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
