const { ClassicLevel } = require('classic-level');
const path = require('path');

const targetDb = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_temp'
);

async function main() {
  const db = new ClassicLevel(targetDb, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  console.log(`Opening leveldb_temp...`);
  
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      
      if (keyStr.includes('erp_product_variants')) {
        console.log(`\nMatched Key: "${keyStr}"`);
        const valSlice = valBuf.slice(1);
        let parsedVal = null;
        
        try {
          parsedVal = JSON.parse(valSlice.toString('utf16le'));
        } catch (e) {
          try {
            parsedVal = JSON.parse(valSlice.toString('utf8'));
          } catch (e) {}
        }
        
        if (parsedVal) {
          console.log(`Found ${parsedVal.length} variants:`);
          parsedVal.forEach((v, index) => {
            console.log(`[${index + 1}] SKU: ${v.myacg_item_code} | Spec: ${v.variant_name || v.raw_variant_name} | Auto Qty: ${v.myacg_auto_quantity} | Effective Qty: ${v.effective_myacg_quantity} | Manual: ${v.myacg_manual_adjustment || 0}`);
          });
        }
      }
    }
  } catch (err) {
    console.error("Error reading database:", err);
  } finally {
    await db.close();
  }
}

main().catch(console.error);
