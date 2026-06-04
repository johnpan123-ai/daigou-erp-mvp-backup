const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'supabase', 'sql', '002_core_erp_tables_mvp.sql');
if (!fs.existsSync(file)) {
  console.log("File not found");
  return;
}
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('POLICY') || line.includes('ROW LEVEL SECURITY')) {
    console.log(`${i+1}: ${line.trim()}`);
  }
}
