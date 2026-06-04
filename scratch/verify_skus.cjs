const { ClassicLevel } = require('classic-level');
const path = require('path');

const dbPath = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch\\leveldb_temp';

async function run() {
  const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  let inventory = [];
  let salesOrderItems = [];

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
          } else if (keyStr.includes('erp_import_batches')) {
            data.forEach(batch => {
              const items = batch.details?.newOrderItems || [];
              salesOrderItems.push(...items);
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("Error reading database:", err);
  } finally {
    await db.close();
  }

  console.log(`Loaded ${inventory.length} inventory items and ${salesOrderItems.length} sales order items from import batches.`);

  console.log("\n==================== GP00361307_24 ~ GP00361307_34 ====================");
  for (let i = 24; i <= 34; i++) {
    const sku = `GP00361307_${i}`;
    const item = inventory.find(x => x.myacg_item_code.trim().toUpperCase() === sku);
    if (item) {
      console.log(`${sku} (${item.raw_variant_name}): myacg_sold_quantity = ${item.myacg_sold_quantity}`);
    } else {
      console.log(`${sku}: Not found in inventory`);
    }
  }
}

run().catch(console.error);
