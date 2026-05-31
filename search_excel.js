const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const downloadsDir = path.join(process.env.USERPROFILE, 'Downloads');
const file = path.join(downloadsDir, '399375_2026-05-30.xls');

if (!fs.existsSync(file)) {
  console.log("File does not exist:", file);
  process.exit(1);
}

console.log("Reading file:", file);
const workbook = XLSX.readFile(file);
const firstSheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[firstSheetName];
const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

console.log("Total rows in Excel:", jsonData.length);

const targetSku = 'G07073119';
const matchedRows = [];

jsonData.forEach((row, index) => {
  const rowStr = JSON.stringify(row);
  if (rowStr.includes(targetSku) || rowStr.includes('櫻巫女')) {
    matchedRows.push({ index: index + 2, data: row });
  }
});

console.log(`Matched rows count: ${matchedRows.length}`);
console.log(JSON.stringify(matchedRows, null, 2));
