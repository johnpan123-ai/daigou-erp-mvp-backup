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
        listing_type: rowData['商品類型'] || '',
        final_price: parseInt(rowData['價格']?.replace(/[^0-9]/g, '') || '0', 10),
        myacg_available_quantity: parseInt(rowData['庫存']?.replace(/[^0-9]/g, '') || '0', 10),
        myacg_sold_quantity: parseInt(rowData['已售']?.replace(/[^0-9]/g, '') || '0', 10),
        myacg_listed_at: rowData['刊登時間'] || '',
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
        
        const items: InventoryItem[] = jsonData.map(rowData => ({
          myacg_item_code: String(rowData['商品編號'] || ''),
          product_id: String(rowData['商品編號'] || ''),
          product_title: String(rowData['商品名稱'] || ''),
          raw_variant_name: String(rowData['規格/項目'] || ''),
          listing_type: String(rowData['商品類型'] || ''),
          final_price: parseInt(String(rowData['價格'] || '0').replace(/[^0-9]/g, ''), 10),
          myacg_available_quantity: parseInt(String(rowData['庫存'] || '0').replace(/[^0-9]/g, ''), 10),
          myacg_sold_quantity: parseInt(String(rowData['已售'] || '0').replace(/[^0-9]/g, ''), 10),
          myacg_listed_at: String(rowData['刊登時間'] || ''),
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
