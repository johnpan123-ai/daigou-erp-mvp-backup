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
  | 'QUOTED_SERIES_SUBJECT'
  | 'VERSION_BOUNDED_TITLE_GRAMMAR'
  | 'ROLE_DELIMITED_SUBJECT'
  | 'MULTI_TOKEN_PERSON_NAME'
  | 'DISTINCTIVE_MIXED_SCRIPT_SUBJECT'
  | 'COMPOUND_SUBJECT_SET';

export interface ProxyProductIdentityV21 extends ProxyProductIdentityV2 {
  parserVersion: '2.1';
  subjectResolution: ProxySubjectResolutionV21;
  subjectEvidence: ProxySubjectEvidenceV21[];
  unresolvedSubjectTokens: string[];
}

export type ProxySubjectCandidateEvidenceV21 =
  | 'PRODUCT_LINE_GRAMMAR'
  | 'PRODUCT_TYPE_GRAMMAR'
  | 'QUOTED_SUBJECT'
  | 'COMPOUND_MEMBER'
  | 'MULTI_TOKEN_PERSON_NAME'
  | 'ROLE_DELIMITED_SUBJECT'
  | 'DISTINCTIVE_MIXED_SCRIPT'
  | 'UNRESOLVED_ENTITY_TOKEN';

export interface ProxySubjectCandidateV21 {
  value: string;
  evidence: ProxySubjectCandidateEvidenceV21[];
  rank: number;
  queryEligible: boolean;
}

export type ProxyProductTypeEvidenceSourceV21 =
  | 'EXPLICIT_MARKER'
  | 'PRODUCT_LINE'
  | 'SCALE_WITHOUT_MODEL_KIT';

export interface ProxyProductTypeEvidenceV21 {
  productType: ProxySemanticProductType;
  source: ProxyProductTypeEvidenceSourceV21;
  productLine?: ProxySemanticProductLine;
}

/**
 * Phase-1 metadata contract for the generalized retrieval work. Runtime
 * retrieval deliberately continues to call parseProxyProductIdentityV21 until
 * the later integration phase.
 */
export interface ProxyProductIdentityV21Metadata extends ProxyProductIdentityV21 {
  metadataVersion: 'generalized-retrieval-phase1';
  subjectCandidates: ProxySubjectCandidateV21[];
  editions: string[];
  releaseStatuses: string[];
  productTypeEvidence: ProxyProductTypeEvidenceV21[];
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
  { value: 'MODEL_KIT', patterns: [/(?:^|\s)組裝(?=\s|$)/gu] },
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
  /(?:^|\s)\d{2,4}年\d{1,2}月(?=\s|$)/gu,
  /\b(?:19|20)\d{2}\b/gu,
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

const GENERALIZED_QUALIFIER_PATTERNS = [
  ...QUALIFIER_PATTERNS,
  /(?:中|大|小)?盒(?:\d+|[一二三四五六七八九十百]+)入/gu,
  /(?:驚喜)?零件隨機/gu,
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

const RELEASE_STATUS_PATTERNS = [/(?:再版|再販)/gu];

const EDITION_PATTERNS = [
  /black\s*barrel\s*edition/giu,
  /dx\s*ver\.?/giu,
  /\b\d+(?:st|nd|rd|th)\b/giu,
  /\b(?:first|second|third|fourth)\b/giu,
  /(?:一般版|普通版|通常版|原作版|黑槍版|限定版)/gu,
  /\bbasic\b/giu,
  /\bstandard(?:\s*ver\.?)?/giu,
  /(?:^|\s)(dx|deluxe)(?=\s|$)/giu,
];

const V21_EDITION_PATTERNS = [
  /\d+\s*週年紀念版/gu,
  ...EDITION_PATTERNS,
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
  '原作版', '限定版', '無比例模型', '組裝模型', '景品', '玩偶', '商品', '插畫', '原畫',
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

export const isProxyCreatorMetadataToken = (value: string): boolean => (
  /^(?:繪師|画師|畫師|插畫師|插画师|原畫師|原画师|illustrator|artist)(?:[:：]?)[\p{Letter}\p{Number}_.-]+$/iu
    .test(cleanValue(value))
);

/**
 * A conservative mixed-script product name recognizer. It accepts a complete
 * token such as `MX醬`, but not a lone CJK suffix (`醬`), a one-letter form
 * (`F型`), version-like metadata (`DX版`), or creator metadata
 * (`繪師toridamono`).
 */
export const isProxyDistinctiveMixedScriptSubjectToken = (value: string): boolean => {
  const normalized = cleanValue(value).normalize('NFKC');
  if (!normalized || /\s/u.test(normalized) || isProxyCreatorMetadataToken(normalized)) return false;
  const latin = Array.from(normalized).filter(character => /\p{Script=Latin}/u.test(character));
  const cjk = Array.from(normalized).filter(character => (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)
  ));
  if (latin.length < 2 || cjk.length < 1 || Array.from(normalized).length < 3) return false;
  if (/^(?:dx|ver(?:sion)?|type|model)[\p{Letter}\p{Number}_.-]*[版型式號号款]?$/iu.test(normalized)) {
    return false;
  }
  if (cjk.length === 1 && /^[版型式號号款]$/u.test(cjk[0])) return false;
  return true;
};

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
  if (value.includes('×')) separators.push('×');
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

const extractParentheticalMetadata = (
  source: string,
  forms: string[],
  qualifiers: string[],
): string => source.replace(/\(([^)]+)\)/gu, (_match, content: string) => {
  const value = cleanValue(content);
  if (!value) return ' ';
  if (/^(?:再版|再販|一般版|普通版|通常版|原作版|限定版|basic|standard)$/iu.test(value)) {
    return ` ${value} `;
  }
  if (/(?:禮服|礼服|婚紗|婚纱|服裝|服装|形態|形态|模式|造型)$/u.test(value)) {
    forms.push(value);
    return ' ';
  }
  if (/^(?:可動|附特典|特典)$/u.test(value)) {
    qualifiers.push(value);
    return ' ';
  }
  return ` ${value} `;
});

const extractContextualVersions = (source: string, versions: string[]): string => source.replace(
  /(?:[·\s])([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][^\s·]{0,20})\s*ver\.?/giu,
  (_match, label: string) => {
    const value = `${cleanValue(label)} Ver.`;
    versions.push(value);
    return ' ';
  },
);

const CJK_MEMBER_PATTERN = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][\p{Letter}\p{Number}'-]{0,40}`;
const CJK_ONLY_PATTERN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u;
const COMPOUND_CHAIN_PATTERN = new RegExp(
  String.raw`${CJK_MEMBER_PATTERN}\s*[&/×]\s*${CJK_MEMBER_PATTERN}(?:\s*[&/×]\s*${CJK_MEMBER_PATTERN})*`,
  'gu',
);

const longestSharedCjkPrefix = (members: string[]): string => {
  let best = '';
  for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
      const left = members[leftIndex].match(/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/u)?.[0] ?? '';
      const right = members[rightIndex].match(/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/u)?.[0] ?? '';
      let length = 0;
      while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
      if (length >= 2 && length > best.length) best = left.slice(0, length);
    }
  }
  return best;
};

const normalizeCompoundMembers = (members: string[]): string[] => {
  const prefix = longestSharedCjkPrefix(members);
  if (!prefix || members.filter(member => member.startsWith(prefix)).length < 2) return members;
  return members.map(member => (
    CJK_ONLY_PATTERN.test(member) && !member.startsWith(prefix)
      ? `${prefix}${member}`
      : member
  ));
};

const extractCompoundSubjects = (
  source: string,
  compounds: ProxyCompoundSubjectV2[],
  subjects: string[],
  productLines: ProxySemanticProductLine[],
): string => {
  let output = '';
  let cursor = 0;

  for (const match of source.matchAll(COMPOUND_CHAIN_PATTERN)) {
    const raw = match[0];
    const offset = match.index;
    const separators = Array.from(raw.matchAll(/[&/×]/gu), item => item[0]);
    let members = raw.split(/[&/×]/gu).map(cleanValue).filter(Boolean);
    let replacementStart = offset;

    // Some ERP titles omit the first separator: "A B & C" while Catalog uses
    // "A / B & C". Include A only when A and B establish a distinctive CJK
    // family prefix and another explicit member omits that prefix. This keeps a
    // preceding series token out of ordinary "A & B" compound identities.
    const before = source.slice(cursor, offset);
    const preceding = before.match(new RegExp(String.raw`(${CJK_MEMBER_PATTERN})\s*$`, 'u'));
    if (preceding && productLines.includes('SMP')) {
      const precedingMember = cleanValue(preceding[1]);
      const prefix = longestSharedCjkPrefix([precedingMember, ...members]);
      const explicitMemberMissingPrefix = Boolean(prefix)
        && members.some(member => !member.startsWith(prefix));
      if (prefix && explicitMemberMissingPrefix) {
        members.unshift(precedingMember);
        replacementStart = offset - preceding[0].length;
      }
    }

    members = normalizeCompoundMembers(members);
    compounds.push({ members, relation: 'set', raw: cleanValue(source.slice(replacementStart, offset + raw.length)), separators });
    subjects.push(...members);
    output += source.slice(cursor, replacementStart);
    output += ' ';
    cursor = offset + raw.length;
  }

  return output + source.slice(cursor);
};

const normalizeVersionValue = (value: string): string => {
  const cleaned = cleanValue(value);
  return /^(?:再版|再販)$/u.test(cleaned) ? '再版' : cleaned;
};

const extractScale = (source: string, scales: string[]): string => source.replace(
  /\b1\s*\/\s*\d{1,2}\b/giu,
  match => {
    scales.push(match.replace(/\s+/gu, ''));
    return ' ';
  },
);

const extractScaleOrDimensionTrailingBusinessDate = (
  source: string,
  businessMetadata: string[],
): string => source.replace(
  /((?:\b1\s*\/\s*\d{1,2}\b)|(?:(?:全高\s*)?約?\s*\d+(?:\.\d+)?\s*(?:公分|cm|mm)(?:高|長|寬)?))\s+((?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?=\s|$)/giu,
  (_match, measuredValue: string, monthDay: string) => {
    businessMetadata.push(cleanValue(monthDay));
    return ` ${measuredValue} `;
  },
);

const extractModelCodes = (source: string, modelCodes: string[], businessMetadata: string[]): string => source.replace(
  /\b(?:[a-z]{1,6}[\s-]?)?\d{2,8}[a-z]{0,4}\b/giu,
  (match, offset: number, input: string) => {
    const previousCharacter = Array.from(input.slice(0, offset)).at(-1) ?? '';
    if (previousCharacter && hasCjk(previousCharacter)) return match;
    const value = cleanValue(match);
    if (/^(?:19|20)\d{2}$/u.test(value) || /^0\d{3}$/u.test(value)) businessMetadata.push(value);
    else modelCodes.push(value);
    return ' ';
  },
);

const tokenizeResidual = (source: string): string[] => source
  .replace(/[《》「」【】()[\]{}:：,，。!?！？]/gu, ' ')
  .replace(/[·/&×]/gu, ' ')
  .split(/\s+/u)
  .map(cleanValue)
  .filter(Boolean)
  .filter(token => !GENERIC_NON_IDENTITY.has(token.toLocaleLowerCase()));

type SubjectExtractionMode = 'legacy-v2' | 'v2.1' | 'v2.1-generalized';

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

const GENERALIZED_PRODUCT_LINE_TITLE_GRAMMAR = new Set<ProxySemanticProductLine>([
  ...PRODUCT_LINE_TITLE_GRAMMAR,
  'CHOUZOUKADOU',
  'PLAMATEA',
  'SMP',
]);

const GENERALIZED_PRODUCT_TYPE_TITLE_GRAMMAR = new Set<ProxySemanticProductType>([
  'FIGMA',
  'NENDOROID',
  'NENDOROID_DOLL',
  'POP_UP_PARADE',
]);

const PRODUCT_LINE_TYPE_INFERENCE: Partial<Record<ProxySemanticProductLine, ProxySemanticProductType>> = {
  KADOKAWA_PLASTIC_MODEL_SERIES: 'MODEL_KIT',
  KEMO_PLA: 'MODEL_KIT',
  SMP: 'MODEL_KIT',
  PLAMATEA: 'MODEL_KIT',
  CHOUZOUKADOU: 'ACTION_FIGURE',
  SHF: 'ACTION_FIGURE',
};

const meaningfulResidualTokens = (source: string): string[] => tokenizeResidual(source)
  .filter(token => hasCjk(token) || /[\p{Letter}]/u.test(token));

const extractSubjectV21 = (
  remaining: string,
  manufacturers: string[],
  productTypes: ProxySemanticProductType[],
  productLines: ProxySemanticProductLine[],
  versions: string[],
  scales: string[],
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

  const quotedSeriesSubject = remaining.match(
    /[《「]([^》」]+)[》」]\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][\p{Letter}\p{Number}'’·-]*)/u,
  );
  if (quotedSeriesSubject && quotedSeriesSubject.index !== undefined) {
    const before = remaining.slice(0, quotedSeriesSubject.index);
    const after = remaining.slice(quotedSeriesSubject.index + quotedSeriesSubject[0].length);
    return {
      subjects: [cleanValue(quotedSeriesSubject[2])],
      series: unique([
        cleanValue(quotedSeriesSubject[1]),
        ...meaningfulResidualTokens(quotedSeriesSubject[1]),
        ...meaningfulResidualTokens(`${before} ${after}`),
      ]),
      forms: [],
      resolution: 'RESOLVED_SUBJECT',
      evidence: ['QUOTED_SERIES_SUBJECT'],
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
  const mixedScriptSubjectIndex = residualTokens.findLastIndex(
    token => isProxyDistinctiveMixedScriptSubjectToken(token),
  );
  if (mixedScriptSubjectIndex >= 0) {
    return {
      subjects: [residualTokens[mixedScriptSubjectIndex]],
      series: residualTokens.filter((token, index) => (
        index !== mixedScriptSubjectIndex && !isProxyCreatorMetadataToken(token)
      )),
      forms: [],
      resolution: 'RESOLVED_SUBJECT',
      evidence: ['DISTINCTIVE_MIXED_SCRIPT_SUBJECT'],
      unresolvedTokens: [],
    };
  }

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

  const hasVersionBoundedStructure = versions.length > 0
    && residualTokens.length >= 2
    && (
      productLines.length > 0
      || (productTypes.length > 0 && scales.length > 0)
      || (manufacturers.length > 0 && scales.length > 0)
    );
  if (hasVersionBoundedStructure) {
    return {
      subjects: [residualTokens[residualTokens.length - 1]],
      series: residualTokens.slice(0, -1),
      forms: [],
      resolution: 'RESOLVED_SUBJECT',
      evidence: ['VERSION_BOUNDED_TITLE_GRAMMAR'],
      unresolvedTokens: [],
    };
  }

  return unresolved();
};

const extractSubjectV21Generalized = (
  remaining: string,
  productTypes: ProxySemanticProductType[],
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

  const quotedSeriesSubject = remaining.match(
    /[《「]([^》」]+)[》」]\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][\p{Letter}\p{Number}'’·-]*)/u,
  );
  if (quotedSeriesSubject && quotedSeriesSubject.index !== undefined) {
    const before = remaining.slice(0, quotedSeriesSubject.index);
    const after = remaining.slice(quotedSeriesSubject.index + quotedSeriesSubject[0].length);
    return {
      subjects: [cleanValue(quotedSeriesSubject[2])],
      series: unique([
        cleanValue(quotedSeriesSubject[1]),
        ...meaningfulResidualTokens(quotedSeriesSubject[1]),
        ...meaningfulResidualTokens(`${before} ${after}`),
      ]),
      forms: [],
      resolution: 'RESOLVED_SUBJECT',
      evidence: ['QUOTED_SERIES_SUBJECT'],
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

  const residualTokens = meaningfulResidualTokens(remaining)
    .filter(token => !isProxyCreatorMetadataToken(token));
  if (
    productLines.some(line => GENERALIZED_PRODUCT_LINE_TITLE_GRAMMAR.has(line))
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

  if (
    productTypes.some(type => GENERALIZED_PRODUCT_TYPE_TITLE_GRAMMAR.has(type))
    && residualTokens.length >= 2
  ) {
    return {
      subjects: [residualTokens[residualTokens.length - 1]],
      series: residualTokens.slice(0, -1),
      forms: [],
      resolution: 'RESOLVED_SUBJECT',
      evidence: ['VERSION_BOUNDED_TITLE_GRAMMAR'],
      unresolvedTokens: [],
    };
  }

  const mixedScriptSubjectIndex = residualTokens.findLastIndex(
    token => isProxyDistinctiveMixedScriptSubjectToken(token),
  );
  if (mixedScriptSubjectIndex >= 0) {
    return {
      subjects: [residualTokens[mixedScriptSubjectIndex]],
      series: residualTokens.filter((_token, index) => index !== mixedScriptSubjectIndex),
      forms: [],
      resolution: 'RESOLVED_SUBJECT',
      evidence: ['DISTINCTIVE_MIXED_SCRIPT_SUBJECT'],
      unresolvedTokens: [],
    };
  }

  return unresolved();
};

const candidateEvidenceFor = (
  evidence: ProxySubjectEvidenceV21[],
): ProxySubjectCandidateEvidenceV21[] => {
  const values = evidence.flatMap<ProxySubjectCandidateEvidenceV21>(value => {
    switch (value) {
      case 'PRODUCT_LINE_TITLE_GRAMMAR': return ['PRODUCT_LINE_GRAMMAR'];
      case 'QUOTED_SERIES_SUBJECT': return ['QUOTED_SUBJECT'];
      case 'COMPOUND_SUBJECT_SET': return ['COMPOUND_MEMBER'];
      case 'MULTI_TOKEN_PERSON_NAME': return ['MULTI_TOKEN_PERSON_NAME'];
      case 'ROLE_DELIMITED_SUBJECT': return ['ROLE_DELIMITED_SUBJECT'];
      case 'DISTINCTIVE_MIXED_SCRIPT_SUBJECT': return ['DISTINCTIVE_MIXED_SCRIPT'];
      case 'VERSION_BOUNDED_TITLE_GRAMMAR': return ['PRODUCT_TYPE_GRAMMAR'];
      default: return [];
    }
  });
  return unique(values);
};

const buildSubjectCandidatesV21 = (
  extraction: SubjectExtractionV21,
): ProxySubjectCandidateV21[] => {
  if (extraction.subjects.length > 0) {
    const evidence = candidateEvidenceFor(extraction.evidence);
    return extraction.subjects.map((value, index) => ({
      value,
      evidence,
      rank: index + 1,
      queryEligible: true,
    }));
  }

  const candidates = extraction.unresolvedTokens
    .map((value, index) => {
      const normalized = cleanValue(value);
      const distinctiveMixed = isProxyDistinctiveMixedScriptSubjectToken(normalized);
      const cjkLength = Array.from(normalized).filter(character => hasCjk(character)).length;
      const queryEligible = distinctiveMixed || cjkLength >= 2;
      return {
        value: normalized,
        evidence: [
          distinctiveMixed ? 'DISTINCTIVE_MIXED_SCRIPT' : 'UNRESOLVED_ENTITY_TOKEN',
        ] as ProxySubjectCandidateEvidenceV21[],
        queryEligible,
        // Unresolved names are normally ordered as Series/Family -> Subject.
        // Prefer the later distinctive entity token without falling back to
        // "last token wins": semantic exclusions still run first, and at most
        // three evidence-bearing candidates are emitted for retrieval only.
        score: (distinctiveMixed ? 100 : 0)
          + index * 10
          + Math.min(cjkLength, 8),
      };
    })
    .filter(candidate => (
      candidate.queryEligible
      && !isProxyCreatorMetadataToken(candidate.value)
      && !GENERIC_NON_IDENTITY.has(candidate.value.toLocaleLowerCase())
    ))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);

  return candidates.map((candidate, index) => ({
    value: candidate.value,
    evidence: candidate.evidence,
    rank: index + 1,
    queryEligible: candidate.queryEligible,
  }));
};

const buildProductTypeEvidenceV21 = (
  productTypes: ProxySemanticProductType[],
  productLines: ProxySemanticProductLine[],
  scales: string[],
): ProxyProductTypeEvidenceV21[] => {
  const evidence: ProxyProductTypeEvidenceV21[] = productTypes.map(productType => ({
    productType,
    source: 'EXPLICIT_MARKER',
  }));
  for (const productLine of productLines) {
    const inferredType = PRODUCT_LINE_TYPE_INFERENCE[productLine];
    if (!inferredType) continue;
    if (!productTypes.includes(inferredType)) productTypes.push(inferredType);
    evidence.push({
      productType: inferredType,
      source: 'PRODUCT_LINE',
      productLine,
    });
  }
  if (
    scales.length > 0
    && productTypes.length === 0
  ) {
    productTypes.push('SCALE_FIGURE');
    evidence.push({
      productType: 'SCALE_FIGURE',
      source: 'SCALE_WITHOUT_MODEL_KIT',
    });
  }
  return evidence.filter((item, index, values) => values.findIndex(candidate => (
    candidate.productType === item.productType
    && candidate.source === item.source
    && candidate.productLine === item.productLine
  )) === index);
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
): ProxyProductIdentityV2 | ProxyProductIdentityV21 | ProxyProductIdentityV21Metadata {
  const normalizedTitle = normalizeTitle(title);
  const manufacturers: string[] = [];
  const productTypes: ProxySemanticProductType[] = [];
  const productLines: ProxySemanticProductLine[] = [];
  const series: string[] = [];
  const subjects: string[] = [];
  const compoundSubjects: ProxyCompoundSubjectV2[] = [];
  const versions: string[] = [];
  const editions: string[] = [];
  const releaseStatuses: string[] = [];
  const forms: string[] = [];
  const scales: string[] = [];
  const dimensions: string[] = [];
  const modelCodes: string[] = [];
  const qualifiers: string[] = [];
  const businessMetadata: string[] = [];
  const separators = collectSeparators(normalizedTitle);

  let remaining = normalizedTitle;
  remaining = extractBracketForms(remaining, forms);
  if (subjectMode === 'v2.1-generalized') {
    remaining = extractParentheticalMetadata(remaining, forms, qualifiers);
  }
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
    subjectMode === 'legacy-v2' ? PRODUCT_TYPE_PATTERNS : V21_PRODUCT_TYPE_PATTERNS,
    productTypes,
  );
  if (subjectMode === 'v2.1-generalized') {
    remaining = extractScaleOrDimensionTrailingBusinessDate(remaining, businessMetadata);
  }
  remaining = extractScale(remaining, scales);
  remaining = recordMatchesAndRemove(
    remaining,
    subjectMode === 'legacy-v2' ? DIMENSION_PATTERNS : V21_DIMENSION_PATTERNS,
    dimensions,
  );
  if (subjectMode === 'v2.1-generalized') {
    remaining = recordMatchesAndRemove(remaining, NUMBERED_VERSION_PATTERNS, editions);
    remaining = extractContextualVersions(remaining, editions);
    remaining = recordMatchesAndRemove(remaining, RELEASE_STATUS_PATTERNS, releaseStatuses);
    remaining = recordMatchesAndRemove(remaining, V21_EDITION_PATTERNS, editions);
    versions.push(...editions, ...releaseStatuses);
  } else {
    remaining = recordMatchesAndRemove(remaining, NUMBERED_VERSION_PATTERNS, versions);
    remaining = extractContextualVersions(remaining, versions);
    remaining = recordMatchesAndRemove(
      remaining,
      subjectMode === 'v2.1' ? V21_VERSION_PATTERNS : VERSION_PATTERNS,
      versions,
    );
  }
  remaining = recordMatchesAndRemove(
    remaining,
    subjectMode === 'v2.1-generalized' ? GENERALIZED_QUALIFIER_PATTERNS : QUALIFIER_PATTERNS,
    qualifiers,
  );
  remaining = extractModelCodes(remaining, modelCodes, businessMetadata);

  const hadTransformationForm = /(?:^|\s)黑化(?=\s|$)/u.test(remaining);
  remaining = remaining.replace(/(?:^|\s)(黑化)(?=\s|$)/gu, (_match, form: string) => {
    forms.push(form);
    return ' ';
  });

  remaining = extractCompoundSubjects(remaining, compoundSubjects, subjects, productLines);
  const residualTokens = tokenizeResidual(remaining);
  const meaningful = residualTokens.filter(token => hasCjk(token) || /[\p{Letter}]/u.test(token));
  let subjectResolution: ProxySubjectResolutionV21 = 'UNRESOLVED_SUBJECT';
  let subjectEvidence: ProxySubjectEvidenceV21[] = [];
  let unresolvedSubjectTokens: string[] = [];

  let generalizedExtraction: SubjectExtractionV21 | null = null;
  if (subjectMode !== 'legacy-v2') {
    const extraction = subjectMode === 'v2.1-generalized'
      ? extractSubjectV21Generalized(
        remaining,
        productTypes,
        productLines,
        compoundSubjects,
        subjects,
      )
      : extractSubjectV21(
        remaining,
        manufacturers,
        productTypes,
        productLines,
        versions,
        scales,
        compoundSubjects,
        subjects,
      );
    if (subjectMode === 'v2.1-generalized') generalizedExtraction = extraction;
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
    versions: unique(versions.map(normalizeVersionValue)),
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
  if (subjectMode === 'v2.1-generalized') {
    const typeEvidence = buildProductTypeEvidenceV21(
      identity.productTypes,
      identity.productLines,
      identity.scales,
    );
    const extraction = generalizedExtraction ?? {
      subjects: [],
      series: [],
      forms: [],
      resolution: 'UNRESOLVED_SUBJECT' as const,
      evidence: [],
      unresolvedTokens: [],
    };
    return {
      ...identity,
      parserVersion: '2.1',
      subjectResolution,
      subjectEvidence,
      unresolvedSubjectTokens: unique(unresolvedSubjectTokens),
      metadataVersion: 'generalized-retrieval-phase1',
      subjectCandidates: buildSubjectCandidatesV21(extraction),
      editions: unique(editions.map(cleanValue)),
      releaseStatuses: unique(releaseStatuses.map(normalizeVersionValue)),
      productTypeEvidence: typeEvidence,
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

/**
 * Phase-1 generalized metadata parser. This is intentionally not consumed by
 * Candidate Retrieval or the Workbench runtime until the later integration
 * phase has passed its offline gates.
 */
export function parseProxyProductIdentityV21Metadata(
  title: string,
  manufacturerName = '',
): ProxyProductIdentityV21Metadata {
  return parseProxyProductIdentityInternal(
    title,
    manufacturerName,
    'v2.1-generalized',
  ) as ProxyProductIdentityV21Metadata;
}
