const fs = require('fs');
const content = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf-8');
content.split('\n').forEach((line, index) => {
  if (line.includes('getDailiVariantModalName')) {
    console.log(`Line ${index + 1}: ${line.trim()}`);
  }
});
