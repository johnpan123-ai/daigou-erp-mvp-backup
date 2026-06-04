const fs = require('fs');
const path = require('path');
const { ClassicLevel } = require('classic-level');

const leveldbDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Google',
  'Chrome',
  'User Data',
  'Default',
  'IndexedDB',
  'http_localhost_5174.indexeddb.leveldb'
);

const tempDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'indexeddb_temp'
);

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

async function run() {
  console.log("Copying IndexedDB files to temp folder...");
  const files = fs.readdirSync(leveldbDir);
  for (const f of files) {
    const src = path.join(leveldbDir, f);
    const dest = path.join(tempDir, f);
    try {
      const stat = fs.statSync(src);
      if (stat.isFile()) {
        fs.copyFileSync(src, dest);
      }
    } catch (e) {
      console.warn(`Could not copy ${f}:`, e.message);
    }
  }

  console.log("Opening LevelDB...");
  const db = new ClassicLevel(tempDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await db.open();

  console.log("Iterating LevelDB...");
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      // Find JSON strings or patterns in keys/values
      const keyStr = keyBuf.toString('utf8');
      const valStr = valBuf.toString('utf8');
      
      // Look for table/store records. In IndexedDB leveldb, data rows are stored
      // under specific object store IDs.
      // Let's search if the value contains any strings like 'Hololive'
      if (valStr.includes('Hololive') || valStr.includes('Tshirt') || valStr.includes('ReGLOSS')) {
        console.log(`\nKey (Hex): ${keyBuf.toString('hex')}`);
        console.log(`Key (ASCII): ${keyStr.replace(/[^\x20-\x7E]/g, '.')}`);
        // Let's print the string part of the value
        console.log(`Val (ASCII): ${valStr.replace(/[^\x20-\x7E]/g, '.')}`);
      }
    }
  } catch (err) {
    console.error("Error iterating DB:", err);
  } finally {
    await db.close();
  }
}

run();
