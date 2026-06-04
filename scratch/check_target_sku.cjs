const { ClassicLevel } = require('classic-level');
const path = require('path');

const dbPath = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch\\leveldb_temp';

async function run() {
  const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  let inventory = [];
  let variants = [];

  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      if (keyStr.includes('localhost:5173')) {
        const valSlice = valBuf.slice(1);
        let data = null;
        try {
          data = JSON.parse(valSlice.toString('utf16le'));
        } catch (e) {
          try {
            data = JSON.parse(valBuf.toString('utf8'));
          } catch (e2) {}
        }
        
        if (data) {
          if (keyStr.includes('erp_inventory')) {
            inventory = data;
          } else if (keyStr.includes('erp_product_variants')) {
            variants = data;
          }
        }
      }
    }
  } catch (err) {
    console.error("Error reading database:", err);
  } finally {
    await db.close();
  }

  console.log(`Loaded ${inventory.length} inventory items and ${variants.length} variants.`);

  console.log("\n==================== GP00359081_9 in Inventory ====================");
  const matchedInv = inventory.filter(x => x.myacg_item_code.trim().toUpperCase() === 'GP00359081_9');
  console.log(`Matched inventory count: ${matchedInv.length}`);
  matchedInv.forEach(item => {
    console.log(JSON.stringify(item, null, 2));
  });

  console.log("\n==================== GP00359081_9 in Product Variants ====================");
  const matchedVars = variants.filter(x => x.myacg_item_code.trim().toUpperCase() === 'GP00359081_9');
  console.log(`Matched variants count: ${matchedVars.length}`);
  matchedVars.forEach(item => {
    console.log(JSON.stringify(item, null, 2));
  });
}

run().catch(console.error);
