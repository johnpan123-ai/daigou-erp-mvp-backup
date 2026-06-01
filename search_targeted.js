import fs from 'fs';

const files = ['./src/pages/Inventory.tsx', './src/pages/PurchaseManagement.tsx', './src/lib/db.ts', './src/pages/OrdersImport.tsx'];
const keywords = ['對照', '綁定', '手動', '對應', 'alias', 'mapping', 'bind', 'link'];

files.forEach(file => {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  console.log(`=== Matches in ${file} ===`);
  lines.forEach((line, index) => {
    for (const kw of keywords) {
      if (line.toLowerCase().includes(kw.toLowerCase())) {
        console.log(`Line ${index + 1}: ${line.trim()}`);
        break;
      }
    }
  });
});
