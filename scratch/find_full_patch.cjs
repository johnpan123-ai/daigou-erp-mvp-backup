const fs = require('fs');
const content = fs.readFileSync('apply_full_patch.js', 'utf8');

const startTarget = "const filePath = path.join(__dirname, 'src', 'pages', 'PurchaseRecords.tsx');";
const endTarget = "console.log(\"Successfully patched PurchaseRecords.tsx!\");";

const startIdx = content.indexOf(startTarget);
const endIdx = content.indexOf(endTarget);

if (startIdx !== -1 && endIdx !== -1) {
  const patchContent = content.substring(startIdx - 100, endIdx + endTarget.length + 10);
  fs.writeFileSync('scratch/extracted_patch_records.js', patchContent, 'utf8');
  console.log("Extracted patch to scratch/extracted_patch_records.js successfully!");
} else {
  console.error("Could not find start or end target!");
}
