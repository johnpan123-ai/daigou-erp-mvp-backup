const fs = require('fs');
const path = require('path');

const query = process.argv[2] || 'get_my_role';
console.log(`Searching for "${query}" in supabase/sql/...`);

const dir = path.join(__dirname, '..', 'supabase', 'sql');
if (!fs.existsSync(dir)) {
  console.log("No sql folder");
  return;
}
const files = fs.readdirSync(dir);
files.forEach(file => {
  if (file.endsWith('.sql')) {
    const full = path.join(dir, file);
    const content = fs.readFileSync(full, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes(query)) {
        console.log(`${file}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
});
