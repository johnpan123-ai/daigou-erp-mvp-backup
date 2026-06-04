const fs = require('fs');
const path = require('path');
const readline = require('readline');

const logPath = path.join(
  process.env.USERPROFILE,
  '.gemini',
  'antigravity',
  'brain',
  '4b09ad1d-184d-4c5b-9022-a60d7ad0d415',
  '.system_generated',
  'logs',
  'transcript.jsonl'
);

if (!fs.existsSync(logPath)) {
  console.log(`Log file not found at: ${logPath}`);
  process.exit(1);
}

const fileStream = fs.createReadStream(logPath);
const rl = readline.createInterface({
  input: fileStream,
  crlfDelay: Infinity
});

let lineNum = 0;
rl.on('line', (line) => {
  lineNum++;
  try {
    const obj = JSON.parse(line);
    const content = JSON.stringify(obj.content || '');
    if (content.toLowerCase().includes('temp') || content.toLowerCase().includes('uuid') || content.toLowerCase().includes('local_id') || content.toLowerCase().includes('skipped')) {
      console.log(`Line ${lineNum} (${obj.type}):`);
      console.log(`  ${content.substring(0, 300)}...`);
    }
  } catch (e) {
    // ignore malformed JSON
  }
});
rl.on('close', () => {
  console.log('Finished reading transcript.');
});
