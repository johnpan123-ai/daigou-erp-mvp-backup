const fs = require('fs');
const path = require('path');

const srcDir = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch\\daigou-erp-mvp\\src';

function searchInDir(dir, keyword) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const fullPath = path.join(dir, f);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      searchInDir(fullPath, keyword);
    } else if (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes(keyword)) {
        console.log(`Found in: ${path.relative(srcDir, fullPath)}`);
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (line.includes(keyword)) {
            console.log(`  Line ${idx + 1}: ${line.trim().substring(0, 120)}`);
          }
        });
      }
    }
  }
}

searchInDir(srcDir, 'getSalesOrderItems');
