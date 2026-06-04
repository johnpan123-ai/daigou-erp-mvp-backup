const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const chromeUserDataDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Google',
  'Chrome',
  'User Data'
);

const edgeUserDataDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Microsoft',
  'Edge',
  'User Data'
);

const newCopyDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_profile_scan_copy'
);

function findLevelDbPaths(userDataDir) {
  if (!fs.existsSync(userDataDir)) return [];
  const paths = [];
  
  // Check Default
  const defaultPath = path.join(userDataDir, 'Default', 'Local Storage', 'leveldb');
  if (fs.existsSync(defaultPath)) {
    paths.push({ name: 'Default', path: defaultPath });
  }

  // Check Profile X
  const files = fs.readdirSync(userDataDir);
  for (const f of files) {
    if (f.startsWith('Profile ')) {
      const p = path.join(userDataDir, f, 'Local Storage', 'leveldb');
      if (fs.existsSync(p)) {
        paths.push({ name: f, path: p });
      }
    }
  }
  return paths;
}

async function scanDirectory(lsDir, name) {
  if (!fs.existsSync(lsDir)) {
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

  const files = fs.readdirSync(lsDir);
  for (const f of files) {
    const src = path.join(lsDir, f);
    const dest = path.join(newCopyDir, f);
    try {
      fs.copyFileSync(src, dest);
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
    // console.error(`Error reading ${name}:`, err);
  } finally {
    await db.close();
  }

  return { variants, inventory };
}

async function analyzeResult(result, dbName) {
  if (!result || !result.variants) {
    return false;
  }

  const targetBase = 'GP00363845';
  const matchedVariants = result.variants.filter(v => 
    v.myacg_item_code && v.myacg_item_code.startsWith(targetBase)
  );

  if (matchedVariants.length === 0) {
    return false;
  }

  console.log(`\n=============================================`);
  console.log(`FOUND DATA IN PROFILE: ${dbName}`);
  console.log(`=============================================`);
  console.log(`Found ${matchedVariants.length} matching variants:`);
  
  const sortVariants = (list) => {
    return list.sort((a, b) => {
      const aNum = parseInt(a.myacg_item_code.split('_')[1] || '0');
      const bNum = parseInt(b.myacg_item_code.split('_')[1] || '0');
      return aNum - bNum;
    });
  };

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
  
  console.log("--- MATCHED VARIANTS ---");
  console.log(JSON.stringify(sortVariants(displayVariants), null, 2));

  if (result.inventory) {
    const matchedInventory = result.inventory.filter(i => 
      i.myacg_item_code && i.myacg_item_code.startsWith(targetBase)
    );
    console.log(`Found ${matchedInventory.length} matching inventory items:`);
    if (matchedInventory.length > 0) {
      const displayInv = matchedInventory.map(i => ({
        myacg_item_code: i.myacg_item_code,
        product_title: i.product_title,
        raw_variant_name: i.raw_variant_name,
        import_sort_index: i.import_sort_index
      }));
      console.log("--- MATCHED INVENTORY ---");
      console.log(JSON.stringify(sortVariants(displayInv), null, 2));
    }
  }
  return true;
}

async function main() {
  console.log("Locating all Chrome leveldb paths...");
  const chromePaths = findLevelDbPaths(chromeUserDataDir);
  console.log("Chrome paths:", chromePaths.map(p => p.name));

  console.log("Locating all Edge leveldb paths...");
  const edgePaths = findLevelDbPaths(edgeUserDataDir);
  console.log("Edge paths:", edgePaths.map(p => p.name));

  let found = false;
  for (const item of chromePaths) {
    console.log(`Scanning Chrome ${item.name}...`);
    const res = await scanDirectory(item.path, `Chrome ${item.name}`);
    const matched = await analyzeResult(res, `Chrome ${item.name}`);
    if (matched) found = true;
  }

  for (const item of edgePaths) {
    console.log(`Scanning Edge ${item.name}...`);
    const res = await scanDirectory(item.path, `Edge ${item.name}`);
    const matched = await analyzeResult(res, `Edge ${item.name}`);
    if (matched) found = true;
  }

  if (!found) {
    console.log("\nNo matching variants found for GP00363845 in any profile.");
  }
}

main().catch(console.error);
