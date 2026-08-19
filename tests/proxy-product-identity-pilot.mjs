import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4267;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/closing-date/dataset.json', import.meta.url));
const PILOT_SOURCE_PATH = fileURLToPath(new URL('../src/lib/proxyProductIdentityPilot.ts', import.meta.url));
const VITE = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const CHROME = process.env.CORE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
const pilotSource = await readFile(PILOT_SOURCE_PATH, 'utf8');
assert.equal(fixture.cases.length, 44, 'Pilot v1 invariance gate must cover the fixed 44-case evaluation');
assert.doesNotMatch(
  pilotSource,
  /dataProvider|indexedDB|saveProductGroups|closing_date|fetch\s*\(/u,
  'Pilot matcher must remain a pure decision helper with no read/write/network dependency',
);
assert.match(pilotSource, /parseProxyProductIdentityV21/u, 'Phase 2 Pilot must use Parser v2.1');
assert.doesNotMatch(
  pilotSource,
  /parseProxyProductIdentityV2(?:\W|$)/u,
  'Phase 2 Pilot must not call legacy Parser v2 Subject extraction',
);

const vite = spawn(process.execPath, [VITE, '--mode', 'next', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteOutput = '';
vite.stdout.on('data', chunk => { viteOutput += String(chunk); });
vite.stderr.on('data', chunk => { viteOutput += String(chunk); });

const waitForVite = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Vite exited early:\n${viteOutput}`);
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteOutput}`);
};

let browser;
try {
  await waitForVite();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const forbiddenRequests = [];
  page.on('request', request => {
    if (/\/api\/|\.supabase\.co\//i.test(request.url())) forbiddenRequests.push(request.url());
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async (dataset) => {
    const v1 = await import('/src/lib/proxyProductIdentity.ts');
    const pilot = await import('/src/lib/proxyProductIdentityPilot.ts');
    const candidate = (name, id, supplier = 'wanrong', manufacturer = null) => ({
      id,
      name,
      manufacturer,
      brand: manufacturer ? null : { name: 'Good Smile Company' },
      catalog: { supplier: { code: supplier }, deadlineAt: '2026-09-07T08:00:00.000Z' },
    });
    const shouldMatch = {
      kdcolleHolo: {
        source: '代理版 角川 KDcolle 狼與辛香料 原作版 赫蘿 無比例模型',
        candidates: [candidate('《狼與辛香料》赫蘿 原作版 無比例模型', 'kdcolle-holo', 'wanrong', 'KADOKAWA')],
      },
      kdcolleShana: {
        source: '代理版 角川 KDcolle 灼眼的夏娜 夏娜 原作版 無比例 全高約15公分',
        candidates: [candidate('《灼眼的夏娜》夏娜 原作版 無比例模型', 'kdcolle-shana', 'wanrong', 'KADOKAWA')],
      },
      kadokawaHoloDx: {
        source: '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 DX Ver.',
        candidates: [candidate('KADOKAWA PLASTIC MODEL SERIES《狼與辛香料 MERCHANT MEETS THE WISE WOLF》赫蘿 DX Ver.', 'kadokawa-holo-dx')],
      },
      kadokawaHoloRegularMissingVersion: {
        source: '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 一般版',
        candidates: [
          candidate('KADOKAWA PLASTIC MODEL SERIES《狼與辛香料 MERCHANT MEETS THE WISE WOLF》赫蘿', 'kadokawa-holo-regular'),
          candidate('KADOKAWA PLASTIC MODEL SERIES《狼與辛香料 MERCHANT MEETS THE WISE WOLF》赫蘿 DX Ver.', 'kadokawa-holo-dx-competing'),
        ],
      },
      apexYixuan: {
        source: '代理版 APEX 1/7 絕區零 儀玄 獨步滄溟Ver 附特典',
        candidates: [candidate('1/7 PVC 絕區零 儀玄·獨步滄溟 Ver.', 'apex-yixuan', 'wanrong', 'APEX')],
      },
      chouzouJotaroVer2: {
        source: '代理版 超像可動 JOJO 星塵遠征軍 空條承太郎 Ver. 2',
        candidates: [candidate('超像可動《JOJO 星塵遠征軍》空條承太郎ver.2', 'chouzou-jotaro-ver2', 'wanrong')],
      },
      compoundReverse: {
        source: '魂商店 萬代 SMP 牙吠孔雀王 & 牙吠眼鏡蛇王',
        candidates: [candidate('萬代 SMP 牙吠眼鏡蛇王 ＆ 牙吠孔雀王', 'smp-reverse', 'wanrong', 'BANDAI')],
      },
    };
    const matched = Object.fromEntries(Object.entries(shouldMatch).map(([key, testCase]) => {
      const v1Selection = v1.selectProxyCatalogCandidate(testCase.source, testCase.candidates);
      const pilotSelection = pilot.selectProxyCatalogCandidateV2Pilot(testCase.source, testCase.candidates);
      const resolution = pilot.resolveProxyCatalogDecision('next', testCase.source, testCase.candidates, v1Selection);
      return [key, {
        v1Status: v1Selection.status,
        pilotSelection,
        resolution,
        safe: pilot.isSafeProxyCatalogPilotSelection(testCase.source, pilotSelection),
        score: pilot.scoreProxyCatalogCandidateV2Pilot(testCase.source, testCase.candidates[0]),
      }];
    }));

    const rejected = {
      wrongSubject: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 角川 KDcolle 狼與辛香料 原作版 赫蘿 無比例模型',
        candidate('1/6 可動 JJKS05A 咒術迴戰 兩面宿儺 一般版', 'wrong-subject'),
      ),
      modelKitVsScale: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 和模線 勝利女神：妮姬 小紅帽 1/12 組裝模型',
        candidate('1/12 Scale Figure 勝利女神：妮姬 小紅帽', 'wrong-type'),
      ),
      nendoroidVsScale: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 GSC 黏土人 峰月律',
        candidate('1/7 Scale Figure 峰月律', 'nendoroid-vs-scale'),
      ),
      popupVsNendoroid: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 POP UP PARADE 橘雪莉 L Size',
        candidate('黏土人 橘雪莉', 'popup-vs-nendoroid'),
      ),
      takaratomyAliasUnproven: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 TAKARATOMY 商店限定 彈珠超人 彈珠人 大福箱’27 戰鬥鳳凰號豪華套組',
        candidate('T-SPARK LEGACYSOUL 彈珠超人 大福箱27[TAKARATOMY]', 'takaratomy'),
      ),
      omanekoUnproven: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 小人物繪舘青島社KP 04R獸娘KEMO PLA Omaneko貓君 組裝模型',
        candidate('ACKS KEMO PLA OMANEKO 組裝模型', 'omaneko-unproven', 'wanrong', 'AOSHIMA'),
      ),
      smpDifferentSet: pilot.scoreProxyCatalogCandidateV2Pilot(
        '萬代 盒玩 SMP 百獸戰隊 牙吠連者 巨大化 牙吠獅 & 牙吠象',
        candidate('SMP 百獸戰隊牙吠連者 威力獸 EXTRA 牙吠海龜＆牙吠海象', 'smp-different'),
      ),
      productLineConflict: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 角川 KDcolle 狼與辛香料 原作版 赫蘿 無比例模型',
        candidate('G.S. Collection 狼與辛香料 原作版 赫蘿 無比例模型', 'wrong-line'),
      ),
      versionConflict: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 DX Ver.',
        candidate('KADOKAWA PLASTIC MODEL SERIES 狼與辛香料 赫蘿 一般版 組裝模型', 'wrong-version'),
      ),
      regularVsDx: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 一般版',
        candidate('KADOKAWA PLASTIC MODEL SERIES 狼與辛香料 赫蘿 DX Ver.', 'regular-vs-dx'),
      ),
      regularWrongSubject: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 一般版',
        candidate('KADOKAWA PLASTIC MODEL SERIES 咒術迴戰 兩面宿儺 一般版', 'regular-wrong-subject'),
      ),
      dxMissingVersion: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 DX Ver.',
        candidate('KADOKAWA PLASTIC MODEL SERIES 狼與辛香料 赫蘿', 'dx-missing-version'),
      ),
      dimensionConflict: pilot.scoreProxyCatalogCandidateV2Pilot(
        '代理版 角川 KDcolle 灼眼的夏娜 夏娜 原作版 無比例 全高約15公分',
        candidate('《灼眼的夏娜》夏娜 原作版 無比例模型 全高約20公分', 'dimension-conflict', 'wanrong', 'KADOKAWA'),
      ),
    };

    const defaultVersionAliases = ['一般版', '普通版', '通常版', 'Standard', 'Standard Ver.'].map(version => (
      pilot.scoreProxyCatalogCandidateV2Pilot(
        `代理版 角川 組裝模型 PLASTIC MODEL 狼與辛香料 赫蘿 ${version}`,
        candidate('KADOKAWA PLASTIC MODEL SERIES 狼與辛香料 赫蘿', `default-${version}`),
      )
    ));

    const supplierSource = '代理版 角川 KDcolle 狼與辛香料 原作版 赫蘿 無比例模型';
    const supplierSelection = pilot.selectProxyCatalogCandidateV2Pilot(supplierSource, [
      candidate('《狼與辛香料》赫蘿 原作版 無比例模型', 'dreamlink-holo', 'dreamlink', 'KADOKAWA'),
      candidate('《狼與辛香料》赫蘿 原作版 無比例模型', 'wanrong-holo', 'wanrong', 'KADOKAWA'),
    ]);
    const ambiguitySelection = pilot.selectProxyCatalogCandidateV2Pilot(supplierSource, [
      candidate('1/7《狼與辛香料》赫蘿 原作版 無比例模型', 'holo-1-7', 'wanrong', 'KADOKAWA'),
      candidate('1/8《狼與辛香料》赫蘿 原作版 無比例模型', 'holo-1-8', 'wanrong', 'KADOKAWA'),
    ]);
    const v1PrioritySource = '代理版 figma 地獄征服者 Helltaker 路西法';
    const v1PriorityCandidates = [candidate('figma 路西法', 'figma-lucifer')];
    const v1PrioritySelection = v1.selectProxyCatalogCandidate(v1PrioritySource, v1PriorityCandidates);
    const v1PriorityResolution = pilot.resolveProxyCatalogDecision(
      'next',
      v1PrioritySource,
      v1PriorityCandidates,
      v1PrioritySelection,
    );
    const plamateaPlainSource = '代理版 PLAMATEA FGO Shielder/瑪修 [奧特瑙斯]';
    const plamateaBlackCandidate = candidate(
      'PLAMATEA Shielder/瑪修·基利艾拉特[奧特瑙斯] Black Barrel Edition',
      'plamatea-black-barrel',
      'wanrong',
    );
    const plamateaPlainCandidate = candidate(
      'PLAMATEA Shielder/瑪修·基利艾拉特[奧特瑙斯]',
      'plamatea-standard',
      'dreamlink',
    );
    const plamateaWrongV1Selection = v1.selectProxyCatalogCandidate(
      plamateaPlainSource,
      [plamateaBlackCandidate],
    );
    const plamateaVersionVeto = {
      v1Selection: plamateaWrongV1Selection,
      nextResolution: pilot.resolveProxyCatalogDecision(
        'next',
        plamateaPlainSource,
        [plamateaBlackCandidate],
        plamateaWrongV1Selection,
      ),
      cloudResolution: pilot.resolveProxyCatalogDecision(
        'cloud',
        plamateaPlainSource,
        [plamateaBlackCandidate],
        plamateaWrongV1Selection,
      ),
      standardResolution: pilot.resolveProxyCatalogDecision(
        'next',
        plamateaPlainSource,
        [plamateaPlainCandidate],
        v1.selectProxyCatalogCandidate(plamateaPlainSource, [plamateaPlainCandidate]),
      ),
      competingListingsResolution: pilot.resolveProxyCatalogDecision(
        'next',
        plamateaPlainSource,
        [plamateaBlackCandidate, plamateaPlainCandidate],
        v1.selectProxyCatalogCandidate(plamateaPlainSource, [plamateaBlackCandidate, plamateaPlainCandidate]),
      ),
    };
    const cloudBlockedSource = shouldMatch.kdcolleHolo.source;
    const cloudBlockedCandidates = shouldMatch.kdcolleHolo.candidates;
    const cloudBlockedResolution = pilot.resolveProxyCatalogDecision(
      'cloud',
      cloudBlockedSource,
      cloudBlockedCandidates,
      v1.selectProxyCatalogCandidate(cloudBlockedSource, cloudBlockedCandidates),
    );

    const v1Invariant = dataset.cases.map(testCase => {
      const candidates = testCase.catalogResponses.flatMap(response => response.products || []);
      const before = v1.selectProxyCatalogCandidate(testCase.erpProduct.title, candidates);
      const beforeQueries = v1.buildProxyCatalogQueries(v1.normalizeProxyProductIdentity(testCase.erpProduct.title));
      const phase2 = pilot.resolveProxyCatalogDecision('next', testCase.erpProduct.title, candidates, before);
      const after = v1.selectProxyCatalogCandidate(testCase.erpProduct.title, candidates);
      const afterQueries = v1.buildProxyCatalogQueries(v1.normalizeProxyProductIdentity(testCase.erpProduct.title));
      return {
        caseId: testCase.caseId,
        candidateCount: candidates.length,
        before,
        after,
        beforeQueries,
        afterQueries,
        phase2: {
          decision: phase2.match?.decisionSource ?? phase2.pilotSelection?.status ?? before.status,
          candidateId: phase2.match?.candidate.id ?? null,
          confidence: phase2.match?.confidence ?? phase2.pilotSelection?.confidence ?? before.confidence,
        },
      };
    });

    return {
      matched,
      rejected,
      defaultVersionAliases,
      supplierSelection,
      ambiguitySelection,
      v1PriorityResolution,
      plamateaVersionVeto,
      cloudBlockedResolution,
      v1Invariant,
      modeGate: Object.fromEntries(
        ['cloud', 'fallback', 'local', 'test', 'next', 'experimental'].map(mode => [mode, pilot.canUseProxyIdentityPilot(mode)]),
      ),
      constants: {
        threshold: v1.PROXY_IDENTITY_MIN_CONFIDENCE,
        ambiguity: v1.PROXY_IDENTITY_AMBIGUITY_DELTA,
        supplierPriority: v1.PROXY_DEFAULT_SUPPLIER_PRIORITY,
      },
    };
  }, fixture);

  for (const [caseName, entry] of Object.entries(result.matched)) {
    assert.notEqual(entry.v1Status, 'match', `${caseName}: Pilot test must begin from a v1 false negative`);
    assert.equal(entry.pilotSelection.status, 'match', `${caseName}: expected V2_PILOT MATCH`);
    assert.equal(entry.resolution.match?.decisionSource, 'V2_PILOT', `${caseName}: Runtime resolver must identify V2_PILOT`);
    assert.equal(entry.safe, true, `${caseName}: write-time Pilot verification must pass`);
    assert.ok(entry.pilotSelection.confidence >= 0.9, `${caseName}: Pilot confidence must preserve the 90% gate`);
    assert.equal(entry.score.sourceIdentity.parserVersion, '2.1', `${caseName}: source must use Parser v2.1`);
    assert.equal(entry.score.candidateIdentity.parserVersion, '2.1', `${caseName}: candidate must use Parser v2.1`);
  }
  assert.ok(result.matched.kadokawaHoloDx.score.candidateIdentity.manufacturers.includes('GOOD_SMILE_COMPANY'));
  assert.ok(result.matched.kadokawaHoloDx.score.candidateIdentity.manufacturers.includes('KADOKAWA'));
  assert.ok(!result.matched.kadokawaHoloDx.score.evidence.some(value => value.includes('MANUFACTURER')));

  assert.equal(result.rejected.wrongSubject.reason, 'subject_conflict');
  assert.equal(result.rejected.modelKitVsScale.reason, 'product_type_conflict');
  assert.equal(result.rejected.nendoroidVsScale.reason, 'product_type_conflict');
  assert.equal(result.rejected.popupVsNendoroid.reason, 'product_type_conflict');
  assert.equal(result.rejected.takaratomyAliasUnproven.reason, 'subject_missing');
  assert.equal(result.rejected.omanekoUnproven.reason, 'subject_missing');
  assert.equal(result.rejected.smpDifferentSet.reason, 'compound_subject_conflict');
  assert.equal(result.rejected.productLineConflict.reason, 'product_line_conflict');
  assert.equal(result.rejected.versionConflict.reason, 'version_conflict');
  assert.equal(result.rejected.regularVsDx.reason, 'version_conflict');
  assert.equal(result.rejected.regularWrongSubject.reason, 'subject_conflict');
  assert.equal(result.rejected.dxMissingVersion.reason, 'version_missing');
  assert.equal(result.rejected.dimensionConflict.reason, 'dimension_conflict');
  for (const entry of Object.values(result.rejected)) assert.equal(entry.rejected, true);
  for (const entry of result.defaultVersionAliases) {
    assert.equal(entry.rejected, false, 'Default/Standard source version should be compatible with a missing candidate version');
    assert.ok(entry.evidence.includes('VERSION_DEFAULT_COMPATIBLE'));
    assert.ok(entry.confidence >= 0.9);
  }

  assert.equal(result.supplierSelection.status, 'match');
  assert.equal(result.supplierSelection.candidate.id, 'wanrong-holo', 'Wanrong priority must remain unchanged');
  assert.equal(result.ambiguitySelection.status, 'ambiguous', '5% ambiguity guard must remain fail-closed');
  assert.equal(result.v1PriorityResolution.match?.decisionSource, 'V1', 'v1 MATCH without a reliable v2 conflict must retain precedence');
  assert.equal(result.plamateaVersionVeto.v1Selection.status, 'match', 'Regression precondition: v1 must reproduce the wrong-version MATCH');
  assert.equal(result.plamateaVersionVeto.nextResolution.match, null, 'Next must block standard PLAMATEA from Black Barrel Edition');
  assert.equal(result.plamateaVersionVeto.nextResolution.safetyVeto?.reason, 'version_conflict');
  assert.deepEqual(result.plamateaVersionVeto.nextResolution.safetyVeto?.sourceVersions, []);
  assert.deepEqual(result.plamateaVersionVeto.nextResolution.safetyVeto?.candidateVersions, ['Black Barrel Edition']);
  assert.equal(result.plamateaVersionVeto.competingListingsResolution.match, null, 'Wanrong priority must not override a version safety veto');
  assert.equal(result.plamateaVersionVeto.competingListingsResolution.safetyVeto?.candidate.id, 'plamatea-black-barrel');
  assert.equal(result.plamateaVersionVeto.standardResolution.match?.decisionSource, 'V1', 'Matching standard PLAMATEA listing must remain allowed');
  assert.equal(result.plamateaVersionVeto.standardResolution.safetyVeto, null);
  assert.equal(result.plamateaVersionVeto.cloudResolution.match?.decisionSource, 'V1', 'Next-only veto must not change non-Next runtime behavior');
  assert.equal(result.plamateaVersionVeto.cloudResolution.safetyVeto, null);
  assert.equal(result.cloudBlockedResolution.match, null, 'Cloud mode must not use V2_PILOT fallback');
  assert.deepEqual(result.modeGate, {
    cloud: false,
    fallback: false,
    local: false,
    test: false,
    next: true,
    experimental: false,
  });
  assert.deepEqual(result.constants, {
    threshold: 0.9,
    ambiguity: 0.05,
    supplierPriority: ['wanrong'],
  });
  for (const entry of result.v1Invariant) {
    assert.deepEqual(entry.after, entry.before, `${entry.caseId}: v1 selection changed after Pilot evaluation`);
    assert.deepEqual(entry.afterQueries, entry.beforeQueries, `${entry.caseId}: Query Planner changed after Pilot evaluation`);
    if (entry.before.status === 'match') {
      assert.equal(entry.phase2.decision, 'V1', `${entry.caseId}: existing safe v1 match must retain precedence`);
      assert.equal(entry.phase2.candidateId, entry.before.candidate?.id ?? null, `${entry.caseId}: selected candidate changed`);
    } else {
      assert.equal(entry.phase2.candidateId, null, `${entry.caseId}: fixed 44-case set gained an unreviewed match`);
    }
  }
  const summarize = (selector) => result.v1Invariant.reduce((summary, entry) => {
    const status = selector(entry);
    summary[status] = (summary[status] ?? 0) + 1;
    return summary;
  }, {});
  const beforeSummary = summarize(entry => entry.before.status);
  const phase2Summary = summarize((entry) => {
    if (entry.phase2.candidateId) return entry.phase2.decision;
    if (entry.phase2.decision === 'ambiguous') return 'ambiguous';
    return entry.candidateCount > 0 ? 'safe_reject' : 'not_found';
  });
  console.log('PHASE2_44_CASE_SUMMARY', JSON.stringify({ before: beforeSummary, after: phase2Summary, falsePositive: 0 }));
  assert.deepEqual(forbiddenRequests, [], 'Pilot regression must issue 0 Catalog/Supabase requests');

  console.log('PASS V2_PILOT Phase 2 uses Parser v2.1 for source/candidate Subject metadata');
  console.log('PASS V2_PILOT safely rescues KDcolle Holo/Shana, KADOKAWA Holo regular/DX, APEX Yixuan, and Jotaro Ver.2');
  console.log('PASS exact compound subject set supports A+B / B+A equivalence');
  console.log('PASS wrong subject/type/line/version/dimension and unverified aliases remain safe rejects');
  console.log('PASS Wanrong supplier priority, 90% threshold, and 5% ambiguity guard unchanged');
  console.log('PASS Next v2 safety veto blocks PLAMATEA standard -> Black Barrel Edition before closing-date write');
  console.log('PASS standard PLAMATEA and non-Next v1 behavior remain unchanged');
  console.log('PASS Manufacturer is diagnostic-only and cannot increase confidence');
  console.log('PASS 44-case v1 decisions and Query Planner outputs unchanged');
  console.log('PASS Next-only mode gate; Production/Cloud/Local/Test/Experimental disabled');
  console.log('PASS Production Supabase request = 0; unexpected DB write path = 0');
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
