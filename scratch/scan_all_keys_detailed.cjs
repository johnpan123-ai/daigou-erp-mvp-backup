const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const scratchDir = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch';

const dirs = fs.readdirSync(scratchDir).filter(f => {
  return fs.statSync(path.join(scratchDir, f)).isDirectory();
});

const candidates = [];
dirs.forEach(d => {
  const ldbPath1 = path.join(scratchDir, d, 'Default', 'Local Storage', 'leveldb');
  if (fs.existsSync(ldbPath1)) {
    candidates.push({ name: d, path: ldbPath1 });
  }
  const ldbPath2 = path.join(scratchDir, d);
  if (fs.existsSync(path.join(ldbPath2, 'CURRENT')) && d.includes('leveldb')) {
    candidates.push({ name: d, path: ldbPath2 });
  }
});

function getBaseSku(code) {
  if (!code) return '';
  const clean = code.trim().toUpperCase();
  const parts = clean.split('_');
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('_');
  }
  return clean;
}

async function scanDb(c) {
  const db = new ClassicLevel(c.path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      if (keyStr.includes('erp_product_variants') || keyStr.includes('erp_sales_order_items') || keyStr.includes('erp_sales_orders') || keyStr.includes('erp_import_batches')) {
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
            console.log(`  Found ${matched.length} variants matching towel/SKU:`);
            matched.forEach(v => {
              console.log(`    id: ${v.id} | SKU: ${v.myacg_item_code} | name: ${v.variant_name} | auto_qty: ${v.myacg_auto_quantity} | effective: ${v.effective_myacg_quantity}`);
            });
          }
        }
        
        if (keyStr.includes('erp_sales_order_items')) {
          const matched = val.filter(v => (v.myacg_item_code || '').includes('GP00361307'));
          if (matched.length > 0) {
            console.log(`\nDB: ${c.name} | Key: "${keyStr}"`);
            console.log(`  Found ${matched.length} sales order items matching SKU:`);
            matched.slice(0, 20).forEach(v => {
              console.log(`    order_id: ${v.order_id} | SKU: ${v.myacg_item_code} | variant: ${v.variant_name} | qty: ${v.quantity} | status: ${v.order_status}`);
            });
          }
        }
        
        if (keyStr.includes('erp_sales_orders')) {
          const matched = val.filter(v => JSON.stringify(v).includes('MYACG_'));
          if (matched.length > 0) {
            console.log(`\nDB: ${c.name} | Key: "${keyStr}"`);
            console.log(`  Found ${matched.length} sales orders. Sample order_numbers:`, matched.slice(0, 5).map(o => o.order_number));
          }
        }
      }
    }
  } catch(e) {
    // console.log(`  Error scanning ${c.name}: ${e.message}`);
  } finally {
    await db.close();
  }
}

async function main() {
  for (const c of candidates) {
    await scanDb(c);
  }
}

main().catch(console.error);
