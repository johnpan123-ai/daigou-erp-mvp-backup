const fs = require('fs');
const path = require('path');

function searchDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      searchDir(fullPath);
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        // Look for id: in an object literal, e.g. id: '...' or id: String(...) or id: Date.now()
        if (line.includes('id:') && (line.includes('Date.now') || line.includes('Math.random') || line.includes('local_') || line.includes('temp_') || /id:\s*['"`][^'"`\-]+['"`]/.test(line))) {
          if (!line.includes('//')) {
            console.log(`${fullPath} L${idx + 1}: ${line.trim()}`);
          }
        }
      });
    }
  }
}

searchDir(path.join(__dirname, '../src'));
