const fs = require('fs');
const readline = require('readline');
const path = require('path');

const query = process.argv[2] || 'failed';
console.log(`Searching for "${query}" in scratch/all_sync_logs.txt...`);

const file = path.join(__dirname, 'all_sync_logs.txt');
if (!fs.existsSync(file)) {
  console.log("File not found");
  return;
}

const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');
let count = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.toLowerCase().includes(query.toLowerCase())) {
    console.log(`${i+1}: ${line.trim()}`);
    count++;
    if (count > 50) {
      console.log("Too many results, stopping...");
      break;
    }
  }
}
