const fs = require('fs');
const path = require('path');

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

if (fs.existsSync(edgeLsDir)) {
  console.log("Edge Local Storage directory exists!");
  const files = fs.readdirSync(edgeLsDir);
  console.log("Files:", files);
} else {
  console.log("Edge Local Storage directory does not exist at:", edgeLsDir);
}
