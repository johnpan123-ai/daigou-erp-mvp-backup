const fs = require('fs');
const path = require('path');

const fields = [
  'myacg_manual_adjustment',
  'waca_manual_adjustment',
  'private_manual_adjustment',
  'purchased_manual_adjustment'
];

function searchDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      searchDir(fullPath);
    } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        for (const field of fields) {
          if (line.includes(field)) {
            console.log(`${fullPath} L${idx + 1}: ${line.trim()}`);
          }
        }
      });
    }
  }
}

searchDir(path.join(__dirname, '../src'));
