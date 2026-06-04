const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');

const scratchDir = 'C:\\Users\\小河馬\\.gemini\\antigravity\\scratch';

// Find all subdirectories in scratch
const dirs = fs.readdirSync(scratchDir).filter(f => {
  return fs.statSync(path.join(scratchDir, f)).isDirectory();
});

const candidates = [];
dirs.forEach(d => {
  const ldbPath1 = path.join(scratchDir, d, 'Default', 'Local Storage', 'leveldb');
  if (fs.existsSync(ldbPath1)) {
    candidates.push({ name: d, path: ldbPath1 });
  }
  const ldbPath2 = path.join(scratchDir, d);
  if (fs.existsSync(path.join(ldbPath2, 'CURRENT')) && d.includes('leveldb')) {
    candidates.push({ name: d, path: ldbPath2 });
  }
});

async function main() {
  for (const c of candidates) {
    console.log(`\n========================================`);
    console.log(`Scanning Candidate DB: ${c.name} (${c.path})`);
    const db = new ClassicLevel(c.path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    try {
      for await (const [keyBuf, valBuf] of db.iterator()) {
        const keyStr = keyBuf.toString('utf8');
        const valStrUtf8 = valBuf.toString('utf8');
        const valStrUtf16 = valBuf.toString('utf16le');
        
        if (keyStr.includes('GP00361307') || valStrUtf8.includes('GP00361307') || valStrUtf16.includes('GP00361307')) {
          console.log(`- Found GP00361307 reference in Key: "${keyStr}"`);
          // Try to decode value
          let parsedVal = null;
          const valSlice = valBuf.slice(1);
          const decoders = [
            (b) => JSON.parse(b.slice(1).toString('utf16le')),
            (b) => JSON.parse(b.slice(1).toString('utf8')),
            (b) => JSON.parse(b.toString('utf16le')),
            (b) => JSON.parse(b.toString('utf8')),
          ];
          for (const dec of decoders) {
            try {
              parsedVal = dec(valBuf);
              if (parsedVal) break;
            } catch(e) {}
          }
          if (parsedVal) {
            console.log(`  Decoded successfully. Type: ${Array.isArray(parsedVal) ? 'Array' : typeof parsedVal}`);
            if (Array.isArray(parsedVal)) {
              console.log(`  Array length: ${parsedVal.length}`);
              const matches = parsedVal.filter(item => {
                const itemStr = JSON.stringify(item);
                return itemStr.includes('GP00361307');
              });
              console.log(`  Matching elements count: ${matches.length}`);
              if (matches.length > 0) {
                console.log(`  Sample matches (first 2):`);
                matches.slice(0, 2).forEach((m, idx) => {
                  console.log(`    [${idx}]`, typeof m === 'object' ? JSON.stringify(m).substring(0, 200) + '...' : m);
                });
              }
            } else {
              console.log(`  Value snippet:`, JSON.stringify(parsedVal).substring(0, 300) + '...');
            }
          } else {
            console.log(`  Could not parse JSON. Raw length: ${valBuf.length}`);
          }
        }
      }
    } catch(err) {
      console.log(`  Error scanning: ${err.message}`);
    } finally {
      await db.close();
    }
  }
}

main().catch(console.error);
