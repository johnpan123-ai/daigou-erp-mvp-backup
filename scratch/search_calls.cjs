const fs = require('fs');
const path = require('path');

function searchDir(dir) {
  const files = fs.readdirSync(dir);
  files.forEach(f => {
    const fp = path.join(dir, f);
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) {
      searchDir(fp);
    } else if (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx')) {
      const content = fs.readFileSync(fp, 'utf8');
      if (content.includes('calculateFinalMyacgDemand')) {
        console.log(`Found call in: ${fp}`);
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (line.includes('calculateFinalMyacgDemand')) {
            console.log(`  Line ${idx + 1}: ${line.trim()}`);
          }
        });
      }
    }
  });
}

searchDir(path.join(__dirname, '..', 'src'));
