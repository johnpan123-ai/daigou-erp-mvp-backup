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
  console.log(`Checking inventory items...`);
  
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      
      if (keyStr.includes('cubic-commands-arch-concord') && keyStr.includes('erp_inventory')) {
        const valSlice = valBuf.slice(1);
        let inventory = null;
        try {
          inventory = JSON.parse(valSlice.toString('utf16le'));
        } catch (e) {
          try {
            inventory = JSON.parse(valSlice.toString('utf8'));
          } catch (e2) {}
        }
        
        if (inventory && Array.isArray(inventory)) {
          const skus = ['GP00363094_1', 'G07135792'];
          skus.forEach(sku => {
            const matched = inventory.find(i => i.myacg_item_code === sku);
            if (matched) {
              console.log(`SKU: ${sku} | Sold Qty: ${matched.myacg_sold_quantity} | Demand Qty: ${matched.myacg_demand_quantity}`);
            } else {
              console.log(`SKU: ${sku} not found in erp_inventory.`);
            }
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
