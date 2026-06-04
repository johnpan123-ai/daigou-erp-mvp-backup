const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const scratchDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch'
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
    let count = 0;
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      
      if (keyStr.includes('sales_') || keyStr.includes('orders') || keyStr.includes('order_items')) {
        count++;
        console.log(`  Match ${count}: Key = "${keyStr}" | Val Size = ${valBuf.length} bytes`);
        const valSlice = valBuf.slice(1);
        let parsed = null;
        try {
          parsed = JSON.parse(valSlice.toString('utf16le'));
        } catch (e) {
          try {
            parsed = JSON.parse(valSlice.toString('utf8'));
          } catch (e2) {}
        }
        
        if (parsed && Array.isArray(parsed)) {
          console.log(`    Decoded Array length: ${parsed.length}`);
          if (parsed.length > 0) {
            console.log(`    Sample item keys:`, Object.keys(parsed[0]));
            if (keyStr.includes('items')) {
              // Print items for GP00361307 if found
              const matched = parsed.filter(item => item.myacg_item_code && item.myacg_item_code.includes('GP00361307'));
              console.log(`    GP00361307 items in this key: ${matched.length}`);
              matched.forEach(item => {
                console.log(`      Order: ${item.order_id || item.order_number} | SKU: ${item.myacg_item_code} | Spec: ${item.variant_name || item.product_name} | Qty: ${item.quantity} | Status: ${item.order_status}`);
              });
            }
          }
        }
      }
    }
    console.log(`  Scan complete. Matches = ${count}`);
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
