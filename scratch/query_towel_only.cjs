const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const scratchDir = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch';

const candidates = [
  { name: 'mock_profile_ls_5174', path: path.join(scratchDir, 'mock_profile_ls_5174', 'Default', 'Local Storage', 'leveldb') },
  { name: 'mock_profile_ls_5180', path: path.join(scratchDir, 'mock_profile_ls_5180', 'Default', 'Local Storage', 'leveldb') },
  { name: 'mock_profile_test_5173', path: path.join(scratchDir, 'mock_profile_test_5173', 'Default', 'Local Storage', 'leveldb') },
  { name: 'leveldb_temp', path: path.join(scratchDir, 'leveldb_temp') }
];

async function main() {
  for (const c of candidates) {
    if (!fs.existsSync(c.path)) continue;
    console.log(`\nChecking DB: ${c.name}`);
    const db = new ClassicLevel(c.path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    try {
      for await (const [keyBuf, valBuf] of db.iterator()) {
        const keyStr = keyBuf.toString('utf8');
        if (keyStr.includes('erp_product_variants')) {
          const valSlice = valBuf.slice(1);
          let val = null;
          try { val = JSON.parse(valSlice.toString('utf16le')); } catch(e) {
            try { val = JSON.parse(valSlice.toString('utf8')); } catch(e2) {}
          }
          if (val && Array.isArray(val)) {
            const matched = val.filter(v => (v.variant_name || '').includes('應援毛巾') || (v.raw_variant_name || '').includes('應援毛巾'));
            if (matched.length > 0) {
              console.log(`  Found in ${keyStr}:`);
              matched.forEach(v => {
                console.log(`    id: ${v.id} | SKU: ${v.myacg_item_code} | name: ${v.variant_name} | auto_qty: ${v.myacg_auto_quantity} | effective: ${v.effective_myacg_quantity}`);
              });
            }
          }
        }
      }
    } catch(err) {
      console.log(`  Error: ${err.message}`);
    } finally {
      await db.close();
    }
  }
}

main().catch(console.error);
