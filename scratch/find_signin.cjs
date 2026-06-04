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
    if (line.includes('signInWithPassword') && line.includes('email')) {
      const parsed = JSON.parse(line);
      console.log(`Step ${parsed.step_index}:`);
      console.log(JSON.stringify(parsed.content || parsed.tool_calls || parsed.args).substring(0, 1000));
    }
  }
}

search();
