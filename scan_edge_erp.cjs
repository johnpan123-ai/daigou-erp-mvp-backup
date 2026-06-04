const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

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
  'leveldb_edge_erp_copy'
);

async function main() {
  if (!fs.existsSync(edgeLsDir)) {
    console.log("Edge Profile 1 directory does not exist.");
    return;
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

  console.log(`Copying files from ${edgeLsDir}...`);
  const files = fs.readdirSync(edgeLsDir);
  let successCount = 0;
  for (const f of files) {
    const src = path.join(edgeLsDir, f);
    const dest = path.join(newCopyDir, f);
    try {
      fs.copyFileSync(src, dest);
      successCount++;
    } catch(e) {
      console.log(`  Failed to copy ${f}: ${e.message}`);
    }
  }
  console.log(`Successfully copied ${successCount}/${files.length} files.`);

  console.log(`Opening LevelDB to filter erp_ keys...`);
  const db = new ClassicLevel(newCopyDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  
  let salesOrderItems = null;
  let variants = null;
  let inventory = null;
  let importBatches = null;

  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      
      let cleanKey = keyStr;
      const nullIdx = keyStr.indexOf('\x00');
      if (nullIdx !== -1) {
        cleanKey = keyStr.substring(nullIdx + 2);
      }
      
      if (cleanKey === 'erp_sales_order_items') {
        const valSlice = valBuf.slice(1);
        try {
          salesOrderItems = JSON.parse(valSlice.toString('utf16le'));
        } catch(e) {
          salesOrderItems = JSON.parse(valSlice.toString('utf8'));
        }
        console.log(`Found erp_sales_order_items with ${salesOrderItems.length} items. Origin: ${keyStr.substring(0, nullIdx)}`);
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
      if (cleanKey === 'erp_import_batches') {
        const valSlice = valBuf.slice(1);
        try {
          importBatches = JSON.parse(valSlice.toString('utf16le'));
        } catch(e) {
          importBatches = JSON.parse(valSlice.toString('utf8'));
        }
      }
    }
  } catch (err) {
    console.error("Error reading database:", err);
  } finally {
    await db.close();
  }

  const getBaseSku = (code) => {
    if (!code) return '';
    const clean = code.trim().toUpperCase();
    const parts = clean.split('_');
    if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
      return parts.slice(0, -1).join('_');
    }
    return clean;
  };

  const targetBase = 'GP00361307';

  if (salesOrderItems) {
    console.log(`\nAnalyzing salesOrderItems for base SKU: ${targetBase}`);
    const matched = salesOrderItems.filter(item => {
      const code = (item.myacg_item_code || '').trim().toUpperCase();
      return getBaseSku(code) === targetBase;
    });

    console.log(`Total matching items count: ${matched.length}`);
    let sumNonCancelled = 0;
    let sumCancelled = 0;
    
    const matchedDetails = matched.map(item => {
      const isCancelled = item.order_status && item.order_status.includes('已取消');
      if (isCancelled) {
        sumCancelled += item.quantity || 0;
      } else {
        sumNonCancelled += item.quantity || 0;
      }
      return {
        order_id: item.order_id,
        myacg_item_code: item.myacg_item_code,
        variant_name: item.variant_name || item.product_name,
        quantity: item.quantity,
        price: item.price,
        order_status: item.order_status,
        isCancelled
      };
    });

    console.log(`Total quantity (excluding cancelled): ${sumNonCancelled}`);
    console.log(`Total quantity (cancelled): ${sumCancelled}`);
    console.log("Matching items:");
    console.log(JSON.stringify(matchedDetails, null, 2));
  } else {
    console.log("No salesOrderItems found in Edge Profile 1 LocalStorage.");
  }
}

main().catch(console.error);
