export type ProxySemanticProductType =
  | 'FIGMA'
  | 'NENDOROID'
  | 'NENDOROID_DOLL'
  | 'POP_UP_PARADE'
  | 'SCALE_FIGURE'
  | 'UNSCALED_FIGURE'
  | 'MODEL_KIT'
  | 'ACTION_FIGURE'
  | 'PRIZE_FIGURE';

export type ProxySemanticProductLine =
  | 'KDCOLLE'
  | 'KADOKAWA_PLASTIC_MODEL_SERIES'
  | 'KEMO_PLA'
  | 'SMP'
  | 'SHF'
  | 'PLAMATEA'
  | 'CHOUZOUKADOU'
  | 'T_SPARK_LEGACYSOUL'
  | 'G_S_COLLECTION'
  | 'YUMEMIRIZE'
  | 'RELAX_TIME'
  | 'HIKKAKE'
  | 'CHOCOPUNI'
  | 'MOCHIPICO';

export interface ProxyCompoundSubjectV2 {
  members: string[];
  relation: 'set';
  raw: string;
  separators: string[];
}

export interface ProxyProductIdentityV2 {
  originalTitle: string;
  normalizedTitle: string;
  manufacturers: string[];
  productTypes: ProxySemanticProductType[];
  productLines: ProxySemanticProductLine[];
  series: string[];
  subjects: string[];
  compoundSubjects: ProxyCompoundSubjectV2[];
  versions: string[];
  forms: string[];
  scales: string[];
  dimensions: string[];
  modelCodes: string[];
  qualifiers: string[];
  businessMetadata: string[];
  separators: string[];
  residualTokens: string[];
}

export type ProxySubjectResolutionV21 =
  | 'RESOLVED_SUBJECT'
  | 'COMPOUND_SUBJECT'
  | 'UNRESOLVED_SUBJECT';

export type ProxySubjectEvidenceV21 =
  | 'PRODUCT_LINE_TITLE_GRAMMAR'
  | 'ROLE_DELIMITED_SUBJECT'
  | 'MULTI_TOKEN_PERSON_NAME'
  | 'COMPOUND_SUBJECT_SET';

export interface ProxyProductIdentityV21 extends ProxyProductIdentityV2 {
  parserVersion: '2.1';
  subjectResolution: ProxySubjectResolutionV21;
  subjectEvidence: ProxySubjectEvidenceV21[];
  unresolvedSubjectTokens: string[];
}

type ClassifiedPattern<T extends string> = {
  value: T;
  patterns: RegExp[];
};

const PRODUCT_TYPE_PATTERNS: Array<ClassifiedPattern<ProxySemanticProductType>> = [
  { value: 'NENDOROID_DOLL', patterns: [/黏土娃/giu, /ねんどろいどどーる/giu, /nendoroid\s*doll/giu] },
  { value: 'POP_UP_PARADE', patterns: [/pop\s*up\s*parade/giu, /(?:^|\s)pup(?=\s|$)/giu] },
  { value: 'NENDOROID', patterns: [/黏土人/giu, /ねんどろいど/giu, /(?:^|\s)nendoroid(?=\s|$)/giu] },
  { value: 'FIGMA', patterns: [/(?:^|\s)figma(?=\s|$)/giu] },
  { value: 'UNSCALED_FIGURE', patterns: [/無比例模型/gu, /無比例(?!模型)/gu, /non[\s-]*scale(?:d)?\s*figure/giu] },
  { value: 'MODEL_KIT', patterns: [/組裝模型/gu, /plastic\s*model(?:\s*series)?/giu, /model\s*kit/giu] },
  { value: 'SCALE_FIGURE', patterns: [/scale\s*figure/giu, /スケールフィギュア/giu, /pvc\s*完成品/giu] },
  { value: 'ACTION_FIGURE', patterns: [/可動模型/gu, /action\s*figure/giu] },
  { value: 'PRIZE_FIGURE', patterns: [/景品/gu] },
];

const V21_PRODUCT_TYPE_PATTERNS: Array<ClassifiedPattern<ProxySemanticProductType>> = [
  { value: 'ACTION_FIGURE', patterns: [/包膠可動/gu, /可動完成品/gu] },
  ...PRODUCT_TYPE_PATTERNS,
];

const PRODUCT_LINE_PATTERNS: Array<ClassifiedPattern<ProxySemanticProductLine>> = [
  { value: 'KADOKAWA_PLASTIC_MODEL_SERIES', patterns: [/kadokawa\s*plastic\s*model\s*series/giu, /plastic\s*model\s*series/giu, /(?:^|\s)plastic\s*model(?=\s|$)/giu] },
  { value: 'T_SPARK_LEGACYSOUL', patterns: [/t[\s-]*spark\s*legacysoul/giu] },
  { value: 'G_S_COLLECTION', patterns: [/g\.?\s*s\.?\s*collection/giu] },
  { value: 'CHOUZOUKADOU', patterns: [/超像可動/gu] },
  { value: 'KDCOLLE', patterns: [/kdcolle/giu] },
  { value: 'KEMO_PLA', patterns: [/kemo\s*pla/giu, /獸娘\s*kemo\s*pla/giu] },
  { value: 'PLAMATEA', patterns: [/plamatea/giu] },
  { value: 'YUMEMIRIZE', patterns: [/yumemirize/giu] },
  { value: 'RELAX_TIME', patterns: [/relax\s*time/giu, /休息時光/gu] },
  { value: 'HIKKAKE', patterns: [/hikkake/giu, /趴趴公仔/gu] },
  { value: 'CHOCOPUNI', patterns: [/chocopuni/giu] },
  { value: 'MOCHIPICO', patterns: [/mochipico/giu] },
  { value: 'SHF', patterns: [/s\.?\s*h\.?\s*f(?:iguarts)?/giu, /(?:^|\s)shf(?=\s|$)/giu] },
  { value: 'SMP', patterns: [/(?:^|\s)smp(?=\s|$)/giu] },
];

const MANUFACTURER_PATTERNS: Array<{ value: string; patterns: RegExp[] }> = [
  { value: 'GOOD_SMILE_COMPANY', patterns: [/good\s*smile(?:\s*company)?/giu, /(?:^|\s)gsc(?=\s|$)/giu] },
  { value: 'KADOKAWA', patterns: [/kadokawa/giu, /角川/gu] },
  { value: 'BANDAI', patterns: [/bandai/giu, /萬代/gu] },
  { value: 'TAKARATOMY', patterns: [/takara\s*tomy/giu, /takaratomy/giu] },
  { value: 'AOSHIMA', patterns: [/aoshima/giu, /青島社/gu] },
  { value: 'APEX', patterns: [/(?:^|\s)apex(?=\s|$)/giu] },
  { value: 'SEGA', patterns: [/(?:^|\s)sega(?=\s|$)/giu] },
  { value: 'FURYU', patterns: [/(?:^|\s)furyu(?=\s|$)/giu] },
  { value: 'TAITO', patterns: [/(?:^|\s)taito(?=\s|$)/giu] },
  { value: 'HMS', patterns: [/和模線/gu] },
];

const BUSINESS_PATTERNS = [
  /(?:^|\s)(代理版?|預購|廠商)(?=\s|$)/giu,
  /(?:19|20)\d{2}/gu,
  /\b0\d{3}\b/gu,
  /\d{2}年(?:第)?[一二三四1234]季/gu,
];

const QUALIFIER_PATTERNS = [
  /商店限定/gu,
  /魂商店/gu,
  /附特典/gu,
  /特典/gu,
  /限定版/gu,
  /廠商限定/gu,
  /盒玩/gu,
];

const VERSION_PATTERNS = [
  /black\s*barrel\s*edition/giu,
  /dx\s*ver\.?/giu,
  /\b\d+(?:st|nd|rd|th)\b/giu,
  /(?:一般版|普通版|通常版|原作版|再版|再販|黑槍版|限定版)/gu,
  /\bstandard(?:\s*ver\.?)?/giu,
  /(?:^|\s)(dx|deluxe)(?=\s|$)/giu,
];

const V21_VERSION_PATTERNS = [
  /\d+\s*週年紀念版/gu,
  ...VERSION_PATTERNS,
];

const NUMBERED_VERSION_PATTERNS = [/ver(?:sion)?\.?\s*\d+/giu];

const DIMENSION_PATTERNS = [
  /全高\s*約?\s*\d+(?:\.\d+)?\s*(?:公分|cm|mm)/giu,
  /\d+(?:\.\d+)?\s*(?:公分|cm|mm)(?:高|長|寬)?/giu,
  /(?:xxl|xl|l|m|s)\s*size/giu,
];

const V21_DIMENSION_PATTERNS = [
  /(?:全高\s*)?約\s*\d+(?:\.\d+)?\s*(?:公分|cm|mm)(?:高|長|寬)?/giu,
  ...DIMENSION_PATTERNS,
];

const GENERIC_NON_IDENTITY = new Set([
  '模型', '公仔', '完成品', 'pvc', '附特典', '特典', '再版', '再販', '一般版', '普通版',
  '原作版', '限定版', '無比例模型', '組裝模型', '景品', '玩偶', '商品',
]);

const decodeHtmlEntities = (value: string): string => value
  .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
  .replace(/&amp;/giu, '&')
  .replace(/&quot;/giu, '"')
  .replace(/&apos;|&#39;/giu, "'")
  .replace(/&lt;/giu, '<')
  .replace(/&gt;/giu, '>');

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));
const cleanValue = (value: string): string => value.replace(/^\s+|\s+$/gu, '').replace(/\s+/gu, ' ');
const hasCjk = (value: string): boolean => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);

const normalizeTitle = (value: string): string => decodeHtmlEntities(value)
  .normalize('NFKC')
  .replace(/[＆﹠]/gu, '&')
  .replace(/[／⁄]/gu, '/')
  .replace(/[・‧•]/gu, '·')
  .replace(/[’‘`]/gu, "'")
  .replace(/\s+/gu, ' ')
  .trim();

const recordMatchesAndRemove = (source: string, patterns: RegExp[], output: string[]): string => {
  let result = source;
  for (const pattern of patterns) {
    result = result.replace(pattern, match => {
      const cleaned = cleanValue(match);
      if (cleaned) output.push(cleaned);
      return ' ';
    });
  }
  return result;
};

const classifyAndRemove = <T extends string>(
  source: string,
  definitions: Array<ClassifiedPattern<T>>,
  output: T[],
): string => {
  let result = source;
  for (const definition of definitions) {
    let matched = false;
    for (const pattern of definition.patterns) {
      result = result.replace(pattern, () => {
        matched = true;
        return ' ';
      });
    }
    if (matched) output.push(definition.value);
  }
  return result;
};

const collectSeparators = (value: string): string[] => {
  const separators: string[] = [];
  if (value.includes('&')) separators.push('&');
  if (value.includes('/')) separators.push('/');
  if (value.includes('·')) separators.push('·');
  if (/[()[\]{}（）]/u.test(value)) separators.push('brackets');
  if (/[「」]/u.test(value)) separators.push('corner_quotes');
  if (/[《》]/u.test(value)) separators.push('book_quotes');
  return separators;
};

const extractBracketForms = (source: string, forms: string[]): string => source.replace(/\[([^\]]+)\]/gu, (_match, content: string) => {
  const value = cleanValue(content);
  if (value) forms.push(value);
  return ' ';
});

const extractContextualVersions = (source: string, versions: string[]): string => source.replace(
  /(?:[·\s])([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][^\s·]{0,20})\s*ver\.?/giu,
  (_match, label: string) => {
    const value = `${cleanValue(label)} Ver.`;
    versions.push(value);
    return ' ';
  },
);

const extractCompoundSubjects = (
  source: string,
  compounds: ProxyCompoundSubjectV2[],
  subjects: string[],
): string => source.replace(
  /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][\p{Letter}\p{Number}'-]{0,40})\s*([&/])\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][\p{Letter}\p{Number}'-]{0,40})/gu,
  (raw, left: string, separator: string, right: string) => {
    const members = [cleanValue(left), cleanValue(right)];
    compounds.push({ members, relation: 'set', raw: cleanValue(raw), separators: [separator] });
    subjects.push(...members);
    return ' ';
  },
);

const extractScale = (source: string, scales: string[]): string => source.replace(
  /\b1\s*\/\s*\d{1,2}\b/giu,
  match => {
    scales.push(match.replace(/\s+/gu, ''));
    return ' ';
  },
);

const extractModelCodes = (source: string, modelCodes: string[], businessMetadata: string[]): string => source.replace(
  /\b(?:[a-z]{1,6}[\s-]?)?\d{2,8}[a-z]{0,4}\b/giu,
  match => {
    const value = cleanValue(match);
    if (/^(?:19|20)\d{2}$/u.test(value) || /^0\d{3}$/u.test(value)) businessMetadata.push(value);
    else modelCodes.push(value);
    return ' ';
  },
);

const tokenizeResidual = (source: string): string[] => source
  .replace(/[《》「」【】()[\]{}:：,，。!?！？]/gu, ' ')
  .replace(/[·/&]/gu, ' ')
  .split(/\s+/u)
  .map(cleanValue)
  .filter(Boolean)
  .filter(token => !GENERIC_NON_IDENTITY.has(token.toLocaleLowerCase()));

type SubjectExtractionMode = 'legacy-v2' | 'v2.1';

type SubjectExtractionV21 = {
  subjects: string[];
  series: string[];
  forms: string[];
  resolution: ProxySubjectResolutionV21;
  evidence: ProxySubjectEvidenceV21[];
  unresolvedTokens: string[];
};

const PRODUCT_LINE_TITLE_GRAMMAR = new Set<ProxySemanticProductLine>([
  'KDCOLLE',
  'KADOKAWA_PLASTIC_MODEL_SERIES',
]);

const meaningfulResidualTokens = (source: string): string[] => tokenizeResidual(source)
  .filter(token => hasCjk(token) || /[\p{Letter}]/u.test(token));

const extractSubjectV21 = (
  remaining: string,
  productLines: ProxySemanticProductLine[],
  compoundSubjects: ProxyCompoundSubjectV2[],
  existingSubjects: string[],
): SubjectExtractionV21 => {
  const unresolved = (): SubjectExtractionV21 => ({
    subjects: [],
    series: [],
    forms: [],
    resolution: 'UNRESOLVED_SUBJECT',
    evidence: [],
    unresolvedTokens: meaningfulResidualTokens(remaining),
  });

  if (compoundSubjects.length > 0 && existingSubjects.length > 0) {
    return {
      subjects: existingSubjects,
      series: meaningfulResidualTokens(remaining),
      forms: [],
      resolution: 'COMPOUND_SUBJECT',
      evidence: ['COMPOUND_SUBJECT_SET'],
      unresolvedTokens: [],
    };
  }

  if (productLines.includes('PLAMATEA')) {
    const roleDelimited = remaining.match(
      /([\p{Script=Latin}][\p{Letter}\p{Number}_-]*)\s*\/\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][\p{Letter}\p{Number}'’-]*(?:·[\p{Letter}\p{Number}'’-]+)*)/u,
    );
    if (roleDelimited && roleDelimited.index !== undefined) {
      const before = remaining.slice(0, roleDelimited.index);
      const after = remaining.slice(roleDelimited.index + roleDelimited[0].length);
      return {
        subjects: [cleanValue(roleDelimited[2])],
        series: meaningfulResidualTokens(`${before} ${roleDelimited[1]} ${after}`),
        forms: [],
        resolution: 'RESOLVED_SUBJECT',
        evidence: ['ROLE_DELIMITED_SUBJECT'],
        unresolvedTokens: [],
      };
    }
  }

  const multiTokenPerson = remaining.match(
    /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,})\s+([\p{Script=Latin}])\.?\s+([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{1,})/u,
  );
  if (multiTokenPerson && multiTokenPerson.index !== undefined) {
    const before = remaining.slice(0, multiTokenPerson.index);
    const after = remaining.slice(multiTokenPerson.index + multiTokenPerson[0].length);
    return {
      subjects: [`${multiTokenPerson[1]} ${multiTokenPerson[2]} ${multiTokenPerson[3]}`],
      series: meaningfulResidualTokens(before),
      forms: meaningfulResidualTokens(after),
      resolution: 'RESOLVED_SUBJECT',
      evidence: ['MULTI_TOKEN_PERSON_NAME'],
      unresolvedTokens: [],
    };
  }

  const residualTokens = meaningfulResidualTokens(remaining);
  if (
    productLines.some(line => PRODUCT_LINE_TITLE_GRAMMAR.has(line))
    && residualTokens.length >= 2
  ) {
    return {
      subjects: [residualTokens[residualTokens.length - 1]],
      series: residualTokens.slice(0, -1),
      forms: [],
      resolution: 'RESOLVED_SUBJECT',
      evidence: ['PRODUCT_LINE_TITLE_GRAMMAR'],
      unresolvedTokens: [],
    };
  }

  return unresolved();
};

/**
 * Test/evaluation-only semantic parser foundation.
 *
 * This function intentionally has no dependency on Provider, IndexedDB, Supabase,
 * catalog retrieval, matching thresholds, or closing-date writes. Parser v1 remains
 * the primary matcher; v2 may only support explicitly gated Next-only diagnostics
 * and pilot matching.
 */
function parseProxyProductIdentityInternal(
  title: string,
  manufacturerName: string,
  subjectMode: SubjectExtractionMode,
): ProxyProductIdentityV2 | ProxyProductIdentityV21 {
  const normalizedTitle = normalizeTitle(title);
  const manufacturers: string[] = [];
  const productTypes: ProxySemanticProductType[] = [];
  const productLines: ProxySemanticProductLine[] = [];
  const series: string[] = [];
  const subjects: string[] = [];
  const compoundSubjects: ProxyCompoundSubjectV2[] = [];
  const versions: string[] = [];
  const forms: string[] = [];
  const scales: string[] = [];
  const dimensions: string[] = [];
  const modelCodes: string[] = [];
  const qualifiers: string[] = [];
  const businessMetadata: string[] = [];
  const separators = collectSeparators(normalizedTitle);

  let remaining = normalizedTitle;
  remaining = extractBracketForms(remaining, forms);
  remaining = recordMatchesAndRemove(remaining, BUSINESS_PATTERNS, businessMetadata);
  for (const definition of MANUFACTURER_PATTERNS) {
    let matched = false;
    for (const pattern of definition.patterns) {
      remaining = remaining.replace(pattern, () => {
        matched = true;
        return ' ';
      });
      if (manufacturerName.match(pattern)) matched = true;
    }
    if (matched) manufacturers.push(definition.value);
  }
  remaining = classifyAndRemove(remaining, PRODUCT_LINE_PATTERNS, productLines);
  remaining = classifyAndRemove(
    remaining,
    subjectMode === 'v2.1' ? V21_PRODUCT_TYPE_PATTERNS : PRODUCT_TYPE_PATTERNS,
    productTypes,
  );
  remaining = extractScale(remaining, scales);
  remaining = recordMatchesAndRemove(
    remaining,
    subjectMode === 'v2.1' ? V21_DIMENSION_PATTERNS : DIMENSION_PATTERNS,
    dimensions,
  );
  remaining = recordMatchesAndRemove(remaining, NUMBERED_VERSION_PATTERNS, versions);
  remaining = extractContextualVersions(remaining, versions);
  remaining = recordMatchesAndRemove(
    remaining,
    subjectMode === 'v2.1' ? V21_VERSION_PATTERNS : VERSION_PATTERNS,
    versions,
  );
  remaining = recordMatchesAndRemove(remaining, QUALIFIER_PATTERNS, qualifiers);
  remaining = extractModelCodes(remaining, modelCodes, businessMetadata);

  const hadTransformationForm = /(?:^|\s)黑化(?=\s|$)/u.test(remaining);
  remaining = remaining.replace(/(?:^|\s)(黑化)(?=\s|$)/gu, (_match, form: string) => {
    forms.push(form);
    return ' ';
  });

  remaining = extractCompoundSubjects(remaining, compoundSubjects, subjects);
  const residualTokens = tokenizeResidual(remaining);
  const meaningful = residualTokens.filter(token => hasCjk(token) || /[\p{Letter}]/u.test(token));
  let subjectResolution: ProxySubjectResolutionV21 = 'UNRESOLVED_SUBJECT';
  let subjectEvidence: ProxySubjectEvidenceV21[] = [];
  let unresolvedSubjectTokens: string[] = [];

  if (subjectMode === 'v2.1') {
    const extraction = extractSubjectV21(remaining, productLines, compoundSubjects, subjects);
    subjects.splice(0, subjects.length, ...extraction.subjects);
    series.push(...extraction.series);
    forms.push(...extraction.forms);
    subjectResolution = extraction.resolution;
    subjectEvidence = extraction.evidence;
    unresolvedSubjectTokens = extraction.unresolvedTokens;
  } else if (subjects.length === 0 && meaningful.length > 0) {
    if (hadTransformationForm && meaningful.length >= 2) {
      subjects.push(...meaningful.slice(-2));
      series.push(...meaningful.slice(0, -2));
    } else {
      const cjkIndexes = meaningful
        .map((token, index) => (hasCjk(token) ? index : -1))
        .filter(index => index >= 0);
      const subjectIndex = cjkIndexes.at(-1) ?? meaningful.length - 1;
      subjects.push(meaningful[subjectIndex]);
      series.push(...meaningful.filter((_token, index) => index !== subjectIndex));
    }
  } else {
    series.push(...meaningful);
  }

  const identity: ProxyProductIdentityV2 = {
    originalTitle: title,
    normalizedTitle,
    manufacturers: unique(manufacturers),
    productTypes: unique(productTypes),
    productLines: unique(productLines),
    series: unique(series),
    subjects: unique(subjects),
    compoundSubjects,
    versions: unique(versions.map(cleanValue)),
    forms: unique(forms.map(cleanValue)),
    scales: unique(scales),
    dimensions: unique(dimensions.map(cleanValue)),
    modelCodes: unique(modelCodes.map(cleanValue)),
    qualifiers: unique(qualifiers.map(cleanValue)),
    businessMetadata: unique(businessMetadata.map(cleanValue)),
    separators,
    residualTokens,
  };

  if (subjectMode === 'v2.1') {
    return {
      ...identity,
      parserVersion: '2.1',
      subjectResolution,
      subjectEvidence,
      unresolvedSubjectTokens: unique(unresolvedSubjectTokens),
    };
  }
  return identity;
}

export function parseProxyProductIdentityV2(title: string, manufacturerName = ''): ProxyProductIdentityV2 {
  return parseProxyProductIdentityInternal(title, manufacturerName, 'legacy-v2') as ProxyProductIdentityV2;
}

/**
 * Parser v2.1 subject-extraction rewrite.
 *
 * This parser has no generic "last token becomes Subject" fallback. A Subject
 * is emitted only from an explicit title grammar, role delimiter, multi-token
 * person-name span, or compound set. All other residual text is reported as
 * UNRESOLVED_SUBJECT for Next-only shadow evaluation.
 */
export function parseProxyProductIdentityV21(title: string, manufacturerName = ''): ProxyProductIdentityV21 {
  return parseProxyProductIdentityInternal(title, manufacturerName, 'v2.1') as ProxyProductIdentityV21;
}
