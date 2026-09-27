import * as XLSX from 'xlsx';
import type { WacaRow } from './orderCore';

const required = [
  '訂單狀態', '訂單編號', '購買日期', '商品編號', '品名',
  '多規格名稱一', '多規格名稱二', '規格編號', '訂單商品數量', '小計',
] as const;

const cell = (value: unknown): string => String(value ?? '').trim();
const numeric = (value: unknown): number => {
  const text = cell(value).replace(/,/gu, '');
  return text ? Number(text) : Number.NaN;
};

export interface WacaWorkbookParse {
  rows: WacaRow[];
  sourceRowCount: number;
  columns: string[];
}

/** WACA exports have a grouped top header and their field names on row two. */
export function parseWacaWorkbook(bytes: ArrayBuffer | Uint8Array): WacaWorkbookParse {
  const workbook = XLSX.read(bytes, { type: 'array' });
  if (workbook.SheetNames.length !== 1) throw new Error('WACA_SHEET_COUNT_INVALID');
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1, defval: '', raw: false, blankrows: false,
  });
  if (matrix.length < 2) throw new Error('WACA_HEADER_MISSING');
  const fields = matrix[1].map(cell);
  const index = new Map(fields.map((field, at) => [field, at]));
  for (const name of required) if (!index.has(name)) throw new Error(`WACA_COLUMN_MISSING:${name}`);
  const at = (row: unknown[], field: typeof required[number]): unknown => row[index.get(field)!];
  const rows = matrix.slice(2).filter(row => row.some(value => cell(value))).map(row => ({
    orderStatus: cell(at(row, '訂單狀態')),
    orderNumber: cell(at(row, '訂單編號')),
    purchasedAt: cell(at(row, '購買日期')),
    productCode: cell(at(row, '商品編號')),
    productTitle: cell(at(row, '品名')),
    spec1: cell(at(row, '多規格名稱一')),
    spec2: cell(at(row, '多規格名稱二')),
    specCode: cell(at(row, '規格編號')),
    quantity: numeric(at(row, '訂單商品數量')),
    subtotal: numeric(at(row, '小計')),
  }));
  return { rows, sourceRowCount: rows.length, columns: fields.filter(Boolean) };
}
