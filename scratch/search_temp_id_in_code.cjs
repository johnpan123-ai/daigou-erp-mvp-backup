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
        if ((line.includes('temp') || line.includes('local')) && (line.includes('id') || line.includes('ID') || line.includes('Id'))) {
          // ignore comments
          if (!line.trim().startsWith('//')) {
            console.log(`${fullPath} L${idx + 1}: ${line.trim()}`);
          }
        }
      });
    }
  }
}

searchDir(path.join(__dirname, '../src'));
