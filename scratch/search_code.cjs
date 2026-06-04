const fs = require('fs');
const path = require('path');

const query = process.argv[2] || 'erp_provider_mode';
console.log(`Searching for "${query}" in src/...`);

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        results = results.concat(walk(fullPath));
      }
    } else {
      if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
        results.push(fullPath);
      }
    }
  });
  return results;
}

const files = walk(path.join(__dirname, '..', 'src'));
console.log(`Found ${files.length} code files to search.`);

files.forEach(file => {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes(query)) {
        console.log(`${path.relative(path.join(__dirname, '..'), file)}:${idx + 1}: ${line.trim()}`);
      }
    });
  } catch (e) {
    console.error(`Error reading ${file}:`, e.message);
  }
});
