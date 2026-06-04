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
    if (line.includes('signInWithPassword') || line.includes('signUp') || line.includes('@gmail.com') || line.includes('@example.com')) {
      const parsed = JSON.parse(line);
      const str = JSON.stringify(parsed);
      
      // Filter out code writing steps to find execution outputs or planning
      if (parsed.type === 'USER_INPUT' || parsed.type === 'PLANNER_RESPONSE' || (parsed.type === 'RUN_COMMAND' && parsed.status === 'DONE')) {
        console.log(`Step ${parsed.step_index} (${parsed.type}):`);
        console.log(str.substring(0, 1500));
        console.log('--------------------------------------------------');
      }
    }
  }
}

search();
