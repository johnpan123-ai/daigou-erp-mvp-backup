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
        if (line.includes('purchase_date:') && line.includes('title:') || (line.includes('priority:') && line.includes('purchase_date:'))) {
          console.log(`${fullPath} L${idx + 1}: ${line.trim()}`);
        }
        // Let's also check for random UUID vs other id generation
        if (line.includes('id:') && (line.includes('local_') || line.includes('group_') || line.includes('cat_') || line.includes('var_'))) {
          console.log(`Potential ID assignment: ${fullPath} L${idx + 1}: ${line.trim()}`);
        }
      });
    }
  }
}

searchDir(path.join(__dirname, '../src'));
