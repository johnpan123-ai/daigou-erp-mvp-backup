const fs = require('fs');
const readline = require('readline');

const path = 'C:/Users/小河馬/.gemini/antigravity/brain/4b09ad1d-184d-4c5b-9022-a60d7ad0d415/.system_generated/logs/transcript.jsonl';
const targetStep = parseInt(process.argv[2]) || 8434;

async function search() {
  const fileStream = fs.createReadStream(path);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const parsed = JSON.parse(line);
    if (parsed.step_index === targetStep) {
      console.log(`=== Step ${targetStep} ===`);
      console.log(JSON.stringify(parsed, null, 2));
      break;
    }
  }
}

search();
