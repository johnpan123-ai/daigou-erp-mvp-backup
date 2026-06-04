const fs = require('fs');
const path = require('path');

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
        if (line.includes('crypto') && (line.includes('shim') || line.includes('polyfill') || line.includes('randomUUID =') || line.includes('uuid'))) {
          console.log(`${fullPath} L${idx + 1}: ${line.trim()}`);
        }
      });
    }
  }
}

searchDir(path.join(__dirname, '../src'));
searchDir(path.join(__dirname, '../public'));
searchDir(path.join(__dirname, '..'));
