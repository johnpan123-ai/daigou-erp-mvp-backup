const { ClassicLevel } = require('classic-level');
const path = require('path');

const dbPath = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch\\leveldb_temp';

async function main() {
  const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      if (keyStr.includes('erp_product_variants') && keyStr.includes('localhost:5173')) {
        const valSlice = valBuf.slice(1);
        const val = JSON.parse(valSlice.toString('utf16le'));
        console.log(`\nKey: "${keyStr}"`);
        console.log(JSON.stringify(val, null, 2));
      }
    }
  } catch(e) {
    console.error(e);
  } finally {
    await db.close();
  }
}

main().catch(console.error);
