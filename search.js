import fs from 'fs';
import path from 'path';

const keywords = ['alias', 'mapping', 'bind', '對照', '綁定', '對應', 'sku', 'myacg_item_code'];

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    const dirPath = path.join(dir, f);
    const isDirectory = fs.statSync(dirPath).isDirectory();
    if (isDirectory && f !== 'node_modules' && f !== '.git') {
      walkDir(dirPath, callback);
    } else if (!isDirectory && (f.endsWith('.ts') || f.endsWith('.tsx'))) {
      callback(dirPath);
    }
  });
}

walkDir('./src', (filePath) => {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    for (const kw of keywords) {
      if (line.toLowerCase().includes(kw.toLowerCase())) {
        console.log(`${filePath}:${index + 1}: [${kw}] -> ${line.trim().slice(0, 100)}`);
        break; // Show only first matched keyword per line
      }
    }
  });
});
