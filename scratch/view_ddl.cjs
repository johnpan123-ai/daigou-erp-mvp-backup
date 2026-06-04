const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'supabase', 'sql', '002_core_erp_tables_mvp.sql'),
  path.join(__dirname, '..', 'supabase', 'sql', '002_erp_tables.sql'),
  path.join(__dirname, '..', 'supabase', 'sql', '003_patch_core_tables_missing_sync_columns.sql')
];

files.forEach(file => {
  if (!fs.existsSync(file)) return;
  console.log(`\n=== File: ${path.basename(file)} ===`);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  let openTable = '';
  let inTable = false;
  let brackets = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const upperLine = line.toUpperCase();
    if (upperLine.includes('CREATE TABLE')) {
      inTable = true;
      openTable = line;
      console.log(`Line ${i+1}: ${line.trim()}`);
      brackets = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      continue;
    }
    if (inTable) {
      console.log(`  ${i+1}: ${line.trim()}`);
      brackets += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      if (line.includes(');') || brackets <= 0) {
        inTable = false;
      }
    }
  }
});
