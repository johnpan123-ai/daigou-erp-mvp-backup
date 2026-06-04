const fs = require('fs');
const path = require('path');

const targetDir = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch';

const files = fs.readdirSync(targetDir);

files.forEach(f => {
  const fullPath = path.join(targetDir, f);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isFile() && (f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.txt') || f.endsWith('.md'))) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('57')) {
        console.log(`\n========================================`);
        console.log(`File: ${f} contains '57'`);
        
        let idx = -1;
        while ((idx = content.indexOf('57', idx + 1)) !== -1) {
          const start = Math.max(0, idx - 100);
          const end = Math.min(content.length, idx + 200);
          console.log(`- Match at idx ${idx}: ...${content.substring(start, end).replace(/\r?\n/g, ' ')}...`);
        }
      }
    }
  } catch (e) {}
});
