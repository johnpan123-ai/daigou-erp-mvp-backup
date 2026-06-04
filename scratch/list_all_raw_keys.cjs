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
  console.log(`Scanning all keys in leveldb_temp...`);
  
  try {
    let matchCount = 0;
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr8 = keyBuf.toString('utf8');
      const keyStr16 = keyBuf.toString('utf16le');
      
      const searchTerms = ['sb-', 'token', 'auth', 'supabase', 'login', 'session', 'twzpqyesbtnfxdkorluf'];
      const matched = searchTerms.some(term => 
        keyStr8.toLowerCase().includes(term) || keyStr16.toLowerCase().includes(term)
      );
      
      if (matched) {
        matchCount++;
        console.log(`Match ${matchCount}:`);
        console.log(`  key (utf8): "${keyStr8}"`);
        console.log(`  key (utf16le): "${keyStr16}"`);
        console.log(`  value size: ${valBuf.length} bytes`);
      }
    }
    console.log(`Scan completed. Found ${matchCount} matches.`);
  } catch (err) {
    console.error("Error reading database:", err);
  } finally {
    await db.close();
  }
}

main().catch(console.error);
