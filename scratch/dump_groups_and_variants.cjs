const { ClassicLevel } = require('classic-level');
const path = require('path');

const dbPath = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch\\leveldb_temp';

async function main() {
  const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  try {
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

      if (keyStr.includes('erp_product_groups')) {
        console.log(`\n=== Product Groups in ${keyStr} ===`);
        val.forEach(g => {
          console.log(`Group ID: ${g.id} | Title: ${g.title}`);
        });
      }
      
      if (keyStr.includes('erp_product_categories')) {
        console.log(`\n=== Product Categories in ${keyStr} ===`);
        val.forEach(c => {
          console.log(`Category ID: ${c.id} | Group ID: ${c.product_group_id} | Title: ${c.title}`);
        });
      }
    }
  } catch(e) {
    console.error(e);
  } finally {
    await db.close();
  }
}

main().catch(console.error);
