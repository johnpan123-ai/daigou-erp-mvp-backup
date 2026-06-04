const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const targetDb = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_temp'
);

async function main() {
  const db = new ClassicLevel(targetDb, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  const results = [];
  
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr8 = keyBuf.toString('utf8');
      const keyStr16 = keyBuf.toString('utf16le');
      
      const searchTerms = ['twzpqyes', 'cubic-commands', 'trycloudflare'];
      const matched = searchTerms.some(term => 
        keyStr8.toLowerCase().includes(term) || keyStr16.toLowerCase().includes(term)
      );
      
      if (matched) {
        // Decode value
        const valSlice = valBuf.slice(1);
        let parsed = null;
        try {
          parsed = JSON.parse(valSlice.toString('utf16le'));
        } catch (e) {
          try {
            parsed = JSON.parse(valSlice.toString('utf8'));
          } catch (e2) {
            try {
              parsed = JSON.parse(valBuf.toString('utf16le'));
            } catch (e3) {
              try {
                parsed = JSON.parse(valBuf.toString('utf8'));
              } catch (e4) {
                parsed = valBuf.toString('utf8');
              }
            }
          }
        }
        
        results.push({
          key8: keyStr8,
          key16: keyStr16,
          val: parsed
        });
      }
    }
    
    fs.writeFileSync(
      'C:/Users/小河馬/.gemini/antigravity/scratch/specific_keys.json',
      JSON.stringify(results, null, 2),
      'utf8'
    );
    console.log(`Saved ${results.length} specific keys to specific_keys.json`);
  } catch (err) {
    console.error("Error reading database:", err);
  } finally {
    await db.close();
  }
}

main().catch(console.error);
