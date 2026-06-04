const fs = require('fs');

const logPath = 'C:/Users/小河馬/.gemini/antigravity/scratch/daigou-erp-mvp/scratch/all_sync_logs.txt';
if (!fs.existsSync(logPath)) {
  console.log("Log file does not exist at:", logPath);
  process.exit(1);
}

const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n');

console.log(`Total lines in log: ${lines.length}`);

let matchedCount = 0;
lines.forEach((line, index) => {
  if (line.includes('GP00361307') || line.includes('57')) {
    matchedCount++;
    console.log(`Line ${index + 1}: ${line.trim()}`);
  }
});
console.log(`Total matched lines: ${matchedCount}`);
