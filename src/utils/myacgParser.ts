import * as XLSX from 'xlsx';
import type { InventoryItem } from '../lib/db';

const getSoldQty = (rowData: any) => {
  const normKeys = Object.keys(rowData).map(k => ({
    original: k,
    normalized: k.replace(/[\s\u00a0\u200b\/]+/g, '')
  }));
  const keys = [
    '已售', '已售數量', '售出數量', '售出', '銷售', '銷售數量', 
    '總銷售數量', '總銷售已售數量', '總銷售'
  ];
  for (const k of keys) {
    const match = normKeys.find(nk => nk.normalized === k);
    if (match) {
      const val = rowData[match.original];
      if (val !== undefined && val !== null && val !== '') {
        return parseInt(String(val).replace(/[^0-9]/g, '') || '0', 10);
      }
    }
  }
  return 0;
};

const getAvailableQty = (rowData: any) => {
  const normKeys = Object.keys(rowData).map(k => ({
    original: k,
    normalized: k.replace(/[\s\u00a0\u200b\/]+/g, '')
  }));
  const keys = ['庫存', '庫存數量', '可用數量', '剩餘數量', '庫存可用數量', '可用'];
  for (const k of keys) {
    const match = normKeys.find(nk => nk.normalized === k);
    if (match) {
      const val = rowData[match.original];
      if (val !== undefined && val !== null && val !== '') {
        return parseInt(String(val).replace(/[^0-9]/g, '') || '0', 10);
      }
    }
  }
  return 0;
};

const getDemandQty = (rowData: any) => {
  const normKeys = Object.keys(rowData).map(k => ({
    original: k,
    normalized: k.replace(/[\s\u00a0\u200b\/]+/g, '')
  }));
  const keys = ['需求', '需求數量', '買動漫需求', '平台需求'];
  for (const k of keys) {
    const match = normKeys.find(nk => nk.normalized === k);
    if (match) {
      const val = rowData[match.original];
      if (val !== undefined && val !== null && val !== '') {
        return parseInt(String(val).replace(/[^0-9]/g, '') || '0', 10);
      }
    }
  }
  return 0;
};

const getValueByKeys = (rowData: any, keys: string[]): string => {
  const normKeys = Object.keys(rowData).map(k => ({
    original: k,
    normalized: k.replace(/[\s\u00a0\u200b\/]+/g, '')
  }));
  const cleanKeys = keys.map(k => k.replace(/[\s\u00a0\u200b\/]+/g, ''));
  for (const cleanKey of cleanKeys) {
    const match = normKeys.find(nk => nk.normalized === cleanKey);
    if (match) {
      const val = rowData[match.original];
      if (val !== undefined && val !== null && val !== '') {
        return String(val).trim();
      }
    }
  }
  return '';
};

const codeKeys = [
  '子編號(商品編號)',
  '子編號',
  '商品編號',
  '商品代碼',
  '商品序號',
  '商品代號',
  '商品ID',
  'SKU'
];
const parentCodeKeys = [
  '主編號(多規格編號)',
  '主編號'
];
const titleKeys = ['商品名稱', '名稱', '標題'];
const specKeys = ['規格項目', '規格', '項目', '規格項目'];
const typeKeys = ['商品種類', '種類', '商品類型', '類型'];
const priceKeys = ['價格', '單價', '售價', '價格單價'];
const listedKeys = ['刊登時間', '上架時間', '刊登日期'];

export async function parseMyAcgFile(file: File): Promise<InventoryItem[]> {
  const text = await file.text();
  
  // Check if it's an HTML "fake excel" file
  if (text.includes('<table') || text.includes('<html')) {
    return parseHtmlTable(text);
  }

  // Otherwise, fallback to proper XLSX parser
  return parseXlsxFile(file);
}

const normalizeRowKey = (key: string): string => {
  return String(key).replace(/[\s\u00a0\u200b]+/g, ' ').trim();
};

function parseHtmlTable(html: string): InventoryItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const rows = doc.querySelectorAll('tr');
  
  const items: InventoryItem[] = [];
  let headers: string[] = [];

  rows.forEach((row, index) => {
    const cells = Array.from(row.querySelectorAll('th, td')).map(cell => cell.textContent?.replace(/[\s\u00a0\u200b]+/g, ' ').trim() || '');
    
    if (index === 0) {
      headers = cells;
      return;
    }

    const rowData = headers.reduce((acc, header, idx) => {
      acc[header] = cells[idx];
      return acc;
    }, {} as Record<string, string>);

    const code = getValueByKeys(rowData, codeKeys);
    const title = getValueByKeys(rowData, titleKeys);

    // Ensure we have the minimum required fields
    if (code && title) {
      items.push({
        myacg_item_code: code,
        myacg_parent_code: getValueByKeys(rowData, parentCodeKeys) || undefined,
        product_id: code,
        product_title: title,
        raw_variant_name: getValueByKeys(rowData, specKeys),
        listing_type: getValueByKeys(rowData, typeKeys),
        final_price: parseInt(getValueByKeys(rowData, priceKeys).replace(/[^0-9]/g, '') || '0', 10),
        myacg_available_quantity: getAvailableQty(rowData),
        myacg_sold_quantity: getSoldQty(rowData),
        myacg_demand_quantity: getDemandQty(rowData),
        myacg_listed_at: getValueByKeys(rowData, listedKeys),
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
        
        const items: InventoryItem[] = jsonData.map((rawRow, index) => {
          const rowData: any = {};
          for (const key of Object.keys(rawRow)) {
            const normKey = normalizeRowKey(key);
            rowData[normKey] = rawRow[key];
          }

          const code = getValueByKeys(rowData, codeKeys);
          const title = getValueByKeys(rowData, titleKeys);

          return {
            myacg_item_code: code,
            myacg_parent_code: getValueByKeys(rowData, parentCodeKeys) || undefined,
            product_id: code,
            product_title: title,
            raw_variant_name: getValueByKeys(rowData, specKeys),
            listing_type: getValueByKeys(rowData, typeKeys),
            final_price: parseInt(getValueByKeys(rowData, priceKeys).replace(/[^0-9]/g, '') || '0', 10),
            myacg_available_quantity: getAvailableQty(rowData),
            myacg_sold_quantity: getSoldQty(rowData),
            myacg_demand_quantity: getDemandQty(rowData),
            myacg_listed_at: getValueByKeys(rowData, listedKeys),
            import_sort_index: index,
          };
        }).filter(item => item.myacg_item_code && item.product_title);
        
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
