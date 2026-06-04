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
  console.log(`Searching for auth token in leveldb_temp...`);
  
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      
      if (keyStr.includes('sb-twzpqyesbtnfxdkorluf-auth-token') || keyStr.includes('auth-token')) {
        console.log(`Matched Key: "${keyStr}"`);
        const valSlice = valBuf.slice(1);
        
        const decoders = [
          (b) => JSON.parse(b.toString('utf16le')),
          (b) => JSON.parse(b.toString('utf8')),
        ];
        
        let parsed = null;
        for (const dec of decoders) {
          try {
            parsed = dec(valSlice);
            if (parsed) break;
          } catch (e) {}
        }
        
        if (!parsed) {
          for (const dec of decoders) {
            try {
              parsed = dec(valBuf);
              if (parsed) break;
            } catch (e) {}
          }
        }
        
        if (parsed) {
          console.log("Successfully decoded JSON!");
          console.log("Access Token:", parsed.access_token ? (parsed.access_token.substring(0, 30) + "...") : "missing");
          console.log("Refresh Token:", parsed.refresh_token);
          console.log("User Email:", parsed.user?.email);
          console.log("Full Session Info:", JSON.stringify(parsed, null, 2));
        } else {
          console.log("Failed to decode value as JSON. Raw String:", valSlice.toString('utf8'));
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
