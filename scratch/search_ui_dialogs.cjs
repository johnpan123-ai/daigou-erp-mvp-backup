const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../src/pages');
const files = fs.readdirSync(dir);

for (const file of files) {
  if (file.endsWith('.tsx')) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('handleSubmit') || line.includes('handleAdd') || line.includes('showAdd') || line.includes('新建') || line.includes('新增商品') || line.includes('建立商品') || line.includes('新增群組') || line.includes('建立群組')) {
        console.log(`${file} L${idx + 1}: ${line.trim()}`);
      }
    });
  }
}
