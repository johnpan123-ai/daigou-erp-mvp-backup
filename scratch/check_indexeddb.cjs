const fs = require('fs');
const path = require('path');

const idbDir = path.join(
  process.env.USERPROFILE,
  'AppData',
  'Local',
  'Google',
  'Chrome',
  'User Data',
  'Default',
  'IndexedDB'
);

if (fs.existsSync(idbDir)) {
  console.log("Chrome Default IndexedDB directory exists!");
  const files = fs.readdirSync(idbDir);
  console.log("Directories:", files);
  
  // Recursively list files
  files.forEach(f => {
    const fullPath = path.join(idbDir, f);
    if (fs.statSync(fullPath).isDirectory()) {
      console.log(`\nDir: ${f}`);
      console.log(fs.readdirSync(fullPath));
    }
  });
} else {
  console.log("Chrome Default IndexedDB directory does not exist at:", idbDir);
}
