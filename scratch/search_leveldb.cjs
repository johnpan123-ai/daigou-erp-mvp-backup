const fs = require('fs');
const path = require('path');
const { ClassicLevel } = require('classic-level');

const chromeLsDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Google',
  'Chrome',
  'User Data',
  'Default',
  'Local Storage',
  'leveldb'
);

const destDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_search_ls'
);

if (!fs.existsSync(chromeLsDir)) {
  console.error("Chrome LS dir not found:", chromeLsDir);
  process.exit(1);
}

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

// Copy leveldb files
const files = fs.readdirSync(chromeLsDir);
for (const f of files) {
  const src = path.join(chromeLsDir, f);
  const dest = path.join(destDir, f);
  try {
    const stat = fs.statSync(src);
    if (stat.isFile()) fs.copyFileSync(src, dest);
  } catch (e) {}
}

async function run() {
  const db = new ClassicLevel(destDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  try {
    for (const prefix of ['', '_http://localhost:5173', '_http://localhost:5174', '_https://cubic-commands-arch-concord.trycloudflare.com']) {
      for await (const [keyBuf, valBuf] of db.iterator()) {
        const keyStr = keyBuf.toString('utf8');
        if (keyStr.includes('erp_product_groups')) {
          let parsedVal = null;
          const decoders = [
            (b) => JSON.parse(b.slice(1).toString('utf16le')),
            (b) => JSON.parse(b.slice(1).toString('utf8')),
            (b) => JSON.parse(b.toString('utf16le')),
            (b) => JSON.parse(b.toString('utf8')),
          ];
          for (const decoder of decoders) {
            try {
              parsedVal = decoder(valBuf);
              if (parsedVal) break;
            } catch (e) {}
          }
          if (parsedVal && Array.isArray(parsedVal)) {
            console.log(`Origin/Key: ${keyStr}`);
            parsedVal.forEach(g => {
              const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g.id);
              console.log(`  - Group ID: "${g.id}" (is UUID: ${isUuid}), Title: "${g.title}"`);
            });
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await db.close();
  }
}

run().catch(console.error);
