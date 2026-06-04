const { ClassicLevel } = require('classic-level');
const path = require('path');

const targetDb = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_edge_temp'
);

async function main() {
  const db = new ClassicLevel(targetDb, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  console.log(`Scanning Edge leveldb_edge_temp...`);
  
  try {
    let count = 0;
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      
      const match = keyStr.includes('erp_') || keyStr.includes('sales_') || keyStr.includes('inventory') || keyStr.includes('sb-') || keyStr.includes('twzpqyes');
      if (match) {
        count++;
        console.log(`Match ${count}: Key = "${keyStr}" | Val Size = ${valBuf.length} bytes`);
        const valSlice = valBuf.slice(1);
        
        let parsed = null;
        try {
          parsed = JSON.parse(valSlice.toString('utf16le'));
        } catch (e) {
          try {
            parsed = JSON.parse(valSlice.toString('utf8'));
          } catch (e2) {}
        }
        
        if (parsed) {
          console.log("  Decoded JSON:", Array.isArray(parsed) ? `${parsed.length} items` : Object.keys(parsed));
          if (parsed.access_token) {
            console.log(`  Access Token: ${parsed.access_token.substring(0, 30)}...`);
            console.log(`  Refresh Token: ${parsed.refresh_token}`);
            console.log(`  User: ${parsed.user?.email}`);
          }
        } else {
          console.log("  Failed to decode. Raw string snippet:", valSlice.toString('utf8').substring(0, 100));
        }
      }
    }
    console.log(`Scan complete. Matches = ${count}`);
  } catch (err) {
    console.error("Error reading database:", err);
  } finally {
    await db.close();
  }
}

main().catch(console.error);
