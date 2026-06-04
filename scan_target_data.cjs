const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

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

const edgeLsDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Microsoft',
  'Edge',
  'User Data',
  'Default',
  'Local Storage',
  'leveldb'
);

const newCopyDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_target_scan_copy'
);

async function scanDirectory(lsDir, name) {
  if (!fs.existsSync(lsDir)) {
    console.log(`${name} directory does not exist: ${lsDir}`);
    return null;
  }
  
  if (!fs.existsSync(newCopyDir)) {
    fs.mkdirSync(newCopyDir, { recursive: true });
  }

  // Clear existing files in newCopyDir
  const oldFiles = fs.readdirSync(newCopyDir);
  for (const f of oldFiles) {
    try {
      fs.unlinkSync(path.join(newCopyDir, f));
    } catch(e) {}
  }

  console.log(`Copying files from ${name} LevelDB...`);
  const files = fs.readdirSync(lsDir);
  let successCount = 0;
  for (const f of files) {
    const src = path.join(lsDir, f);
    const dest = path.join(newCopyDir, f);
    try {
      fs.copyFileSync(src, dest);
      successCount++;
    } catch(e) {
      // ignore locked files
    }
  }

  const db = new ClassicLevel(newCopyDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  let variants = null;
  let inventory = null;

  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      let cleanKey = keyStr;
      const nullIdx = keyStr.indexOf('\x00');
      if (nullIdx !== -1) {
        cleanKey = keyStr.substring(nullIdx + 2);
      }
      
      if (cleanKey === 'erp_product_variants') {
        const valSlice = valBuf.slice(1);
        try {
          variants = JSON.parse(valSlice.toString('utf16le'));
        } catch(e) {
          variants = JSON.parse(valSlice.toString('utf8'));
        }
      }
      if (cleanKey === 'erp_inventory') {
        const valSlice = valBuf.slice(1);
        try {
          inventory = JSON.parse(valSlice.toString('utf16le'));
        } catch(e) {
          inventory = JSON.parse(valSlice.toString('utf8'));
        }
      }
    }
  } catch (err) {
    console.error(`Error reading ${name} DB:`, err);
  } finally {
    await db.close();
  }

  return { variants, inventory };
}

async function analyzeResult(result, dbName) {
  if (!result || !result.variants) {
    console.log(`No variants found in ${dbName}`);
    return;
  }

  const targetBase = 'GP00363845';
  const matchedVariants = result.variants.filter(v => 
    v.myacg_item_code && v.myacg_item_code.startsWith(targetBase)
  );

  console.log(`\n[${dbName}] Found ${matchedVariants.length} matching variants:`);
  
  const sortVariants = (list) => {
    return list.sort((a, b) => {
      const aNum = parseInt(a.myacg_item_code.split('_')[1] || '0');
      const bNum = parseInt(b.myacg_item_code.split('_')[1] || '0');
      return aNum - bNum;
    });
  };

  if (matchedVariants.length > 0) {
    const displayVariants = matchedVariants.map(v => ({
      id: v.id,
      myacg_item_code: v.myacg_item_code,
      variant_name: v.variant_name,
      raw_variant_name: v.raw_variant_name,
      product_title: v.product_title,
      product_group_id: v.product_group_id,
      product_category_id: v.product_category_id,
      sort_order: v.sort_order,
      import_sort_index: v.import_sort_index
    }));
    console.log(`--- MATCHED VARIANTS IN ${dbName} ---`);
    console.log(JSON.stringify(sortVariants(displayVariants), null, 2));
  }

  if (result.inventory) {
    const matchedInventory = result.inventory.filter(i => 
      i.myacg_item_code && i.myacg_item_code.startsWith(targetBase)
    );
    console.log(`[${dbName}] Found ${matchedInventory.length} matching inventory items:`);
    if (matchedInventory.length > 0) {
      const displayInv = matchedInventory.map(i => ({
        myacg_item_code: i.myacg_item_code,
        product_title: i.product_title,
        raw_variant_name: i.raw_variant_name,
        import_sort_index: i.import_sort_index
      }));
      console.log(`--- MATCHED INVENTORY IN ${dbName} ---`);
      console.log(JSON.stringify(sortVariants(displayInv), null, 2));
    }
  }
}

async function main() {
  console.log("Scanning Chrome...");
  const chromeResult = await scanDirectory(chromeLsDir, "Chrome");
  await analyzeResult(chromeResult, "Chrome");
  
  console.log("\nScanning Edge...");
  const edgeResult = await scanDirectory(edgeLsDir, "Edge");
  await analyzeResult(edgeResult, "Edge");
}

main().catch(console.error);
