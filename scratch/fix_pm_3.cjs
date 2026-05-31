const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'src', 'pages', 'PurchaseManagement.tsx');
let content = fs.readFileSync(targetFile, 'utf8');

// 1. Remove single item card inv declaration
const singleInvStr = "const inv = inventoryMap.get(v.myacg_item_code);";
content = content.replace(singleInvStr, "");

// 2. Remove category card rows inv declaration
// Look for the block matching inv search logic:
const categoryInvPattern = /const inv = Array\.from\(inventoryMap\.values\(\)\)\.find\(item =>\s*item\.myacg_item_code === v\.myacg_item_code \|\|\s*\(getBaseSku\(item\.myacg_item_code\) === getBaseSku\(v\.myacg_item_code\) &&\s*\(item\.myacg_item_code === getBaseSku\(item\.myacg_item_code\) \|\| v\.myacg_item_code === getBaseSku\(v\.myacg_item_code\)\)\)\s*\);/;

if (categoryInvPattern.test(content)) {
  content = content.replace(categoryInvPattern, "");
  console.log("Successfully matched and removed category inv variable.");
} else {
  console.error("Could not find category inv variable declaration using pattern.");
}

fs.writeFileSync(targetFile, content, 'utf8');
console.log("Completed variables cleanup script execution.");
