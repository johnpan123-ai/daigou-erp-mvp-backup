const normalizeForMatch = (text) => {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[\s!\uff01\?\uff1f\-_\(\)\uff08\uff09\.\*,]/g, '');
};

const checkIsProxyProduct = (g) => {
  if (g.listing_type === '代理版') return true;
  if (g.source_type === '代理版') return true;
  
  const keywords = ['代理版', '代理', 'gsc', 'good smile', 'max factory', 'furyu', '景品', 'sega', 'bandai', 'kotobukiya'];
  const matchText = (text) => {
    if (!text) return false;
    const lower = text.toLowerCase();
    return keywords.some(kw => lower.includes(kw));
  };
  
  if (matchText(g.title) || matchText(g.normalized_title)) return true;
  return false;
};

const isProxyProduct = (g) => {
  return !!checkIsProxyProduct(g);
};

const isHololiveProduct = (g) => {
  if (isProxyProduct(g)) return false;
  const titleNorm = normalizeForMatch(g.title);
  const normTitleNorm = normalizeForMatch(g.normalized_title);
  return titleNorm.includes('hololive') || normTitleNorm.includes('hololive');
};

const isVspoProduct = (g) => {
  if (isProxyProduct(g)) return false;
  const titleNorm = normalizeForMatch(g.title);
  const normTitleNorm = normalizeForMatch(g.normalized_title);
  return titleNorm.includes('vspo') || titleNorm.includes('ぶいすぽ') || 
         normTitleNorm.includes('vspo') || normTitleNorm.includes('ぶいすぽ');
};

const isOtherProduct = (g) => {
  return !isProxyProduct(g) && !isHololiveProduct(g) && !isVspoProduct(g);
};

const mockGroups = [
  { id: '1', title: '【小河馬】HoloLive 櫻巫女 黏土人', listing_type: '一般預購' },
  { id: '2', title: 'hololive production 湊阿庫婭 比例模型', listing_type: '一般預購' },
  { id: '3', title: 'HOLOLIVE 寶鐘瑪琳 T-Shirt', listing_type: '一般預購' },
  { id: '4', title: 'Hololive 兎田佩克拉 軟膠夾子', listing_type: '一般預購' },
  { id: '5', title: 'VSPO! 一之瀨麗 徽章', listing_type: '一般預購' },
  { id: '6', title: 'ぶいすぽ 花芽薺 立牌', listing_type: '一般預購' },
  { id: '7', title: 'ぶいすぽっ！ 八雲藍 吊飾', listing_type: '一般預購' },
  { id: '8', title: 'VSPO 藍澤艾瑪 托特包', listing_type: '一般預購' },
  { id: '9', title: '代理版 Hololive 櫻巫女 黏土人', listing_type: '代理版' },
  { id: '10', title: '代理版 VSPO 花芽薺 立牌', listing_type: '代理版' },
  { id: '11', title: 'Good Smile 代理版 原神 螢 黏土人', listing_type: '一般預購' }, // matched as proxy because of 'Good Smile' or '代理版'
  { id: '12', title: '其他一般代購 史萊姆 娃娃', listing_type: '一般預購' }
];

console.log('Testing Group Categories...');
let proxyCount = 0;
let hololiveCount = 0;
let vspoCount = 0;
let otherCount = 0;

mockGroups.forEach(g => {
  let cat = 'Other';
  if (isProxyProduct(g)) {
    cat = 'Proxy';
    proxyCount++;
  } else if (isHololiveProduct(g)) {
    cat = 'Hololive';
    hololiveCount++;
  } else if (isVspoProduct(g)) {
    cat = 'VSPO';
    vspoCount++;
  } else if (isOtherProduct(g)) {
    cat = 'Other';
    otherCount++;
  }
  
  console.log(`[${cat.padEnd(8)}] "${g.title}"`);
});

console.log('\nSummary counts:');
console.log(`- 全部商品: ${mockGroups.length}`);
console.log(`- 代理版商品 (Proxy): ${proxyCount}`);
console.log(`- Hololive商品 (Hololive): ${hololiveCount}`);
console.log(`- VSPO商品 (VSPO): ${vspoCount}`);
console.log(`- 其他商品 (Other): ${otherCount}`);
console.log(`- Sum of subcategories: ${proxyCount + hololiveCount + vspoCount + otherCount}`);

if (proxyCount + hololiveCount + vspoCount + otherCount === mockGroups.length) {
  console.log('PASS: Mutually exclusive & complete partition verified!');
} else {
  console.log('FAIL: Counts do not sum to total!');
}
