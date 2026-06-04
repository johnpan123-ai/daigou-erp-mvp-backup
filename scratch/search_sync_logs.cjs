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
    if (line.includes('[Sync]') || line.includes('[Sync Push]') || line.includes('product_variants')) {
      const parsed = JSON.parse(line);
      const str = JSON.stringify(parsed);
      
      // Look for execution outputs or console prints
      if (parsed.type === 'RUN_COMMAND' && parsed.status === 'DONE') {
        const content = parsed.content || '';
        if (content.includes('[Sync') || content.includes('product_variants')) {
          console.log(`Step ${parsed.step_index} (${parsed.type}):`);
          console.log(content.substring(0, 1500));
          console.log('--------------------------------------------------');
        }
      } else if (parsed.type === 'USER_INPUT') {
        console.log(`Step ${parsed.step_index} (USER_INPUT):`);
        console.log(parsed.content);
        console.log('--------------------------------------------------');
      }
    }
  }
}

search();
