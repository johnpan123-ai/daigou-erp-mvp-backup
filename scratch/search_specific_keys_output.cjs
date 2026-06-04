const fs = require('fs');

const jsonPath = 'C:/Users/小河馬/.gemini/antigravity/scratch/specific_keys.json';
const content = fs.readFileSync(jsonPath, 'utf8');
const data = JSON.parse(content);

console.log(`Loaded ${data.length} keys.`);

data.forEach((item, index) => {
  const k8 = item.key8 || '';
  const k16 = item.key16 || '';
  
  if (k8.includes('token') || k8.includes('auth') || k8.includes('session') || k8.includes('sb-')) {
    console.log(`Match ${index + 1}:`);
    console.log(`  Key8: "${k8}"`);
    console.log(`  Val type: ${typeof item.val}`);
    if (item.val && typeof item.val === 'object') {
      console.log(`  Val keys:`, Object.keys(item.val));
      if (item.val.access_token) {
        console.log(`  Access Token: ${item.val.access_token.substring(0, 30)}...`);
        console.log(`  Refresh Token: ${item.val.refresh_token}`);
        console.log(`  User:`, item.val.user?.email);
      }
    } else {
      console.log(`  Val snippet:`, String(item.val).substring(0, 200));
    }
  }
});
