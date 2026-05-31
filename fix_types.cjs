const fs = require('fs');
let code = fs.readFileSync('src/pages/PurchaseManagement.tsx', 'utf8');

// 1. Fix types for RenderSkuRow
const oldFunc = `const RenderSkuRow = ({ v, inv, title, searchTerm, isSingle, isEditMode, editDrafts, handleDraftChange, privateOrderItems, purchaseBatchItems, group }) => {`;
const newFunc = `const RenderSkuRow = ({ v, inv, title, searchTerm, isSingle, isEditMode, editDrafts, handleDraftChange, privateOrderItems, purchaseBatchItems, group }: {
  v: ProductVariant,
  inv: InventoryItem | undefined,
  title: string,
  searchTerm: string,
  isSingle: boolean,
  isEditMode: boolean,
  editDrafts: Record<string, {m: number, w: number, p: number, pu: number}>,
  handleDraftChange: (id: string, field: 'm'|'w'|'p'|'pu', val: number) => void,
  privateOrderItems: PrivateOrderItem[],
  purchaseBatchItems: PurchaseBatchItem[],
  group: ProductGroup
}) => {`;
code = code.replace(oldFunc, newFunc);

// 2. Remove handleUpdatePlatformDemand
const startIdx = code.indexOf('const handleUpdatePlatformDemand');
if (startIdx !== -1) {
  const endIdx = code.indexOf('};', startIdx) + 2;
  code = code.substring(0, startIdx) + code.substring(endIdx);
}

// 3. Remove unused Edit2 import
code = code.replace('ShoppingCart, DollarSign, Edit2', 'ShoppingCart, DollarSign');

fs.writeFileSync('src/pages/PurchaseManagement.tsx', code, 'utf8');
console.log("Types fixed.");
