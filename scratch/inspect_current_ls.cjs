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
  'leveldb_current_ls'
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
  } catch (e) {
    console.warn(`Could not copy ${f}:`, e.message);
  }
}

async function run() {
  console.log("Opening LevelDB...");
  const db = new ClassicLevel(destDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  const data = {};

  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      const targetKeys = [
        'erp_inventory',
        'erp_product_variants',
        'erp_product_categories',
        'erp_product_groups',
        'erp_provider_mode'
      ];
      
      for (const tKey of targetKeys) {
        if (keyStr.includes(tKey)) {
          // Chrome Local Storage LevelDB prefixes values with a byte or format header.
          // Let's try parsing both with and without slicing the first byte.
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
          
          if (parsedVal) {
            data[keyStr] = {
              key: keyStr,
              val: parsedVal
            };
          } else {
            // If failed to parse as JSON, keep raw representation
            data[keyStr] = {
              key: keyStr,
              rawLength: valBuf.length
            };
          }
        }
      }
    }
  } catch (err) {
    console.error("Error iterating leveldb:", err);
  } finally {
    await db.close();
  }

  console.log("All matching keys in LevelDB:");
  Object.keys(data).forEach(k => {
    const item = data[k];
    console.log(`Key: ${k}`);
    if (item.val) {
      if (Array.isArray(item.val)) {
        console.log(`  Value array: ${item.val.length} items`);
      } else {
        console.log(`  Value type: ${typeof item.val}, value: ${JSON.stringify(item.val).substring(0, 100)}`);
      }
    } else {
      console.log(`  Raw length: ${item.rawLength}`);
    }
  });

  // Dump specific port configurations
  Object.keys(data).forEach(k => {
    if (k.includes('erp_product_variants')) {
      const variants = data[k].val;
      if (Array.isArray(variants)) {
        const hololive = variants.filter(v => v.product_title && v.product_title.includes('Hololive'));
        console.log(`\nHololive variants in ${k}:`);
        hololive.forEach(v => {
          console.log(`  - Variant: ${v.variant_name}, SKU: ${v.myacg_item_code}, Group ID: ${v.product_group_id}, Category ID: ${v.product_category_id}`);
        });
      }
    }
    if (k.includes('erp_product_groups')) {
      const groups = data[k].val;
      if (Array.isArray(groups)) {
        const hololive = groups.filter(g => g.title && g.title.includes('Hololive'));
        console.log(`\nHololive groups in ${k}:`);
        hololive.forEach(g => {
          console.log(`  - Group ID: ${g.id}, Title: ${g.title}`);
        });
      }
    }
    if (k.includes('erp_product_categories')) {
      const categories = data[k].val;
      if (Array.isArray(categories)) {
        console.log(`\nCategories in ${k}:`);
        categories.forEach(c => {
          console.log(`  - Category ID: ${c.id}, Group ID: ${c.product_group_id}, Title: ${c.title}`);
        });
      }
    }
  });
}

run().catch(console.error);
