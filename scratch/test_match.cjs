const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/pages/PurchaseManagement.tsx');
let content = fs.readFileSync(filePath, 'utf-8');
content = content.split('\r\n').join('\n');

const lines = content.split('\n');

console.log("Searching for estimatedTwd...");
lines.forEach((line, idx) => {
  if (line.includes("estimatedTwd")) {
    console.log(`Line ${idx + 1}: ${JSON.stringify(line)}`);
  }
});

console.log("Searching for Card 7...");
lines.forEach((line, idx) => {
  if (line.includes("總需求日幣/成本")) {
    console.log(`Line ${idx + 1}: ${JSON.stringify(line)}`);
    // Print 10 lines after
    for (let i = 1; i <= 10; i++) {
      console.log(`  +${i}: ${JSON.stringify(lines[idx + i])}`);
    }
  }
});

console.log("Searching for Card 8...");
lines.forEach((line, idx) => {
  if (line.includes("預估台幣")) {
    console.log(`Line ${idx + 1}: ${JSON.stringify(line)}`);
    // Print 10 lines after
    for (let i = 1; i <= 10; i++) {
      console.log(`  +${i}: ${JSON.stringify(lines[idx + i])}`);
    }
  }
});
