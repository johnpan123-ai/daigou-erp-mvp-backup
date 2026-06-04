const fs = require('fs');
const path = require('path');

function search(dir) {
  const files = fs.readdirSync(dir);
  files.forEach(f => {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) {
      search(fp);
    } else if (f.endsWith('.tsx') || f.endsWith('.ts')) {
      const content = fs.readFileSync(fp, 'utf8');
      if (content.includes('erp_product_variants') || content.includes('getProductVariants')) {
        console.log(`Found in ${fp}`);
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (line.includes('erp_product_variants') || line.includes('getProductVariants')) {
            console.log(`  Line ${idx + 1}: ${line.trim()}`);
          }
        });
      }
    }
  });
}

search(path.join(__dirname, '..', 'src'));
