const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'src', 'pages', 'PurchaseManagement.tsx');
if (!fs.existsSync(targetFile)) {
  console.error("File not found: " + targetFile);
  process.exit(1);
}

let content = fs.readFileSync(targetFile, 'utf8');

// Target snippet to replace (Category Card inside worksheet table row):
// <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>¥ {price}</td>
// We want to replace it with:
// <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
//   {getLatestJpyCost(v.id) !== null ? `¥ ${getLatestJpyCost(v.id)}` : '-'}
// </td>

// To make it very precise and unique, let's search for:
// <td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>¥ {price}</td>
// inside Category Card block.
// Note that Category Card row has rendering of name:
// parsedVariantsMap.get(v.id)?.variantDisplayName

const oldSnippet = `<td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>¥ {price}</td>`;
const newSnippet = `<td style={{ padding: '12px', textAlign: 'right', fontSize: '14px', fontWeight: 600, color: '#334155' }}>
                                    {getLatestJpyCost(v.id) !== null ? \`¥ \${getLatestJpyCost(v.id)}\` : '-'}
                                  </td>`;

// We find the index of this snippet *after* line 1100 (which is after Category card starts)
const index = content.indexOf(oldSnippet, content.indexOf('parsedVariantsMap.get(v.id)?.variantDisplayName'));
if (index === -1) {
  console.error("Could not find the target oldSnippet in PurchaseManagement.tsx");
  process.exit(1);
}

content = content.substring(0, index) + newSnippet + content.substring(index + oldSnippet.length);
fs.writeFileSync(targetFile, content, 'utf8');
console.log("Successfully replaced Category Card price rendering in PurchaseManagement.tsx");
