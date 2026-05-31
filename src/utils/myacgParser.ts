import * as XLSX from 'xlsx';
import type { InventoryItem } from '../lib/db';

export async function parseMyAcgFile(file: File): Promise<InventoryItem[]> {
  const text = await file.text();
  
  // Check if it's an HTML "fake excel" file
  if (text.includes('<table') || text.includes('<html')) {
    return parseHtmlTable(text);
  }

  // Otherwise, fallback to proper XLSX parser
  return parseXlsxFile(file);
}

function parseHtmlTable(html: string): InventoryItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const rows = doc.querySelectorAll('tr');
  
  const items: InventoryItem[] = [];
  let headers: string[] = [];

  rows.forEach((row, index) => {
    const cells = Array.from(row.querySelectorAll('th, td')).map(cell => cell.textContent?.trim() || '');
    
    if (index === 0) {
      headers = cells;
      return;
    }

    const rowData = headers.reduce((acc, header, idx) => {
      acc[header] = cells[idx];
      return acc;
    }, {} as Record<string, string>);

    // Ensure we have the minimum required fields
    if (rowData['商品編號'] && rowData['商品名稱']) {
      items.push({
        myacg_item_code: rowData['商品編號'],
        product_id: rowData['商品編號'] || '',
        product_title: rowData['商品名稱'],
        raw_variant_name: rowData['規格/項目'] || '',
        listing_type: rowData['商品種類'] || '',
        final_price: parseInt(rowData['價格']?.replace(/[^0-9]/g, '') || '0', 10),
        myacg_available_quantity: parseInt(rowData['庫存']?.replace(/[^0-9]/g, '') || '0', 10),
        myacg_sold_quantity: parseInt(rowData['已售']?.replace(/[^0-9]/g, '') || '0', 10),
        myacg_listed_at: rowData['刊登時間'] || '',
        import_sort_index: index,
      });
    }
  });

  return items;
}

async function parseXlsxFile(file: File): Promise<InventoryItem[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' }) as any[];
        
        const items: InventoryItem[] = jsonData.map((rowData, index) => ({
          myacg_item_code: String(rowData['商品編號'] || ''),
          product_id: String(rowData['商品編號'] || ''),
          product_title: String(rowData['商品名稱'] || ''),
          raw_variant_name: String(rowData['規格/項目'] || ''),
          listing_type: String(rowData['商品種類'] || ''),
          final_price: parseInt(String(rowData['價格'] || '0').replace(/[^0-9]/g, ''), 10),
          myacg_available_quantity: parseInt(String(rowData['庫存'] || '0').replace(/[^0-9]/g, ''), 10),
          myacg_sold_quantity: parseInt(String(rowData['已售'] || '0').replace(/[^0-9]/g, ''), 10),
          myacg_listed_at: String(rowData['刊登時間'] || ''),
          import_sort_index: index,
        })).filter(item => item.myacg_item_code && item.product_title);
        
        resolve(items);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
}

export interface ParsedMyAcgOrder {
  order_status: string;
  order_no: string;
  buyer_name: string;
  order_date: string;
  item_code: string;
  product_title: string;
  variant_name: string;
  quantity: number;
  price: number;
  amount: number;
}

export async function parseMyAcgOrderFile(file: File): Promise<ParsedMyAcgOrder[]> {
  const text = await file.text();
  const content = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  
  const workbook = XLSX.read(content, { type: 'string' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as string[][];

  if (rows.length < 2) {
    throw new Error('檔案內容格式不正確，找不到標題列');
  }

  // Row 1 (index 1) is headers
  const headers = rows[1].map(h => String(h).trim());

  const items: ParsedMyAcgOrder[] = [];
  
  let lastOrderNo = '';
  let lastOrderDate = '';
  let lastBuyerName = '';

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0 || row.every(c => !c)) continue;
    
    const rowData = headers.reduce((acc, header, idx) => {
      acc[header] = String(row[idx] || '').trim();
      return acc;
    }, {} as Record<string, string>);

    let orderNo = rowData['訂單編號'];
    let orderDate = rowData['訂購日期'];
    let buyerName = rowData['買家編號'] || rowData['收件人姓名'];

    if (!orderNo || orderNo === '--') orderNo = lastOrderNo;
    if (!orderDate || orderDate === '--') orderDate = lastOrderDate;
    if (!buyerName || buyerName === '--') buyerName = lastBuyerName;

    lastOrderNo = orderNo;
    lastOrderDate = orderDate;
    lastBuyerName = buyerName;

    if (rowData['商品編號'] && rowData['商品名稱']) {
      items.push({
        order_status: rowData['撥款狀況'] || '',
        order_no: orderNo,
        buyer_name: buyerName,
        order_date: orderDate,
        item_code: rowData['商品編號'],
        product_title: rowData['商品名稱'],
        variant_name: rowData['規格/項目'] || '',
        quantity: parseInt(rowData['數量']?.replace(/[^0-9]/g, '') || '0', 10),
        price: parseInt(rowData['商品單價']?.replace(/[^0-9]/g, '') || rowData['單價']?.replace(/[^0-9]/g, '') || '0', 10),
        amount: parseInt(rowData['商品金額']?.replace(/[^0-9]/g, '') || '0', 10),
      });
    }
  }

  return items;
}
