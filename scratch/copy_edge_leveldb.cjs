const fs = require('fs');
const path = require('path');

const edgeDir = path.join(
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

const tempDir = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'scratch',
  'leveldb_edge_temp'
);

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

if (!fs.existsSync(edgeDir)) {
  console.error("Edge LevelDB directory does not exist:", edgeDir);
  process.exit(1);
}

const files = fs.readdirSync(edgeDir);
console.log("Found edge leveldb files:", files);

files.forEach(f => {
  const src = path.join(edgeDir, f);
  const dest = path.join(tempDir, f);
  try {
    const stat = fs.statSync(src);
    if (stat.isFile()) {
      fs.copyFileSync(src, dest);
      console.log(`Copied ${f}`);
    }
  } catch (e) {
    console.warn(`Could not copy ${f}:`, e.message);
  }
});
console.log("Copy complete!");
