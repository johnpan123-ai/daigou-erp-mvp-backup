const fs = require('fs');
const path = require('path');

const fp = path.join(__dirname, '..', 'src', 'pages', 'Dashboard.tsx');
const content = fs.readFileSync(fp, 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes('買動漫') || line.includes('myacgDemand') || line.includes('mDemand') || line.includes('calculateFinalMyacgDemand')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
