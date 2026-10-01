import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { createServer } from 'vite';

const downloads = process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Downloads') : '';
const sources = [
  '399375_2026-09-11.xls',
  '399375_2026-09-23 (1).xls',
  '399375_2026-09-27 (1).xls',
];
const requiredFiles = [...sources, 'waca資料.xlsx', 'cloud-erp-snapshot-2026-09-26-162318.json'];
if (!downloads || requiredFiles.some(name => !existsSync(join(downloads, name)))) {
  console.log('SKIP real WACA closure sample: source workbooks or ERP snapshot unavailable');
  process.exit(0);
}
const vite = await createServer({ configFile: false, cacheDir: '.vite-cache', server: { middlewareMode: true }, appType: 'custom' });
try {
  const { parseWacaWorkbook } = await vite.ssrLoadModule('/src/waca/workbookParser.ts');
  const { isWacaDiscount, matchWacaItem, wacaFeature, importWacaRows, createWacaRepository,
    normalizeWacaText, wacaSpecNamesMatch } =
    await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const { buildWacaMasterReference, linksFromMyAcgInventory, mergeMyAcgMasterLinks } =
    await vite.ssrLoadModule('/src/waca/masterReference.ts');
  const { validateNextWacaSnapshot, snapshotFromRepository, repositoryFromSnapshot } =
    await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const erp = JSON.parse(readFileSync(join(downloads, 'cloud-erp-snapshot-2026-09-26-162318.json'), 'utf8')).data;
  let links = [];
  const catalogByG = new Map();
  let currentRows = 0;
  for (const fileName of sources) {
    const workbook = XLSX.read(readFileSync(join(downloads, fileName)), { type: 'buffer' });
    const parsed = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '', raw: false });
    if (fileName === '399375_2026-09-27 (1).xls') currentRows = parsed.length;
    for (const item of parsed) catalogByG.set(String(item['子編號(商品編號)'] || ''), item);
    const inventory = parsed.map(row => ({
      myacg_parent_code: String(row['主編號(多規格編號)'] || ''),
      myacg_item_code: String(row['子編號(商品編號)'] || ''),
      product_title: String(row['商品名稱'] || ''),
      raw_variant_name: String(row['規格/項目'] || ''),
    }));
    const result = linksFromMyAcgInventory(inventory, erp.productVariants, fileName, fileName);
    links = mergeMyAcgMasterLinks(links, result.links);
    console.log('evidence', fileName, JSON.stringify({ rows: parsed.length, ...Object.fromEntries(
      ['accepted', 'missingVariant', 'ambiguousVariant', 'missingParent'].map(key => [key, result[key]])), total: links.length }));
  }
  const mergedAgain = mergeMyAcgMasterLinks(links, links);
  assert.equal(mergedAgain.length, links.length, 're-importing evidence cannot duplicate GP → G links');
  const master = buildWacaMasterReference(erp.productVariants, links);
  const waca = parseWacaWorkbook(readFileSync(join(downloads, 'waca資料.xlsx')));
  const productRows = waca.rows.filter(row => !isWacaDiscount(row));
  const features = [...new Map(productRows.map(row => [wacaFeature(row), row])).values()];
  const featureMatch = features.map(row => ({ row, match: matchWacaItem(row, master) }));
  const autoFeatures = featureMatch.filter(item => item.match.kind === 'AUTO_MATCH');
  const autoRows = productRows.filter(row => matchWacaItem(row, master).kind === 'AUTO_MATCH');
  assert.equal(currentRows, 1448);
  assert.equal(waca.rows.length, 127);
  assert.equal(productRows.length, 115);
  assert.equal(features.length, 60);
  // Blank-spec rows use exact labels INSIDE a proven group, not a parent→SKU fallback.
  assert.equal(autoRows.length, 115);
  assert.equal(autoFeatures.length, 60);
  const kaela = features.find(row => row.productCode === 'GP00392293' && row.spec1 === '親簽套組');
  assert.equal(matchWacaItem({ ...kaela, specCode: 'G07487795', spec1: '複製簽套組' }, master).candidate?.childCode, 'G07487795');
  const withoutHistoricKaela = master.filter(item => item.childCode !== 'G07487794');
  assert.equal(matchWacaItem({ ...kaela, specCode: 'G07487794' }, withoutHistoricKaela).diagnostic, 'VARIANT_NOT_IN_ERP');
  const unknownGp = { ...kaela, productCode: 'GP-NOT-OBSERVED' };
  assert.equal(matchWacaItem({ ...unknownGp, specCode: 'G07487794' }, master).candidate?.childCode, 'G07487794');
  assert.equal(matchWacaItem({ ...unknownGp, specCode: '' }, master).diagnostic, 'MASTER_EVIDENCE_MISSING');
  const absentErp = links.find(link => !link.productVariantId && link.variantTitle && link.productTitle);
  assert.ok(absentErp, 'source GP → G evidence must survive when ERP lacks the G');
  assert.equal(matchWacaItem({ ...kaela, productCode: absentErp.mainCode, productTitle: absentErp.productTitle,
    specCode: absentErp.childCode, spec1: absentErp.variantTitle }, master).diagnostic, 'VARIANT_NOT_IN_ERP');
  assert.equal(matchWacaItem({ ...kaela, specCode: 'G07487794', productTitle: 'Entirely different product' }, master).diagnostic, 'NAME_CONFLICT');
  const duplicateCandidates = [
    { mainCode: 'GP-X', childCode: 'G-X1', variantId: 'x1', productGroupId: '',
      productTitle: 'Product X', variantTitle: 'Red', active: true },
    { mainCode: 'GP-X', childCode: 'G-X1', variantId: 'x2', productGroupId: '',
      productTitle: 'Product X', variantTitle: 'Red', active: true },
  ];
  assert.equal(matchWacaItem({ ...kaela, productCode: 'GP-X', specCode: 'G-X1', productTitle: 'Product X', spec1: 'Red' },
    duplicateCandidates).diagnostic, 'MULTIPLE_VARIANT_CANDIDATES');
  const groupMissing = matchWacaItem({ ...kaela, productCode: 'GP-X', specCode: 'G-X1', productTitle: 'Product X', spec1: 'Red' }, duplicateCandidates.slice(0, 1));
  assert.equal(groupMissing.kind, 'AUTO_MATCH', 'an exact G can match even without an ERP group link');
  assert.equal(groupMissing.diagnostic, 'MASTER_GROUP_LINK_MISSING');
  let falsePositiveCount = 0;
  for (const row of productRows) {
    const candidate = matchWacaItem(row, master).candidate;
    const match = matchWacaItem(row, master);
    if (candidate && (!candidate.variantId || (row.specCode.trim()
      ? normalizeWacaText(row.specCode) !== normalizeWacaText(candidate.childCode)
      : match.resolution === 'SPEC_NAME_EXACT_UNIQUE' ? !wacaSpecNamesMatch(row, candidate)
        : match.resolution !== 'UNIQUE_PARENT_VARIANT' || match.candidates.length !== 1))) falsePositiveCount += 1;
  }
  assert.equal(falsePositiveCount, 0, 'every auto match needs explicit SKU or unique parent-scoped evidence');
  const pending = featureMatch.filter(item => item.match.kind !== 'AUTO_MATCH').map(({ row, match }) => ({
    code: row.productCode, title: row.productTitle, spec: [row.spec1, row.spec2].filter(Boolean).join(' / '),
    reason: match.diagnostic, candidates: match.candidates.map(candidate => ({
      G: candidate.childCode, spec: candidate.variantTitle, variantId: candidate.variantId,
      groupId: candidate.productGroupId, source: candidate.sourceFile,
    })),
  }));
  const repo = createWacaRepository();
  const result = importWacaRows(waca.rows, repo, master, 'real-v2');
  const quantities = new Map(repo.autoQuantities);
  const repeat = importWacaRows(waca.rows, repo, master, 'real-v2-repeat');
  assert.deepEqual(repo.autoQuantities, quantities);
  const snapshot = snapshotFromRepository({ revision: 0, orders: [], items: [], mappings: [], batches: [], masterLinks: [] }, repo, [], links);
  validateNextWacaSnapshot(snapshot, erp.productVariants);
  const restored = repositoryFromSnapshot(JSON.parse(JSON.stringify(snapshot)), erp.productVariants);
  assert.deepEqual(restored.autoQuantities, repo.autoQuantities);
  const afterRestore = importWacaRows(waca.rows, restored, master, 'real-v2-after-restore');
  assert.equal(afterRestore.unchanged, 115);
  assert.deepEqual(restored.autoQuantities, repo.autoQuantities);
  console.log(JSON.stringify({ rows: waca.rows.length, orders: result.ordersTotal,
    discounts: result.discountIgnored, productRows: productRows.length, features: features.length,
    autoFeatures: autoFeatures.length, autoRows: autoRows.length, falsePositiveCount, pendingCount: pending.length,
    imported: { matched: result.matched, unmatched: result.unmatched, multiple: result.multipleCandidates,
      effectiveQuantity: result.effectiveQuantity, matchedEffectiveQuantity: result.matchedEffectiveQuantity,
      unmatchedPendingQuantity: result.unmatchedPendingQuantity },
    repeat: { inserted: repeat.inserted, updated: repeat.updated, unchanged: repeat.unchanged },
    afterRestore: { unchanged: afterRestore.unchanged, quantitySame: true },
  }, null, 2));
} finally {
  await vite.close();
}
