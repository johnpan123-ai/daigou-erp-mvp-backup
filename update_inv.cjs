const fs = require('fs');
let content = fs.readFileSync('src/pages/Inventory.tsx', 'utf8');

const searchBlock = `      const parsedItems = await parseMyAcgFile(file);
      const stats = await db.upsertInventory(parsedItems);
      await loadItems();
      
      const report = \`本次匯入結果：\\n- SKU 總筆數：\${stats.total}\\n- 新增 SKU：\${stats.newCount}\\n- 更新 SKU：\${stats.updatedCount}\\n- 跳過 SKU：\${stats.unchangedCount}\\n- 母體賣場數：\${stats.groupCount}\`;`;

const replaceBlock = `      const parsedItems = await parseMyAcgFile(file);
      const stats = await db.upsertInventory(parsedItems);
      
      // Sync ProductGroups with new inventory
      const syncStats = await db.syncProductGroupsWithInventory();
      await loadItems();
      
      const report = \`本次匯入結果：\\n- SKU 總筆數：\${stats.total}\\n- 新增 SKU：\${stats.newCount}\\n- 更新 SKU：\${stats.updatedCount}\\n- 補齊既有訂購紀錄 SKU：\${syncStats.filledVariantsCount}\\n- 受影響 ProductGroup：\${syncStats.affectedGroupsCount}\`;`;

content = content.replace(searchBlock, replaceBlock);
fs.writeFileSync('src/pages/Inventory.tsx', content, 'utf8');
console.log('Inventory updated');
