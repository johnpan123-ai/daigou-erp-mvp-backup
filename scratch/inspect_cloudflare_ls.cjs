const fs = require('fs');
const path = require('path');
const { ClassicLevel } = require('classic-level');

const destDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_current_ls'
);

async function run() {
  const db = new ClassicLevel(destDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  const data = {};

  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      if (keyStr.includes('cubic-commands-arch-concord.trycloudflare.com')) {
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
        
        data[keyStr] = parsedVal || valBuf.toString('utf8');
      }
    }
  } finally {
    await db.close();
  }

  console.log("=== Cloudflare Origin LocalStorage Data ===");
  Object.keys(data).forEach(k => {
    console.log(`\nKey: ${k}`);
    console.log(JSON.stringify(data[k], null, 2));
  });
}

run().catch(console.error);
