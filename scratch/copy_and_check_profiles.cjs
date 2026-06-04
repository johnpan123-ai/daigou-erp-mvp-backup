const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const scratchDir = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch';
const tempCopyDir = path.join(scratchDir, 'temp_profile_scan');

let dirs = [];
try {
  dirs = fs.readdirSync(scratchDir).filter(f => {
    try {
      return fs.statSync(path.join(scratchDir, f)).isDirectory() && f.includes('mock_profile');
    } catch(e) {
      return false;
    }
  });
} catch(e) {
  console.error("Error reading directories:", e);
}

function clearTempDir() {
  if (!fs.existsSync(tempCopyDir)) {
    fs.mkdirSync(tempCopyDir, { recursive: true });
    return;
  }
  const files = fs.readdirSync(tempCopyDir);
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(tempCopyDir, f));
    } catch(e) {}
  }
}

function copyLdb(srcDir) {
  clearTempDir();
  const files = fs.readdirSync(srcDir);
  for (const f of files) {
    try {
      const stat = fs.statSync(path.join(srcDir, f));
      if (stat.isFile()) {
        fs.copyFileSync(path.join(srcDir, f), path.join(tempCopyDir, f));
      }
    } catch(e) {}
  }
}

async function scanTempLdb(profileName) {
  const db = new ClassicLevel(tempCopyDir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  try {
    for await (const [keyBuf, valBuf] of db.iterator()) {
      const keyStr = keyBuf.toString('utf8');
      if (keyStr.includes('erp_product_variants') || keyStr.includes('erp_sales_order_items')) {
        let val = null;
        const valSlice = valBuf.slice(1);
        const decoders = [
          (b) => JSON.parse(b.slice(1).toString('utf16le')),
          (b) => JSON.parse(b.slice(1).toString('utf8')),
          (b) => JSON.parse(b.toString('utf16le')),
          (b) => JSON.parse(b.toString('utf8')),
        ];
        for (const dec of decoders) {
          try {
            val = dec(valBuf);
            if (val) break;
          } catch(e) {}
        }
        if (!val) continue;

        if (keyStr.includes('erp_product_variants')) {
          const matched = val.filter(v => (v.myacg_item_code || '').includes('GP00361307') || (v.variant_name || '').includes('應援毛巾'));
          if (matched.length > 0) {
            console.log(`\n[Profile: ${profileName}] Key: "${keyStr}" | Size: ${val.length}`);
            console.log(`  Matched variants count: ${matched.length}`);
            matched.forEach(v => {
              console.log(`    Variant - id: ${v.id} | SKU: ${v.myacg_item_code} | name: ${v.variant_name} | auto: ${v.myacg_auto_quantity} | eff: ${v.effective_myacg_quantity}`);
            });
          }
        }

        if (keyStr.includes('erp_sales_order_items')) {
          const matched = val.filter(v => (v.myacg_item_code || '').includes('GP00361307') || (v.variant_name || '').includes('應援毛巾'));
          if (matched.length > 0) {
            console.log(`\n[Profile: ${profileName}] Key: "${keyStr}" | Size: ${val.length}`);
            console.log(`  Matched sales order items count: ${matched.length}`);
            matched.slice(0, 20).forEach(v => {
              console.log(`    Item - order_id: ${v.order_id} | SKU: ${v.myacg_item_code} | name: ${v.variant_name} | qty: ${v.quantity} | status: ${v.order_status}`);
            });
          }
        }
      }
    }
  } catch(e) {
    console.log(`  Error reading LevelDB for ${profileName}: ${e.message}`);
  } finally {
    await db.close();
  }
}

async function main() {
  console.log(`Profiles found:`, dirs);
  for (const d of dirs) {
    const ldbPath = path.join(scratchDir, d, 'Default', 'Local Storage', 'leveldb');
    if (fs.existsSync(ldbPath)) {
      console.log(`\nCopying and scanning Profile: ${d}...`);
      try {
        copyLdb(ldbPath);
        await scanTempLdb(d);
      } catch(e) {
        console.error(`Failed to copy or scan profile ${d}:`, e.message);
      }
    }
  }
  
  // Cleanup temp directory at the end
  try {
    clearTempDir();
    fs.rmdirSync(tempCopyDir);
  } catch(e) {}
}

main().catch(console.error);
