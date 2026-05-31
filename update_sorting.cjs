const fs = require('fs');

// 1. Update myacgParser.ts
let parserCode = fs.readFileSync('src/utils/myacgParser.ts', 'utf8');
parserCode = parserCode.replace(
  "myacg_listed_at: rowData['刊登時間'] || '',",
  "myacg_listed_at: rowData['刊登時間'] || '',\n        import_sort_index: index,"
);
parserCode = parserCode.replace(
  "const items: InventoryItem[] = jsonData.map(rowData => ({",
  "const items: InventoryItem[] = jsonData.map((rowData, index) => ({"
);
parserCode = parserCode.replace(
  "myacg_listed_at: String(rowData['刊登時間'] || ''),",
  "myacg_listed_at: String(rowData['刊登時間'] || ''),\n          import_sort_index: index,"
);
fs.writeFileSync('src/utils/myacgParser.ts', parserCode, 'utf8');


// 2. Update db.ts
let dbCode = fs.readFileSync('src/lib/db.ts', 'utf8');

// Add import_sort_index to InventoryItem
dbCode = dbCode.replace(
  "export interface InventoryItem {",
  "export interface InventoryItem {\n  import_sort_index?: number;"
);

// Update createPurchaseRecordFromInventory
const oldCreate = `            const newVariant: ProductVariant = {
              id: crypto.randomUUID(),
              product_group_id: group.id,
              product_category_id: catId,
              myacg_item_code: item.myacg_item_code,
              product_title: item.product_title,
              variant_name: spec ? spec.variant_label : (item.raw_variant_name || ''),
              myacg_auto_quantity: 0,
              note: '',
              sort_order: 9999
            };`;
const newCreate = `            const newVariant: ProductVariant = {
              id: crypto.randomUUID(),
              product_group_id: group.id,
              product_category_id: catId,
              myacg_item_code: item.myacg_item_code,
              product_title: item.product_title,
              variant_name: spec ? spec.variant_label : (item.raw_variant_name || ''),
              myacg_auto_quantity: 0,
              note: '',
              sort_order: item.import_sort_index ?? 9999
            };`;
dbCode = dbCode.replace(oldCreate, newCreate);

// At the end of the group loop in createPurchaseRecordFromInventory, we should also update category sort_order.
// We can just add it before the end of the loop over titles.
const oldEndGroup = `    }

    if (groupsUpdated) await this.saveProductGroups(groups);
`;
const newEndGroup = `
      // Update Category sort_order for this group
      for (const cat of categories.filter(c => c.product_group_id === group.id)) {
        const variantsInCat = variants.filter(v => v.product_group_id === group.id && v.product_category_id === cat.id);
        let minSort = 9999;
        for (const v of variantsInCat) {
            const invItem = targetItems.find(i => i.myacg_item_code === v.myacg_item_code);
            const vSort = (invItem?.import_sort_index ?? v.sort_order ?? 9999);
            if (vSort < minSort) minSort = vSort;
        }
        cat.sort_order = minSort;
      }
    }

    if (groupsUpdated) await this.saveProductGroups(groups);
`;
dbCode = dbCode.replace(oldEndGroup, newEndGroup);

// Update syncProductGroupsWithInventory
const oldSyncMissing = `            const newVariant = {
                id: crypto.randomUUID(),
                product_group_id: group.id,
                product_category_id: catId,
                myacg_item_code: item.myacg_item_code,
                product_title: item.product_title,
                variant_name: spec ? spec.variant_label : (item.raw_variant_name || ''),
                myacg_auto_quantity: 0,
                note: '',
                sort_order: 9999
            };`;
const newSyncMissing = `            const newVariant = {
                id: crypto.randomUUID(),
                product_group_id: group.id,
                product_category_id: catId,
                myacg_item_code: item.myacg_item_code,
                product_title: item.product_title,
                variant_name: spec ? spec.variant_label : (item.raw_variant_name || ''),
                myacg_auto_quantity: 0,
                note: '',
                sort_order: item.import_sort_index ?? 9999
            };`;
dbCode = dbCode.replace(oldSyncMissing, newSyncMissing);

const oldSyncExisting = `                } else if (spec) {
                    existingVar.product_category_id = undefined;
                    existingVar.variant_name = spec.variant_label;
                }
            }
        }`;
const newSyncExisting = `                } else if (spec) {
                    existingVar.product_category_id = undefined;
                    existingVar.variant_name = spec.variant_label;
                }
            }
        }
        
        // Update sort_order for ALL variants in this group based on matchingItems
        for (const item of matchingItems) {
            const existingVar = variants.find(v => v.myacg_item_code === item.myacg_item_code);
            if (existingVar && item.import_sort_index !== undefined) {
                existingVar.sort_order = item.import_sort_index;
            }
        }
        
        // Update category sort_order for this group
        for (const cat of categories.filter(c => c.product_group_id === group.id)) {
            const variantsInCat = variants.filter(v => v.product_group_id === group.id && v.product_category_id === cat.id);
            let minSort = 9999;
            for (const v of variantsInCat) {
                const invItem = matchingItems.find(i => i.myacg_item_code === v.myacg_item_code);
                const vSort = (invItem?.import_sort_index ?? v.sort_order ?? 9999);
                if (vSort < minSort) minSort = vSort;
            }
            cat.sort_order = minSort;
        }
`;
dbCode = dbCode.replace(oldSyncExisting, newSyncExisting);

fs.writeFileSync('src/lib/db.ts', dbCode, 'utf8');

console.log('Parser and DB updated');
