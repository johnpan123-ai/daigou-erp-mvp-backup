const fs = require('fs');
const readline = require('readline');

const path = 'C:/Users/小河馬/.gemini/antigravity/brain/4b09ad1d-184d-4c5b-9022-a60d7ad0d415/.system_generated/logs/transcript.jsonl';

async function search() {
  const fileStream = fs.createReadStream(path);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let count = 0;
  for await (const line of rl) {
    if (line.includes('hippo+owner') || line.includes('signInWithPassword') || line.includes('signUp')) {
      // Find strings near email that might contain password
      if (line.includes('password') || line.includes('123')) {
        console.log(`Line matches: ${line.substring(0, 1000)}...`);
        count++;
        if (count > 20) break;
      }
    }
  }
}

search();
