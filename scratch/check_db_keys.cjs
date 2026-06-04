const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const dbPath = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch\\leveldb_temp';

function getBaseSku(code) {
  if (!code) return '';
  const clean = code.trim().toUpperCase();
  const parts = clean.split('_');
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('_');
  }
  return clean;
}

async function main() {
  const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      if (keyStr.includes('erp_product_variants') || keyStr.includes('erp_import_batches') || keyStr.includes('erp_inventory') || keyStr.includes('erp_sales_order_items')) {
        console.log(`\nFound Key: "${keyStr}"`);
        
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
        
        if (val) {
          console.log(`  Decoded successfully. Type: ${Array.isArray(val) ? 'Array' : typeof val}, Length/Size: ${Array.isArray(val) ? val.length : 1}`);
          
          if (keyStr.includes('erp_product_variants')) {
            const matches = val.filter(v => (v.myacg_item_code || '').includes('GP00361307') || (v.variant_name || '').includes('應援毛巾'));
            console.log(`  Matches in erp_product_variants: ${matches.length}`);
            matches.forEach(v => {
              console.log(`    id: ${v.id} | SKU: ${v.myacg_item_code} | name: ${v.variant_name} | auto_qty: ${v.myacg_auto_quantity} | effective: ${v.effective_myacg_quantity}`);
            });
          }
          
          if (keyStr.includes('erp_inventory')) {
            const matches = val.filter(v => (v.myacg_item_code || '').includes('GP00361307') || (v.raw_variant_name || '').includes('應援毛巾'));
            console.log(`  Matches in erp_inventory: ${matches.length}`);
            matches.slice(0, 5).forEach(v => {
              console.log(`    SKU: ${v.myacg_item_code} | raw_name: ${v.raw_variant_name} | sold_qty: ${v.myacg_sold_quantity} | demand_qty: ${v.myacg_demand_quantity}`);
            });
          }
          
          if (keyStr.includes('erp_import_batches')) {
            console.log(`  Processing import batches...`);
            let count = 0;
            val.forEach((batch, bIdx) => {
              const newItems = batch.details?.newOrderItems || [];
              const matched = newItems.filter(item => {
                const itemCode = (item.myacg_item_code || '').trim().toUpperCase();
                return getBaseSku(itemCode) === 'GP00361307';
              });
              if (matched.length > 0) {
                console.log(`    Batch ${bIdx + 1} (${batch.file_name}): ${matched.length} matching items`);
                matched.forEach(item => {
                  count++;
                  if (count <= 25) {
                    console.log(`      Item: order_id: ${item.order_id} | SKU: ${item.myacg_item_code} | name: ${item.variant_name} | qty: ${item.quantity} | status: ${item.order_status}`);
                  }
                });
              }
            });
            console.log(`    Total matching items in details across all batches: ${count}`);
          }
          
          if (keyStr.includes('erp_sales_order_items')) {
            const matches = val.filter(v => (v.myacg_item_code || '').includes('GP00361307'));
            console.log(`  Matches in erp_sales_order_items: ${matches.length}`);
            matches.slice(0, 20).forEach(v => {
              console.log(`    order_id: ${v.order_id} | SKU: ${v.myacg_item_code} | qty: ${v.quantity} | status: ${v.order_status}`);
            });
          }
        } else {
          console.log(`  Decode failed.`);
        }
      }
    }
  } catch(err) {
    console.error("Error:", err);
  } finally {
    await db.close();
  }
}

main().catch(console.error);
