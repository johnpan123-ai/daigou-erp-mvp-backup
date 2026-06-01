import fs from 'fs';

const content = fs.readFileSync('./src/pages/PurchaseManagement.tsx', 'utf8');
const lines = content.split('\n');
lines.forEach((line, index) => {
  if (line.includes('手動') || line.includes('對照') || line.includes('綁定') || line.includes('對應') || line.toLowerCase().includes('bind')) {
    console.log(`Line ${index + 1}: ${line.trim().slice(0, 150)}`);
  }
});
