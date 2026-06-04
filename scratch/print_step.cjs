const fs = require('fs');
const readline = require('readline');

const path = 'C:/Users/小河馬/.gemini/antigravity/brain/4b09ad1d-184d-4c5b-9022-a60d7ad0d415/.system_generated/logs/transcript.jsonl';

async function search() {
  const fileStream = fs.createReadStream(path);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const parsed = JSON.parse(line);
    if (parsed.step_index === 9398 || parsed.step_index === 9397 || parsed.step_index === 9399 || parsed.step_index === 9396) {
      console.log(`Step ${parsed.step_index} (${parsed.type}):`);
      console.log(JSON.stringify(parsed, null, 2).substring(0, 1500));
      console.log('--------------------------------------------------');
    }
  }
}

search();
