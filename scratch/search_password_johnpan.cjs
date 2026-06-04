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
    if (line.includes('johnpan123@gmail.com')) {
      const parsed = JSON.parse(line);
      console.log(`Step ${parsed.step_index} (${parsed.type}):`);
      // We will print the entire content or args or thinking
      if (parsed.content) console.log(`  Content:`, parsed.content.substring(0, 1000));
      if (parsed.tool_calls) console.log(`  Tool Calls:`, JSON.stringify(parsed.tool_calls, null, 2));
      if (parsed.thinking) console.log(`  Thinking:`, parsed.thinking.substring(0, 1000));
      console.log('--------------------------------------------------');
    }
  }
}

search();
