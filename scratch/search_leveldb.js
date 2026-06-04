const fs = require('fs');
const path = require('path');

const leveldbDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Google',
  'Chrome',
  'User Data',
  'Default',
  'IndexedDB',
  'http_localhost_5174.indexeddb.leveldb'
);

if (!fs.existsSync(leveldbDir)) {
  console.error("IndexedDB folder not found at:", leveldbDir);
  process.exit(1);
}

const files = fs.readdirSync(leveldbDir);
console.log("LevelDB files in localhost:5174:", files);

for (const f of files) {
  const filePath = path.join(leveldbDir, f);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) continue;

  try {
    const data = fs.readFileSync(filePath);
    // Find strings like 'Hololive' (UTF-8 or UTF-16)
    let idx = -1;
    const searchBuf = Buffer.from('Hololive');
    
    while ((idx = data.indexOf(searchBuf, idx + 1)) !== -1) {
      console.log(`\nFound 'Hololive' in file: ${f} at index: ${idx}`);
      // Print surrounding bytes
      const slice = data.slice(Math.max(0, idx - 100), Math.min(data.length, idx + 300));
      console.log(slice.toString('ascii').replace(/[^\x20-\x7E]/g, '.'));
    }
  } catch (e) {
    console.error(`Error reading ${f}:`, e.message);
  }
}
