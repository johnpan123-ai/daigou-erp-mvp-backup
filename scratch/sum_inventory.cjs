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
  console.log(`Summing inventory items in leveldb_temp...`);
  
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      
      if (keyStr.includes('erp_inventory')) {
        console.log(`Matched Key: "${keyStr}"`);
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
          const matched = inventory.filter(i => i.myacg_item_code && i.myacg_item_code.includes('GP00361307'));
          console.log(`Found ${matched.length} inventory items for GP00361307.`);
          
          let sumSold = 0;
          let sumDemand = 0;
          matched.forEach(i => {
            sumSold += i.myacg_sold_quantity || 0;
            sumDemand += i.myacg_demand_quantity || 0;
            console.log(`  Code: ${i.myacg_item_code} | Title: ${i.product_title.substring(0, 20)}... | Spec: ${i.raw_variant_name} | Sold: ${i.myacg_sold_quantity} | Demand: ${i.myacg_demand_quantity || 0}`);
          });
          
          console.log(`Sum of Sold: ${sumSold}`);
          console.log(`Sum of Demand: ${sumDemand}`);
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
