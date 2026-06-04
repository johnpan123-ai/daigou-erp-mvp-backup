const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const scratchDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch'
);

const chromeDefault = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Google',
  'Chrome',
  'User Data',
  'Default',
  'Local Storage',
  'leveldb'
);

const candidates = [
  { name: 'Chrome Default (temp)', path: path.join(scratchDir, 'leveldb_temp') }
];

const files = fs.readdirSync(scratchDir);
files.forEach(f => {
  const fullPath = path.join(scratchDir, f);
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const leveldbPath = path.join(fullPath, 'Default', 'Local Storage', 'leveldb');
    if (fs.existsSync(leveldbPath)) {
      candidates.push({ name: f, path: leveldbPath });
    }
    const currentLdb = path.join(fullPath, 'CURRENT');
    if (fs.existsSync(currentLdb) && f.includes('leveldb')) {
      candidates.push({ name: f, path: fullPath });
    }
  }
});

async function searchDb(candidate) {
  console.log(`\nScanning DB: ${candidate.name} at ${candidate.path}...`);
  let db;
  try {
    db = new ClassicLevel(candidate.path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      
      if (keyStr.includes('erp_product_variants')) {
        const valSlice = valBuf.slice(1);
        let parsedVal = null;
        try {
          parsedVal = JSON.parse(valSlice.toString('utf16le'));
        } catch (e) {
          try {
            parsedVal = JSON.parse(valSlice.toString('utf8'));
          } catch (e2) {}
        }
        
        if (parsedVal && Array.isArray(parsedVal)) {
          const matched = parsedVal.filter(v => v.myacg_item_code && v.myacg_item_code.includes('GP00361307'));
          if (matched.length > 0) {
            console.log(`  Found matching variants in key "${keyStr}":`);
            matched.forEach(v => {
              console.log(`    SKU: ${v.myacg_item_code} | Spec: ${v.variant_name} | Auto: ${v.myacg_auto_quantity} | Effective: ${v.effective_myacg_quantity}`);
            });
            
            // Also search for erp_sales_order_items in the same origin if possible
            const origin = keyStr.split('\u0000')[0];
            console.log(`  Origin of matched key: "${origin}"`);
          }
        }
      }
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  } finally {
    if (db) {
      try {
        await db.close();
      } catch (e) {}
    }
  }
}

async function main() {
  for (const c of candidates) {
    await searchDb(c);
  }
}

main().catch(console.error);
