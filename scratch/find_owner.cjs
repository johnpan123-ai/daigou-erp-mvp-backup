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
    try {
      const parsed = JSON.parse(line);
      const str = JSON.stringify(parsed);
      if (str.includes('hippo+owner') || str.includes('hippo+viewer')) {
        // Look for password strings in this line
        const match = str.match(/(?:password|pwd|pass|密碼)["\s:]+([^"\s,}]+)/i);
        if (match) {
          console.log(`Step ${parsed.step_index}: Email with potential password match: ${match[0]}`);
          console.log(`Snippet: ${str.substring(str.indexOf('hippo+owner') - 200, str.indexOf('hippo+owner') + 200)}`);
        }
      }
    } catch (e) {}
  }
}

search();
