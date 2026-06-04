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
    const lower = line.toLowerCase();
    if (lower.includes('password') || lower.includes('pwd') || lower.includes('pass') || lower.includes('密碼')) {
      // Print the line if it is from USER_INPUT or has email
      if (line.includes('USER_INPUT') || line.includes('@example.com') || line.includes('@gmail.com') || line.includes('signIn') || line.includes('signUp')) {
        console.log(`Match: ${line.substring(0, 1000)}...`);
      }
    }
  }
}

search();
