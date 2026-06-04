const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const scratchDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch'
);

const candidates = [];
const files = fs.readdirSync(scratchDir);
files.forEach(f => {
  const fullPath = path.join(scratchDir, f);
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const ldbPath = path.join(fullPath, 'Default', 'Local Storage', 'leveldb');
    if (fs.existsSync(ldbPath)) {
      candidates.push({ name: f, path: ldbPath });
    }
    const currentLdb = path.join(fullPath, 'CURRENT');
    if (fs.existsSync(currentLdb) && f.includes('leveldb')) {
      candidates.push({ name: `Direct: ${f}`, path: fullPath });
    }
  }
});

async function main() {
  for (const c of candidates) {
    console.log(`\n========================================`);
    console.log(`Scanning Candidate: ${c.name} (${c.path})`);
    const db = new ClassicLevel(c.path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    
    try {
      for await (const [keyBuf, valBuf] of db.iterator()) {
        const keyStr = keyBuf.toString('utf8');
        
        let cleanKey = keyStr;
        const nullIdx = keyStr.indexOf('\x00');
        if (nullIdx !== -1) {
          cleanKey = keyStr.substring(nullIdx + 2);
        }
        
        if (cleanKey.includes('erp_')) {
          const valSlice = valBuf.slice(1);
          let parsedVal = null;
          let decodeSuccess = false;
          try {
            parsedVal = JSON.parse(valSlice.toString('utf16le'));
            decodeSuccess = true;
          } catch (e) {
            try {
              parsedVal = JSON.parse(valSlice.toString('utf8'));
              decodeSuccess = true;
            } catch (e2) {
              try {
                parsedVal = JSON.parse(valBuf.toString('utf16le'));
                decodeSuccess = true;
              } catch (e3) {
                try {
                  parsedVal = JSON.parse(valBuf.toString('utf8'));
                  decodeSuccess = true;
                } catch (e4) {}
              }
            }
          }
          
          if (decodeSuccess && parsedVal) {
            const isArr = Array.isArray(parsedVal);
            console.log(`- Key: "${cleanKey}" | Type: ${isArr ? 'Array' : typeof parsedVal} | Length: ${isArr ? parsedVal.length : 1}`);
            if (cleanKey === 'erp_sales_order_items') {
              console.log(`  Found erp_sales_order_items! Sample:`, parsedVal.slice(0, 2));
            }
          } else {
            console.log(`- Key: "${cleanKey}" | Raw Size: ${valBuf.length} bytes | Decode failed`);
          }
        }
      }
    } catch (err) {
      console.log(`Error scanning ${c.name}: ${err.message}`);
    } finally {
      await db.close();
    }
  }
}

main().catch(console.error);
