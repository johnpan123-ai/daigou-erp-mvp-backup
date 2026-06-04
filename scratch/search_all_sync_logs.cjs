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
    if (lower.includes('[sync') || lower.includes('pullcoreproductdata')) {
      const parsed = JSON.parse(line);
      const content = parsed.content || JSON.stringify(parsed.tool_calls || parsed.args || '');
      
      // Print interesting logs
      if (line.includes('[Sync') || line.includes('pullCoreProductData') || line.includes('product_variants')) {
        console.log(`Step ${parsed.step_index} (${parsed.type}):`);
        console.log(content.substring(0, 1500));
        console.log('--------------------------------------------------');
      }
    }
  }
}

search();
