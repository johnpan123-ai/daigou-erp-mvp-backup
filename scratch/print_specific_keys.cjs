const fs = require('fs');

const jsonPath = 'C:/Users/小河馬/.gemini/antigravity/scratch/specific_keys.json';
const content = fs.readFileSync(jsonPath, 'utf8');
const data = JSON.parse(content);

data.forEach((item, index) => {
  console.log(`Key ${index + 1}:`);
  console.log(`  Key8: "${item.key8}"`);
  console.log(`  Key16: "${item.key16}"`);
  console.log(`  Val Type: ${typeof item.val}`);
  if (item.val && typeof item.val === 'object') {
    console.log(`  Val length/keys:`, Array.isArray(item.val) ? item.val.length : Object.keys(item.val));
  } else {
    console.log(`  Val snippet:`, String(item.val).substring(0, 100));
  }
});
