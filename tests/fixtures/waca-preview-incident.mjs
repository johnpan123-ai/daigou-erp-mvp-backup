// Read-only reproduction of the 2026-10-19 preview shape. Public product/SKU labels and
// quantities match the inspected preview; all order identifiers and prices are synthetic.
const baseballNames = ['博衣こより', '大神ミオ', '白銀ノエル', '宝鐘マリン', '尾丸ポルカ', '響咲リオナ'];
export const incidentGroups = [
  { id: 'incident-baseball', title: 'Hololive 甲子園2026 舉辦紀念商品', display: 'Hololive 甲子園2026 舉辦紀念商品', code: 'AUDIT-BASEBALL',
    rows: Array.from({ length: 18 }, (_, i) => [`G${String(7654776 + i).padStart(8, '0')}`, baseballNames[i % 6], 0]) },
  { id: 'incident-halloween', title: 'Hololive 星街彗星 星街すいせい Halloween 2026周邊商品',
    display: 'Hololive 星街彗星 星街すいせい Halloween 2026周邊商品', code: 'AUDIT-HALLOWEEN',
    rows: ['章魚燒坐姿公仔', 'LOGO 鑰匙圈', '壓克力立牌', '徽章', '貼紙套組', 'B2 海報', '海報複製原畫 裱框版 FC會員限定', '方形徽章']
      .map((name, i) => [`G${String(7654822 + i).padStart(8, '0')}`, name, 0]) },
  { id: 'incident-rurudo', title: '代理版 Pink Charm Rurudo 原畫 海軍風水手服Ver 1/6 付特典',
    display: '代理版 Pink Charm Rurudo 原畫 海軍風水手服Ver 1/6 付特典', code: 'AUDIT-RURUDO', rows: [['G07595265', '標準規格', 2]] },
  { id: 'incident-purrfect', title: 'Hololive GreyScaleX Purrfect Pair グッズ',
    display: 'Hololive GreyScaleX Purrfect Pair グッズ', code: 'AUDIT-PURRFECT',
    rows: [['G07506675', '親簽數量限定紀念套組', 0], ['G07506676', '複製簽套組', 0], ['G07506677', '壓克力立體場景立牌', 0],
      ['G07506678', 'Vestia Zeta 可互相連接的絨毛玩偶鑰匙圈', 0], ['G07506679', 'Shiori Novella 可互相連接的絨毛玩偶鑰匙圈', 1],
      ['G07506680', 'Catnip 貓薄荷包', 0], ['', '親簽', 0]] },
];
export const incidentEpoch = { epoch: 33, restored_at: '2026-10-19T03:06:55.409628+00:00' };
const source = [
  ['AUDIT-ORDER-A', '2026-10-17 22:22:30', 'G07654778'],
  ['AUDIT-ORDER-A', '2026-10-17 22:22:30', 'G07654784'],
  ['AUDIT-ORDER-B', '2026-10-17 23:00:20', 'G07654781'],
  ['AUDIT-ORDER-B', '2026-10-17 23:00:20', 'G07654793'],
  ['AUDIT-ORDER-C', '2026-10-18 01:18:24', 'G07654824'],
  ['AUDIT-ORDER-C', '2026-10-18 01:18:24', 'G07654825'],
  ['AUDIT-ORDER-D', '2026-10-18 00:33:36', 'G07654825'],
  ['AUDIT-ORDER-E', '2026-10-18 12:49:35', 'G07595265'],
  ['AUDIT-CANCELLED', '2026-10-17 11:57:29', 'G07506675'],
];
export const incidentRows = source.map(([number, at, sku]) => {
  const group = incidentGroups.find(g => g.rows.some(r => r[0] === sku));
  const variant = group.rows.find(r => r[0] === sku);
  return [number === 'AUDIT-CANCELLED' ? '取消' : '完成付款', number, at, group.code, group.title, variant[1], '', sku, 1, 100];
});
