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
  'leveldb_check_myacg_ls'
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
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      if (keyStr.includes('erp_product_variants')) {
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
          const withAdjustments = parsedVal.filter(v => v.myacg_manual_adjustment !== undefined || v.waca_manual_adjustment !== undefined);
          if (withAdjustments.length > 0) {
            console.log(`\nKey: ${keyStr}`);
            withAdjustments.forEach(v => {
              console.log(`  - Variant: "${v.variant_name}", SKU: "${v.myacg_item_code}"`);
              console.log(`    myacg_manual_adjustment: ${v.myacg_manual_adjustment}`);
              console.log(`    waca_manual_adjustment: ${v.waca_manual_adjustment}`);
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
