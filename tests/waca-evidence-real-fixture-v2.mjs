import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { createServer } from 'vite';
import { catalogProofOracle } from './helpers/waca-resolution-proof.mjs';

// Offline, read-only user-provided evidence. Never import into the normal NEXT or cloud DB.
const downloads = join(process.env.USERPROFILE, 'Downloads');
const snapshotName = process.env.WACA_REAL_SNAPSHOT ?? 'cloud-erp-snapshot-2026-10-01-155246.json';
const sources = ['399375_2026-09-11.xls', '399375_2026-09-23 (1).xls', '399375_2026-09-27 (1).xls', '399375_2026-10-01 (1).xls'];
const workbookNames = ['orders-G8DB9720261001235757 的複本.xlsx', 'orders-HSF2Jf20261001082025 的複本.xlsx', 'waca資料.xlsx'];
for (const name of [snapshotName, ...sources, ...workbookNames]) assert.ok(existsSync(join(downloads, name)), `Missing real fixture: ${name}`);
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { parseWacaWorkbook } = await vite.ssrLoadModule('/src/waca/workbookParser.ts');
  const { createWacaRepository, importWacaRows, matchWacaItem, indexWacaMaster, normalizeWacaText,
    wacaFeature, isWacaDiscount, wacaSpecNamesMatch } = await vite.ssrLoadModule('/src/waca/orderCore.ts');
  const { linksFromMyAcgInventory, mergeMyAcgMasterLinks, buildWacaMasterReference } = await vite.ssrLoadModule('/src/waca/masterReference.ts');
  const { repositoryFromSnapshot, snapshotFromRepository } = await vite.ssrLoadModule('/src/waca/nextStorage.ts');
  const erp = JSON.parse(readFileSync(join(downloads, snapshotName), 'utf8')).data;
  let links = linksFromMyAcgInventory(erp.inventory, erp.productVariants, snapshotName, '').links;
  for (const name of sources) {
    const wb = XLSX.read(readFileSync(join(downloads, name)), { type: 'buffer' });
    const sourceRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
    const inventory = sourceRows.map(r => ({ myacg_parent_code: String(r['主編號(多規格編號)'] ?? ''),
      myacg_item_code: String(r['子編號(商品編號)'] ?? ''), product_title: String(r['商品名稱'] ?? ''),
      raw_variant_name: String(r['規格/項目'] ?? '') }));
    links = mergeMyAcgMasterLinks(links, linksFromMyAcgInventory(inventory, erp.productVariants, name, '').links);
  }
  const master = buildWacaMasterReference(erp.productVariants, links);
  const names = await vite.ssrLoadModule('/src/waca/nameEvidence.ts');
  const index = indexWacaMaster(master);
  for (const name of workbookNames) {
    const allRows = parseWacaWorkbook(readFileSync(join(downloads, name))).rows;
    const rows = allRows.filter(r => !isWacaDiscount(r));
    const types = Object.fromEntries(['blank', 'equal', 'distinct'].map(type => {
      const typed = rows.filter(r => (!normalizeWacaText(r.specCode) ? 'blank'
        : normalizeWacaText(r.specCode) === normalizeWacaText(r.productCode) ? 'equal' : 'distinct') === type);
      return [type, { rows: typed.length, orders: new Set(typed.map(r => r.orderNumber)).size,
        products: new Set(typed.map(r => normalizeWacaText(r.productCode))).size }];
    }));
    const repo = createWacaRepository();
    const result = importWacaRows(allRows, repo, master, 'real-v2');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.statusConflicts, []);
    const resolved = rows.map(r => ({ row: r, match: matchWacaItem(r, index) }));
    const oracle = catalogProofOracle(master, names, normalizeWacaText);
    let proofViolations = 0;
    for (const { row, match } of resolved) {
      assert.ok(match.resolution, 'no silent unresolved row');
      if (!match.candidate) { assert.ok(match.diagnostic); continue; }
      const proof = oracle(row);
      if (!proof.permitted || proof.candidates[0].variantId !== match.candidate.variantId) proofViolations++;
    }
    assert.equal(proofViolations, 0);
    const quantities = new Map(repo.autoQuantities);
    for (let at = 0; at < 5; at++) {
      const again = importWacaRows(allRows, repo, master, `real-repeat-${at}`);
      assert.equal(again.inserted, 0);
      assert.deepEqual(repo.autoQuantities, quantities);
    }
    const backup = snapshotFromRepository({ revision: 0, orders: [], items: [], mappings: [], batches: [], masterLinks: [] }, repo, [], links);
    const restored = repositoryFromSnapshot(JSON.parse(JSON.stringify(backup)), erp.productVariants);
    importWacaRows([], restored, master, 'restored');
    assert.deepEqual(restored.autoQuantities, quantities);
    const counts = Object.fromEntries(['SPEC_CODE_EXACT', 'SPEC_NAME_EXACT_UNIQUE', 'UNIQUE_PARENT_VARIANT', 'MANUAL_CONFIRMED_MAPPING']
      .map(reason => [reason, resolved.filter(r => r.match.resolution === reason && r.match.candidate).length]));
    const pending = [...new Map(resolved.filter(r => !r.match.candidate).map(({ row, match }) => [wacaFeature(row),
      { productCode: row.productCode, productName: row.productTitle, spec: [row.spec1, row.spec2].filter(Boolean).join(' / '),
        candidateCount: match.candidates.filter(v => v.variantId).length, reason: match.diagnostic }])).values()];
    const autoRows = resolved.filter(r => r.match.candidate).length;
    // Logs are limited to aggregates and the requested product identities, never customer/order rows.
    console.log(JSON.stringify({ file: name, catalogEvidence: snapshotName, totalRows: allRows.length,
      excludedCoupons: allRows.length - rows.length, productRows: rows.length, types, resolutionRows: counts,
      autoRows, pendingRows: rows.length - autoRows, autoMatchRate: Number((100 * autoRows / rows.length).toFixed(2)),
      resolvedOrActionableRate: 100, proofViolations, features: new Set(rows.map(wacaFeature)).size,
      matchedEffectiveQuantity: result.matchedEffectiveQuantity, pendingEffectiveQuantity: result.unmatchedPendingQuantity,
      pending }, null, 2));
    if (name === workbookNames[0]) {
      for (const code of ['G07592835', 'G07510616']) {
        const sourceVariant = erp.productVariants.find(v => v.myacg_item_code === code);
        assert.ok(sourceVariant, `real catalog case ${code}`);
        const real = rows.find(r => r.productCode === code && !r.specCode)
          ?? { productCode: code, productTitle: sourceVariant.product_title, specCode: '', spec1: '', spec2: '' };
        const found = matchWacaItem(real, index);
        assert.equal(found.candidates.length, 1);
        assert.equal(found.resolution, 'UNIQUE_PARENT_VARIANT');
        console.log(JSON.stringify({ realCase: code, candidates: found.candidates.length, resolvedSku: found.candidate.childCode, reason: found.resolution }));
      }
    }
  }
} finally { await vite.close(); }
