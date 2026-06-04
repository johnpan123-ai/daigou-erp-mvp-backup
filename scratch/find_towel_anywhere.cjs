const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const scratchDir = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch';

let dirs = [];
try {
  dirs = fs.readdirSync(scratchDir).filter(f => {
    try {
      return fs.statSync(path.join(scratchDir, f)).isDirectory();
    } catch(e) {
      return false;
    }
  });
} catch(e) {
  console.error("Error reading scratchDir:", e);
}

const candidates = [];
dirs.forEach(d => {
  const ldbPath1 = path.join(scratchDir, d, 'Default', 'Local Storage', 'leveldb');
  if (fs.existsSync(ldbPath1)) {
    candidates.push({ name: d, path: ldbPath1 });
  }
  const ldbPath2 = path.join(scratchDir, d);
  try {
    if (fs.existsSync(path.join(ldbPath2, 'CURRENT')) && d.includes('leveldb')) {
      candidates.push({ name: d, path: ldbPath2 });
    }
  } catch(e) {}
});

async function main() {
  console.log(`Candidates to check: ${candidates.length}`);
  for (const c of candidates) {
    let db;
    try {
      db = new ClassicLevel(c.path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
      for await (const [keyBuf, valBuf] of db.iterator()) {
        const keyStr = keyBuf.toString('utf8');
        
        let val = null;
        const valSlice = valBuf.slice(1);
        const decoders = [
          (b) => JSON.parse(b.slice(1).toString('utf16le')),
          (b) => JSON.parse(b.slice(1).toString('utf8')),
          (b) => JSON.parse(b.toString('utf16le')),
          (b) => JSON.parse(b.toString('utf8')),
        ];
        
        for (const dec of decoders) {
          try {
            val = dec(valBuf);
            if (val) break;
          } catch(e) {}
        }
        
        if (!val) continue;
        
        if (keyStr.includes('erp_product_variants')) {
          const matched = val.filter(v => (v.myacg_item_code || '').includes('GP00361307') || (v.variant_name || '').includes('應援毛巾'));
          if (matched.length > 0) {
            console.log(`\nDB: ${c.name} | Key: "${keyStr}"`);
            console.log(`  Found ${matched.length} variants:`);
            matched.forEach(v => {
              console.log(`    id: ${v.id} | SKU: ${v.myacg_item_code} | name: ${v.variant_name} | auto: ${v.myacg_auto_quantity} | eff: ${v.effective_myacg_quantity}`);
            });
          }
        }
        
        if (keyStr.includes('erp_sales_order_items')) {
          const matched = val.filter(item => (item.myacg_item_code || '').includes('GP00361307'));
          if (matched.length > 0) {
            console.log(`\nDB: ${c.name} | Key: "${keyStr}"`);
            console.log(`  Found ${matched.length} sales order items:`);
            matched.forEach(item => {
              console.log(`    order_id: ${item.order_id} | SKU: ${item.myacg_item_code} | name: ${item.variant_name} | qty: ${item.quantity} | status: ${item.order_status}`);
            });
          }
        }
      }
    } catch(err) {
      // Ignore open/read error
    } finally {
      if (db) {
        try { await db.close(); } catch(e) {}
      }
    }
  }
}

main().catch(console.error);
