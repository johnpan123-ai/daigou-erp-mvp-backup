const fs = require('fs');

const code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');
const template = fs.readFileSync('apply_ui_template.txt', 'utf8');

// The original file ends with a lot of JSX, but right before the original `  // KPI Calculations` we have `  const handleUpdatePlatformDemand = async (`
// Wait, the original code had:
//   const [purchaseBatchItems, setPurchaseBatchItems] = useState<PurchaseBatchItem[]>([]);
//   
//   const loadData = async () => {
// ...
//   const handleUpdatePlatformDemand = async (...)
//
// Then it has `  // KPI Calculations` ? No, wait, in my original `PurchaseManagement.tsx`, I didn't have `// KPI Calculations`. I added that in my template.
// I will just find `  const groupedVariants` and slice right above it.
// Actually, wait, let me just find `  const groupedVariants: Record<string, ProductVariant[]> = {};`
// But wait! `apply_ui_template.txt` includes `// KPI Calculations` which was ALSO NOT in the original code, but wait, the original code DID HAVE some calculation in the JSX return. 
// Let's print out what is exactly right before `  const groupedVariants: Record<string, ProductVariant[]> = {};` in the ORIGINAL file.
// Or just let node do it.
const origIdx = code.indexOf('  const groupedVariants: Record<string, ProductVariant[]> = {};');
if (origIdx === -1) {
  console.log("Could not find groupedVariants block");
  process.exit(1);
}

// In original code, `const groupedVariants` is defined. I will just replace from `const groupedVariants` to the end.
// But wait, my template also re-adds `groupedVariants` AND it adds KPI calculations which use `privateOrderItems`.
// Let's just slice from `const groupedVariants`.
const preCode = code.slice(0, origIdx);
const finalCode = preCode + template;
fs.writeFileSync('src/pages/PurchaseManagement.tsx', finalCode, 'utf8');
console.log('UI template applied successfully');
