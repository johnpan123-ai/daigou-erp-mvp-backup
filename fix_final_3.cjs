const fs = require('fs');
const lines = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8').split('\n');

const tgStart = lines.findIndex(l => l.includes('  const toggleGroup = (categoryId: string) => {'));
if (tgStart !== -1) {
  let end = tgStart;
  while (!lines[end].includes('  };')) end++;
  for (let i = tgStart; i <= end; i++) {
    lines[i] = '// ' + lines[i];
  }
}

const torStart = lines.findIndex(l => l.includes('  const toggleOrderRow = (orderId: string) => {'));
if (torStart !== -1) {
  let end = torStart;
  while (!lines[end].includes('  };')) end++;
  for (let i = torStart; i <= end; i++) {
    lines[i] = '// ' + lines[i];
  }
}

fs.writeFileSync('src/pages/PurchaseManagement.tsx', lines.join('\n'), 'utf8');
console.log('Final fixes 3 applied');
