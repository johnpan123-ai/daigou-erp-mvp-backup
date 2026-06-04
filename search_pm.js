const fs = require('fs');
const path = require('path');

const keywords = ['purchaseGridColumns', 'selectedCell', 'editingCell', 'productName', '購買日期', '訂購人', '單價', '備註', 'productUrl', '🔗'];

function searchDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== 'dist' && file !== 'build') {
        searchDir(fullPath);
      }
    } else {
      if (file.endsWith('.tsx') || file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.json') || file.endsWith('.css')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          for (const kw of keywords) {
            if (content.includes(kw)) {
              console.log(`Found '${kw}' in ${fullPath}`);
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }
}

searchDir('.');
