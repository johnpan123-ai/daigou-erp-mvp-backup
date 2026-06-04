const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '../src/lib/db.ts'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes('id:') && !line.includes('interface') && !line.includes('//') && !line.includes('undefined')) {
    console.log(`L${idx + 1}: ${line.trim()}`);
  }
});
