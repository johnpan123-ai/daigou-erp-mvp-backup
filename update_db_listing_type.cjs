const fs = require('fs');
let code = fs.readFileSync('src/lib/db.ts', 'utf8');

const oldFunc = `export function determineListingType(title: string): string {
  if (title.includes('代理版')) return '代理版';
  if (title.includes('現貨')) return '現貨';
  if (title.includes('現地代購')) return '現地代購';
  return '一般預購';
}`;

const newFunc = `export function determineListingType(title: string): string {
  if (!title) return '一般預購';
  if (title.includes('代理版') || title.includes('代理')) return '代理版';
  if (title.includes('現貨')) return '現貨';
  if (title.includes('現地代購')) return '現地代購';
  if (title.includes('日本代購')) return '日本代購';
  return '一般預購';
}`;

code = code.replace(oldFunc, newFunc);
fs.writeFileSync('src/lib/db.ts', code, 'utf8');
console.log('Updated db.ts listing type logic');
