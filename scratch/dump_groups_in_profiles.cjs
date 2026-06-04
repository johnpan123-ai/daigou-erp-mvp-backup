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
      if (keyStr.includes('erp_product_groups')) {
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
            if (val && Array.isArray(val)) break;
          } catch(e) {}
        }
        if (!val || !Array.isArray(val)) continue;

        console.log(`\n[Profile: ${profileName}] Key: "${keyStr}"`);
        val.forEach(g => {
          console.log(`  Group ID: ${g.id} | Title: ${g.title}`);
        });
      }
    }
  } catch(e) {
    console.log(`  Error reading LevelDB for ${profileName}: ${e.message}`);
  } finally {
    await db.close();
  }
}

async function main() {
  for (const d of dirs) {
    const ldbPath = path.join(scratchDir, d, 'Default', 'Local Storage', 'leveldb');
    if (fs.existsSync(ldbPath)) {
      try {
        copyLdb(ldbPath);
        await scanTempLdb(d);
      } catch(e) {
        console.error(`Failed to scan profile ${d}:`, e.message);
      }
    }
  }
  
  // Cleanup temp directory
  try {
    clearTempDir();
    fs.rmdirSync(tempCopyDir);
  } catch(e) {}
}

main().catch(console.error);
