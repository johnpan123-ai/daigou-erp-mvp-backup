const fs = require('fs');

let code = fs.readFileSync('src/lib/db.ts', 'utf8');

const searchAdapter = 'reparseProductTitles(): Promise<void>;';
const replaceAdapter = searchAdapter + '\n  syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }>;';
code = code.replace(searchAdapter, replaceAdapter);

const searchClass = 'async reparseProductTitles(): Promise<void> {';
const insertClass = `
  async syncProductGroupsWithInventory(): Promise<{ filledVariantsCount: number, affectedGroupsCount: number }> {
    const allInventory = await this.getInventory();
    const groups = await this.getProductGroups();
    const variants = await this.getProductVariants();
    let categories = await this.getProductCategories();

    let filledVariantsCount = 0;
    let affectedGroupsCount = 0;
    let anyGroupChanged = false;

    for (const group of groups) {
      const groupNormTitle = group.normalized_title || normalizeProductTitle(group.title);
      const groupTitle = group.title;

      const matchingItems = allInventory.filter(item => {
        const itemNorm = item.normalized_product_title || normalizeProductTitle(item.product_title);
        if (groupNormTitle && itemNorm) {
            return groupNormTitle === itemNorm;
        }
        return item.product_title === groupTitle;
      });

      if (matchingItems.length === 0) continue;

      const existingVariants = variants.filter(v => v.product_group_id === group.id || 
         (v.product_category_id && categories.some(c => c.id === v.product_category_id && c.product_group_id === group.id)));
      const existingCodes = new Set(existingVariants.map(v => v.myacg_item_code));

      const missingItems = matchingItems.filter(item => !existingCodes.has(item.myacg_item_code));
      
      if (missingItems.length > 0) {
        affectedGroupsCount++;
        anyGroupChanged = true;
        
        const rawNames = matchingItems.map(i => i.raw_variant_name || '');
        const resolved = resolveMyacgSpecs(rawNames);

        for (const item of missingItems) {
            const spec = resolved[item.raw_variant_name || ''];
            let catId = undefined;
            
            if (spec && spec.category_label) {
                let cat = categories.find(c => c.product_group_id === group.id && c.title === spec.category_label);
                if (!cat) {
                    cat = {
                        id: crypto.randomUUID(),
                        product_group_id: group.id,
                        title: spec.category_label,
                        sort_order: categories.filter(c => c.product_group_id === group.id).length
                    };
                    categories.push(cat);
                }
                catId = cat.id;
            }

            const newVariant = {
                id: crypto.randomUUID(),
                product_group_id: group.id,
                product_category_id: catId,
                myacg_item_code: item.myacg_item_code,
                product_title: item.product_title,
                variant_name: spec ? spec.variant_label : (item.raw_variant_name || ''),
                myacg_auto_quantity: 0,
                note: '',
                sort_order: 9999
            };
            variants.push(newVariant);
            filledVariantsCount++;
        }

        for (const item of matchingItems) {
            if (missingItems.includes(item)) continue; 
            
            const existingVar = variants.find(v => v.myacg_item_code === item.myacg_item_code);
            if (existingVar) {
                const spec = resolved[item.raw_variant_name || ''];
                if (spec && spec.category_label) {
                    let cat = categories.find(c => c.product_group_id === group.id && c.title === spec.category_label);
                    if (!cat) {
                        cat = {
                            id: crypto.randomUUID(),
                            product_group_id: group.id,
                            title: spec.category_label,
                            sort_order: categories.filter(c => c.product_group_id === group.id).length
                        };
                        categories.push(cat);
                    }
                    existingVar.product_category_id = cat.id;
                    existingVar.variant_name = spec.variant_label;
                } else if (spec) {
                    existingVar.product_category_id = undefined;
                    existingVar.variant_name = spec.variant_label;
                }
            }
        }
      }
    }

    if (anyGroupChanged) {
        await this.saveProductCategories(categories);
        await this.saveProductVariants(variants);
    }

    return { filledVariantsCount, affectedGroupsCount };
  }
`;

code = code.replace(searchClass, insertClass + '\n  ' + searchClass);
fs.writeFileSync('src/lib/db.ts', code, 'utf8');
console.log('db.ts updated');
