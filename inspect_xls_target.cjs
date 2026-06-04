const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const downloadsDir = 'C:/Users/小河馬/Downloads';
const files = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.xls') || f.endsWith('.xlsx'));

console.log("Found Excel files:", files);

files.forEach(f => {
  const fullPath = path.join(downloadsDir, f);
  try {
    const workbook = XLSX.readFile(fullPath);
    console.log(`\nFile: ${f}`);
    
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      
      let matchedRows = 0;
      let sheetSum = 0;
      
      rows.forEach((row, idx) => {
        const rowStr = JSON.stringify(row);
        if (rowStr.includes('GP00361307') || rowStr.includes('應援毛巾')) {
          matchedRows++;
          console.log(`  Row ${idx+1}: ${row.slice(0, 12).join(' | ')}`);
          
          // Let's try to extract quantity if it's there
          // Usually quantity index in MyACG sales order is 7
          const qty = parseInt(row[7]);
          if (!isNaN(qty)) {
            sheetSum += qty;
          }
        }
      });
      if (matchedRows > 0) {
        console.log(`  Sheet "${sheetName}": Matched ${matchedRows} rows, Est Sum Qty: ${sheetSum}`);
      }
    });
  } catch(e) {
    console.error(`Error reading ${f}: ${e.message}`);
  }
});
