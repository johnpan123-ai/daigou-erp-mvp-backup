import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const META_GROUP_ID = '00000000-0000-4000-a000-000000000000';
const TODAY = '2026-08-12';
const input = process.argv[2]
  ? resolve(process.argv[2])
  : new URL('./fixtures/core-regression.json', import.meta.url);
const fixture = JSON.parse(await readFile(input, 'utf8'));

const purchaseRecordsDate = value => {
  const clean = String(value ?? '').trim();
  const match = clean.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
};

const dashboardDate = value => {
  const clean = String(value ?? '').trim();
  if (!clean) return null;
  const match = clean.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return match
    ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    : clean;
};

const prGroups = fixture.productGroups.filter(group => group.id !== META_GROUP_ID);
const dashboardGroups = fixture.productGroups;
const prIds = new Set(prGroups.map(group => group.id));
const dashboardIds = new Set(dashboardGroups.map(group => group.id));

const classify = group => {
  const prDate = purchaseRecordsDate(group.closing_date);
  const dashDate = dashboardDate(group.closing_date);
  const purchaseRecords = prDate && TODAY > prDate ? '已結單' : '進行中';
  const dashboard = dashDate && dashDate < TODAY ? '已結單' : '進行中';
  return {
    id: group.id,
    title: group.title,
    closing_date: group.closing_date ?? '',
    dashboard,
    purchaseRecords,
    dashboardReason: dashDate
      ? `Dashboard 將日期轉為「${dashDate}」，以 ${dashDate} < ${TODAY} 判定`
      : 'Dashboard 沒有有效結單日，因此判定進行中',
    purchaseRecordsReason: prDate
      ? `PurchaseRecords 將日期轉為「${prDate}」，以 ${TODAY} > ${prDate} 判定`
      : 'PurchaseRecords 僅接受 YYYY-MM-DD／YYYY/MM/DD；此值無法正規化，因此判定進行中',
  };
};

const byId = new Map(fixture.productGroups.map(group => [group.id, group]));
const onlyDashboard = dashboardGroups.filter(group => !prIds.has(group.id)).map(classify);
const onlyPurchaseRecords = prGroups.filter(group => !dashboardIds.has(group.id)).map(classify);
const shared = prGroups.filter(group => dashboardIds.has(group.id)).map(classify);
const dashboardActivePrClosed = shared.filter(row => row.dashboard === '進行中' && row.purchaseRecords === '已結單');
const dashboardClosedPrActive = shared.filter(row => row.dashboard === '已結單' && row.purchaseRecords === '進行中');

const report = {
  snapshotDate: TODAY,
  counts: { dashboard: dashboardGroups.length, purchaseRecords: prGroups.length },
  onlyDashboard,
  onlyPurchaseRecords,
  dashboardActivePrClosed,
  dashboardClosedPrActive,
  sourceEvidence: {
    metadataGroup: byId.get(META_GROUP_ID),
    proxyMigration: {
      key: 'erp_proxy_agent_map',
      readAt: 'PurchaseRecords loadData 完成後的 migration effect',
      condition: 'local map 有相同 group.id，且 localAgent !== group.proxy_agent，且資料未被 stale guard 阻擋',
      write: 'dataProvider.saveProductGroups(nextGroups)',
      risk: 'Cloud Mode 會把舊 localStorage 代理商值寫回 product_groups，覆蓋剛 pull 下來的新值',
    },
  },
};

console.log(JSON.stringify(report, null, 2));
