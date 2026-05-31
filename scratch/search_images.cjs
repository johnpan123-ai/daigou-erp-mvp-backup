const fs = require('fs');
const readline = require('readline');

const logPath = "C:\\Users\\小河馬\\.gemini\\antigravity\\brain\\4b09ad1d-184d-4c5b-9022-a60d7ad0d415\\.system_generated\\logs\\transcript.jsonl";

if (!fs.existsSync(logPath)) {
  console.error("Log file does not exist at path: " + logPath);
  process.exit(1);
}

const rl = readline.createInterface({
  input: fs.createReadStream(logPath),
  crlfDelay: Infinity
});

let lineNum = 0;
rl.on('line', (line) => {
  lineNum++;
  try {
    const data = JSON.parse(line);
    const toolCalls = data.tool_calls || [];
    
    const hasGenImage = toolCalls.some(tc => tc.name === 'default_api:generate_image' || tc.name?.includes('generate_image'));
    if (hasGenImage) {
      console.log(`[Line ${lineNum} Step ${data.step_index}] tool: generate_image`);
      console.log(JSON.stringify(toolCalls, null, 2));
      console.log("-----------------------------------------");
    }
  } catch (e) {
    // ignore
  }
});
