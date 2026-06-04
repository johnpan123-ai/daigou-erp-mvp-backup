const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const scratchDir = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch';

const candidates = [
  { name: 'leveldb_temp', path: path.join(scratchDir, 'leveldb_temp') },
  { name: 'leveldb_chrome_erp_copy', path: path.join(scratchDir, 'leveldb_chrome_erp_copy') },
  { name: 'leveldb_edge_erp_copy', path: path.join(scratchDir, 'leveldb_edge_erp_copy') },
  { name: 'leveldb_edge_profile1_copy', path: path.join(scratchDir, 'leveldb_edge_profile1_copy') },
  { name: 'leveldb_new_copy', path: path.join(scratchDir, 'leveldb_new_copy') }
];

async function scanDb(c) {
  if (!fs.existsSync(c.path)) {
    console.log(`- ${c.name} does not exist.`);
    return;
  }
  console.log(`- Scanning ${c.name}...`);
  let db;
  try {
    db = new ClassicLevel(c.path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      
      if (keyStr.includes('erp_product_variants') || keyStr.includes('erp_sales_order_items')) {
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
            console.log(`  [Variants] Found match in ${c.name} Key: "${keyStr}"`);
            matched.forEach(v => {
              console.log(`    id: ${v.id} | SKU: ${v.myacg_item_code} | name: ${v.variant_name} | auto_qty: ${v.myacg_auto_quantity} | effective: ${v.effective_myacg_quantity}`);
            });
          }
        }
        if (keyStr.includes('erp_sales_order_items')) {
          const matched = val.filter(v => (v.myacg_item_code || '').includes('GP00361307'));
          if (matched.length > 0) {
            console.log(`  [Sales Order Items] Found match in ${c.name} Key: "${keyStr}"`);
            matched.forEach(v => {
              console.log(`    order_id: ${v.order_id} | SKU: ${v.myacg_item_code} | name: ${v.variant_name} | qty: ${v.quantity} | status: ${v.order_status}`);
            });
          }
        }
      }
    }
  } catch(e) {
    console.log(`  Error scanning ${c.name}: ${e.message}`);
  } finally {
    if (db) {
      try { await db.close(); } catch(e) {}
    }
  }
}

async function main() {
  console.log("Starting safe scan...");
  for (const c of candidates) {
    await scanDb(c);
  }
  console.log("Safe scan finished.");
}

main().catch(console.error);
