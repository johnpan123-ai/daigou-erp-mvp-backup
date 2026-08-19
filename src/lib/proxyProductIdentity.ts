export type ProxyProductType = 'FIGMA' | 'NENDOROID' | 'NENDOROID_DOLL' | 'POP_UP_PARADE' | 'SCALE_FIGURE';
export type ProxyProductLine = 'YUMEMIRIZE' | 'RELAX_TIME' | 'HIKKAKE' | 'CHOCOPUNI' | 'MOCHIPICO' | 'SMP' | 'SHF' | 'PLAMATEA' | 'T_SPARK_LEGACYSOUL' | 'G_S_COLLECTION';
export type ProxyManufacturer = 'GSC' | 'SEGA' | 'BANDAI' | 'FURYU' | 'TAITO' | 'TAKARATOMY';

export interface ProxyProductIdentity {
  originalTitle: string;
  productType: ProxyProductType | null;
  productLine: ProxyProductLine | null;
  manufacturer: ProxyManufacturer | null;
  size: string | null;
  scale: string | null;
  identityTokens: string[];
  identityCandidates: string[];
  identityAliases: string[];
  seriesTokens: string[];
  versionTokens: string[];
  modelNumbers: string[];
  ignoredTokens: string[];
}

export interface ProxyCatalogCandidate {
  id?: string | number | null;
  name?: string | null;
  url?: string | null;
  slug?: string | null;
  sku?: string | null;
  janCode?: string | null;
  manufacturer?: string | null;
  brand?: { name?: string | null } | null;
  catalog?: {
    deadlineAt?: string | null;
    supplier?: { code?: string | null } | null;
  } | null;
}

export interface ProxyCandidateScore<T extends ProxyCatalogCandidate = ProxyCatalogCandidate> {
  candidate: T;
  confidence: number;
  rejected: boolean;
  reason: 'type_conflict' | 'product_line_conflict' | 'size_conflict' | 'identity_missing' | 'scored';
  sourceIdentity: ProxyProductIdentity;
  candidateIdentity: ProxyProductIdentity;
}

export type ProxyCatalogSelection<T extends ProxyCatalogCandidate = ProxyCatalogCandidate> =
  | { status: 'match'; candidate: T; confidence: number; runnerUpConfidence: number | null }
  | { status: 'ambiguous'; candidate: null; confidence: number; runnerUpConfidence: number; candidates: T[]; message: string }
  | { status: 'no_match'; candidate: null; confidence: number; runnerUpConfidence: number | null; bestCandidate?: T; message: string };

export const PROXY_IDENTITY_MIN_CONFIDENCE = 0.9;
export const PROXY_IDENTITY_AMBIGUITY_DELTA = 0.05;
export const PROXY_DEFAULT_SUPPLIER_PRIORITY = ['wanrong'] as const;
export const MAX_PROXY_CATALOG_QUERIES = 8;

const TYPE_PATTERNS: Array<{ type: ProxyProductType; patterns: RegExp[] }> = [
  { type: 'NENDOROID_DOLL', patterns: [/黏土娃/iu, /ねんどろいどどーる/iu, /nendoroid\s*doll/iu] },
  { type: 'POP_UP_PARADE', patterns: [/pop\s*up\s*parade/iu, /(?:^|\s)pup(?:\s|$)/iu] },
  { type: 'FIGMA', patterns: [/(?:^|\s)figma(?:\s|$)/iu] },
  { type: 'NENDOROID', patterns: [/黏土人/iu, /ねんどろいど/iu, /(?:^|\s)nendoroid(?:\s|$)/iu] },
  { type: 'SCALE_FIGURE', patterns: [/\b1\s*\/\s*\d{1,2}\b/iu, /scale\s*figure/iu, /スケールフィギュア/iu, /pvc\s*完成品/iu] },
];

const PRODUCT_LINE_PATTERNS: Array<{ line: ProxyProductLine; patterns: RegExp[] }> = [
  { line: 'YUMEMIRIZE', patterns: [/yumemirize/iu] },
  { line: 'RELAX_TIME', patterns: [/relax\s*time/iu, /休息時光/iu] },
  { line: 'HIKKAKE', patterns: [/hikkake/iu, /趴趴公仔/iu] },
  { line: 'CHOCOPUNI', patterns: [/chocopuni/iu] },
  { line: 'MOCHIPICO', patterns: [/mochipico/iu] },
  { line: 'SMP', patterns: [/(?:^|\s)SMP(?=\s|$)/iu] },
  { line: 'SHF', patterns: [/s\.?\s*h\.?\s*f(?:iguarts)?/iu, /(?:^|\s)SHF(?=\s|$)/iu] },
  { line: 'PLAMATEA', patterns: [/plamatea/iu] },
  { line: 'T_SPARK_LEGACYSOUL', patterns: [/t[\s-]*spark\s*legacysoul/iu] },
  { line: 'G_S_COLLECTION', patterns: [/g\.?\s*s\.?\s*collection/iu] },
];

const TYPE_REMOVERS = [
  /nendoroid\s*doll/giu, /ねんどろいどどーる/giu, /黏土娃/giu,
  /pop\s*up\s*parade/giu, /(?:^|\s)pup(?=\s|$)/giu,
  /(?:^|\s)figma(?=\s|$)/giu, /(?:^|\s)nendoroid(?=\s|$)/giu,
  /ねんどろいど/giu, /黏土人/giu, /scale\s*figure/giu, /スケールフィギュア/giu,
];

const PRODUCT_LINE_REMOVERS = [
  /yumemirize/giu, /relax\s*time/giu, /休息時光/giu,
  /hikkake/giu, /趴趴公仔/giu, /chocopuni/giu, /mochipico/giu,
  /(?:^|\s)SMP(?=\s|$)/giu, /s\.?\s*h\.?\s*f(?:iguarts)?/giu,
  /(?:^|\s)SHF(?=\s|$)/giu, /plamatea/giu, /t[\s-]*spark\s*legacysoul/giu,
  /g\.?\s*s\.?\s*collection/giu,
];

const BUSINESS_AND_MAKER_REMOVERS = [
  /【[^】]*】/gu,
  /(?:^|\s)(?:代理版|代理|預購|廠商)(?=\s|$)/giu,
  /(?:^|\s)(?:GSC|Good\s*Smile(?:\s*Company)?|MF|BANDAI|萬代|TAKARATOMY|壽屋|Kotobukiya|ALTER|FREEing|Phat!?|WAVE|Aniplex|SEGA|Taito|Furyu|Myethos|Union\s*Creative|Kadokawa|Medicom|Kaiyodo|Sentinel|Di\s*molto\s*bene|Hobby\s*Max|eStream|BINDing|Ques\s*Q|B-style|PLUM|AMAKUNI|AmiAmi|Chara-Ani|Broccoli|Megahouse)(?=\s|$)/giu,
  /(?:^|\s)(?:玩偶|模型|景品|公仔|完成品|PVC|組裝模型|盒玩|大型絨毛|泡麵蓋公仔|大尺寸\d+公分玩偶|原創插畫)(?=\s|$)/giu,
];

const VERSION_TOKEN = /(?:^|[-_])(?:DX|DELUXE|BASIC|SUPER_HERO)(?:$|[-_])|限定版|限定服|再版|再販|附特典|特典|H\.?D\.?|(?:ver(?:sion)?\.?)$|ver\.?/iu;
const BUSINESS_OR_GENERIC_TOKEN = /^(?:代理版?|預購|廠商|PVC|完成品|公仔|模型|景品|玩偶|組裝模型|盒玩|大型絨毛|泡麵蓋公仔|原創插畫)$/iu;
const DATE_TOKEN = /^(?:(?:19|20)\d{2}|\d{2,4}[/-]\d{1,2}|0\d{3})$/u;
const MODEL_TOKEN = /^\d{3,5}$/u;
const SCALE_PATTERN = /\b(1\s*\/\s*\d{1,2})\b/iu;
const SCALE_REMOVER = /\b1\s*\/\s*\d{1,2}\b/giu;
const SIZE_PATTERN = /(?:^|\s)(XXL|XL|L|M|S)\s*Size(?=\s|$)/iu;
const SIZE_REMOVER = /(?:^|\s)(?:XXL|XL|L|M|S)\s*Size(?=\s|$)/giu;
const RELEASE_DATE_REMOVERS = [
  /(?:^|\s)(?:19|20)?\d{2}年\d{1,2}月(?=\s|$)/gu,
  /(?:^|\s)\d{1,2}年\d{1,2}月(?=\s|$)/gu,
];

const TYPE_QUERY_ALIASES: Record<ProxyProductType, string[]> = {
  FIGMA: ['figma'],
  NENDOROID: ['黏土人', 'Nendoroid', 'ねんどろいど'],
  NENDOROID_DOLL: ['黏土娃', 'Nendoroid Doll', 'ねんどろいどどーる'],
  POP_UP_PARADE: ['POP UP PARADE'],
  SCALE_FIGURE: ['Scale Figure'],
};

const PRODUCT_LINE_QUERY_ALIASES: Record<ProxyProductLine, string[]> = {
  YUMEMIRIZE: ['Yumemirize'], RELAX_TIME: ['Relax time'], HIKKAKE: ['Hikkake'],
  CHOCOPUNI: ['Chocopuni'], MOCHIPICO: ['MOCHIPICO'], SMP: ['SMP'],
  SHF: ['S.H.Figuarts', 'SHF'], PLAMATEA: ['PLAMATEA'],
  T_SPARK_LEGACYSOUL: ['T-SPARK LEGACYSOUL'],
  G_S_COLLECTION: ['G.S. Collection'],
};

const MANUFACTURER_QUERY_ALIASES: Partial<Record<ProxyManufacturer, string[]>> = {
  TAKARATOMY: ['TAKARATOMY'],
};

const compactToken = (value: string): string => value.toLocaleLowerCase().replace(/[\s\-_.・‧:：/／]/gu, '');
const unique = (values: string[]): string[] => Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
const hasCjk = (value: string): boolean => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
const NON_IDENTITY_ALIAS_TOKENS = new Set([
  'archive', 'english', 'production', 'hololive', 'hero', 'super', 'mujica',
  'dream', 'box', 'fgo', 'assassin', 'fate', 'if', 'side',
]);

export function detectProxyProductType(title: string): ProxyProductType | null {
  for (const entry of TYPE_PATTERNS) if (entry.patterns.some(pattern => pattern.test(title))) return entry.type;
  return null;
}

export function detectProxyProductLine(title: string): ProxyProductLine | null {
  for (const entry of PRODUCT_LINE_PATTERNS) if (entry.patterns.some(pattern => pattern.test(title))) return entry.line;
  return null;
}

const detectProxyManufacturer = (title: string, manufacturerName: string): ProxyManufacturer | null => {
  const combined = `${title} ${manufacturerName}`;
  if (/(?:^|\s)GSC(?=\s|$)|Good\s*Smile(?:\s*Company)?|Goodsmile/iu.test(combined)) return 'GSC';
  if (/(?:^|\s)SEGA(?=\s|$)/iu.test(combined)) return 'SEGA';
  if (/(?:^|\s)BANDAI(?=\s|$)|萬代/iu.test(combined)) return 'BANDAI';
  if (/(?:^|\s)FURYU(?=\s|$)/iu.test(combined)) return 'FURYU';
  if (/(?:^|\s)TAITO(?=\s|$)/iu.test(combined)) return 'TAITO';
  if (/(?:^|\s)TAKARATOMY(?=\s|$)|TAKARA\s*TOMY/iu.test(combined)) return 'TAKARATOMY';
  return null;
};

const normalizeCatalogQueryText = (value: string): string => value
  .normalize('NFKC')
  .replace(/[’‘`']/gu, '')
  .replace(/彈珠人/gu, '彈珠超人')
  .replace(/\s+/gu, ' ')
  .trim();

const uniqueCatalogQueries = (values: string[]): string[] => unique(values.map(normalizeCatalogQueryText));

const IMPORTANT_SERIES_IGNORES = /^(?:商店限定|限定|代理版?|預購|廠商)$/iu;

const importantSeriesTokens = (identity: ProxyProductIdentity): string[] => uniqueCatalogQueries(
  identity.seriesTokens.filter(token => !IMPORTANT_SERIES_IGNORES.test(token)),
);

const contextualProductLineAliases = (identity: ProxyProductIdentity, seriesTokens: string[]): string[] => {
  const compactSeries = new Set(seriesTokens.map(compactToken));
  if (identity.manufacturer === 'TAKARATOMY' && compactSeries.has(compactToken('彈珠超人'))) {
    return PRODUCT_LINE_QUERY_ALIASES.T_SPARK_LEGACYSOUL;
  }
  return [];
};

const deriveIdentityAliases = (tokens: string[], primaryIndex: number, primary: string): string[] => {
  const aliases: string[] = [];
  if (/[・‧]/u.test(primary)) aliases.push(...primary.split(/[・‧]/u));
  const previous = tokens[primaryIndex - 1];
  if (previous && hasCjk(previous) && hasCjk(primary)) {
    let sharedPrefixLength = 0;
    while (
      sharedPrefixLength < previous.length
      && sharedPrefixLength < primary.length
      && previous[sharedPrefixLength] === primary[sharedPrefixLength]
    ) sharedPrefixLength += 1;
    if (sharedPrefixLength >= 2) aliases.push(previous);
  }
  const following = tokens.slice(primaryIndex + 1).filter(token => /^[\p{Script=Latin}][\p{Script=Latin}'’-]*$/u.test(token));
  if (
    previous
    && /^[\p{Script=Latin}][\p{Script=Latin}'’-]{2,}$/u.test(previous)
    && !NON_IDENTITY_ALIAS_TOKENS.has(previous.toLocaleLowerCase())
  ) aliases.push(previous);
  if (following.length > 0) {
    aliases.push(...following.slice(0, 2));
    if (following.length >= 2) aliases.push(following.slice(0, 2).join(' '));
  }
  return unique(aliases).filter(alias => compactToken(alias) !== compactToken(primary));
};

export function normalizeProxyProductIdentity(title: string, manufacturerName = ''): ProxyProductIdentity {
  const productType = detectProxyProductType(title);
  const productLine = detectProxyProductLine(title);
  const manufacturer = detectProxyManufacturer(title, manufacturerName);
  const size = title.match(SIZE_PATTERN)?.[1]?.toUpperCase() ?? null;
  const scale = title.match(SCALE_PATTERN)?.[1]?.replace(/\s+/gu, '') ?? null;
  let cleaned = title.replace(/【[^】]*】/gu, ' ');
  for (const pattern of RELEASE_DATE_REMOVERS) cleaned = cleaned.replace(pattern, ' ');
  for (const pattern of PRODUCT_LINE_REMOVERS) cleaned = cleaned.replace(pattern, ' ');
  for (const pattern of TYPE_REMOVERS) cleaned = cleaned.replace(pattern, ' ');
  for (const pattern of BUSINESS_AND_MAKER_REMOVERS) cleaned = cleaned.replace(pattern, ' ');
  cleaned = cleaned.replace(SIZE_REMOVER, ' ').replace(SCALE_REMOVER, ' ').replace(/SUPER\s+HERO/giu, 'SUPER_HERO');
  cleaned = cleaned.replace(/[！!？?／《》「」【】\[\]（）()]/gu, ' ').replace(/[：:]/gu, ' ').replace(/\s+/gu, ' ').trim();

  const rawTokens = cleaned.split(/\s+/u).filter(Boolean);
  const versionTokens: string[] = [];
  const modelNumbers: string[] = [];
  const ignoredTokens: string[] = [];
  const coreTokens: string[] = [];
  for (const token of rawTokens) {
    if (VERSION_TOKEN.test(token)) versionTokens.push(token.replace(/_/gu, ' '));
    else if (BUSINESS_OR_GENERIC_TOKEN.test(token) || DATE_TOKEN.test(token)) ignoredTokens.push(token);
    else if (MODEL_TOKEN.test(token)) modelNumbers.push(token);
    else coreTokens.push(token);
  }

  const cjkIndexes = coreTokens.map((token, index) => (hasCjk(token) ? index : -1)).filter(index => index >= 0);
  const primaryIndex = cjkIndexes.length > 0 ? cjkIndexes[cjkIndexes.length - 1] : coreTokens.length - 1;
  const primaryIdentity = primaryIndex >= 0 ? coreTokens[primaryIndex] : '';
  const identityAliases = primaryIdentity ? deriveIdentityAliases(coreTokens, primaryIndex, primaryIdentity) : [];
  const identityCandidates = unique([primaryIdentity, ...identityAliases]);
  const identityTokens = primaryIdentity ? [primaryIdentity] : [];
  const seriesTokens = coreTokens.filter((_token, index) => index !== primaryIndex);

  return {
    originalTitle: title, productType, productLine, manufacturer, size, scale,
    identityTokens, identityCandidates, identityAliases, seriesTokens,
    versionTokens, modelNumbers, ignoredTokens,
  };
}

export function buildProxyCatalogQueries(identity: ProxyProductIdentity): string[] {
  const primaryIdentity = identity.identityTokens[0]?.trim() ?? '';
  if (!primaryIdentity) return [];
  const primaryQueries: string[] = [];
  const aliasQueries: string[] = [];
  const sizeSuffix = identity.size ? ` ${identity.size} Size` : '';
  if (identity.productLine) {
    for (const alias of PRODUCT_LINE_QUERY_ALIASES[identity.productLine]) {
      if (sizeSuffix) primaryQueries.push(`${alias} ${primaryIdentity}${sizeSuffix}`);
      primaryQueries.push(`${alias} ${primaryIdentity}`);
      for (const candidate of identity.identityAliases) aliasQueries.push(`${alias} ${candidate}`);
    }
  }
  if (identity.productType) {
    for (const alias of TYPE_QUERY_ALIASES[identity.productType]) {
      if (sizeSuffix) primaryQueries.push(`${alias} ${primaryIdentity}${sizeSuffix}`);
      primaryQueries.push(`${alias} ${primaryIdentity}`);
      for (const candidate of identity.identityAliases) aliasQueries.push(`${alias} ${candidate}`);
    }
  }
  const significantSeriesTokens = importantSeriesTokens(identity);
  const seriesContext = significantSeriesTokens.slice(-2).join(' ').trim();
  const qualifierContext = identity.versionTokens.filter(token => !/^(?:再版|再販|附特典|特典)$/u.test(token)).join(' ');
  const contextQueries = seriesContext
    ? unique([
      qualifierContext ? `${seriesContext} ${primaryIdentity} ${qualifierContext}` : '',
      `${seriesContext} ${primaryIdentity}${sizeSuffix}`,
    ])
    : [];
  const queryLineAliases = contextualProductLineAliases(identity, significantSeriesTokens);
  const manufacturerAliases = identity.manufacturer ? (MANUFACTURER_QUERY_ALIASES[identity.manufacturer] ?? []) : [];
  const firstSeries = significantSeriesTokens[0] ?? '';
  const lastSeries = significantSeriesTokens.at(-1) ?? '';
  const seriesOnlyQueries = uniqueCatalogQueries([
    firstSeries && lastSeries && firstSeries !== lastSeries ? `${firstSeries} ${lastSeries}` : '',
    ...queryLineAliases.map(alias => firstSeries ? `${alias} ${firstSeries}` : alias),
    ...manufacturerAliases.map(alias => lastSeries ? `${alias} ${lastSeries}` : alias),
    lastSeries,
    ...manufacturerAliases,
  ]);
  const fallbackQuery = `${primaryIdentity}${sizeSuffix}`;
  const preferred = uniqueCatalogQueries([
    ...primaryQueries,
    ...seriesOnlyQueries,
    ...contextQueries,
    ...aliasQueries,
    ...identity.identityAliases.map(alias => `${alias}${sizeSuffix}`),
  ]);
  const normalizedFallback = normalizeCatalogQueryText(fallbackQuery);
  if (preferred.includes(normalizedFallback)) return preferred.slice(0, MAX_PROXY_CATALOG_QUERIES);
  return uniqueCatalogQueries([...preferred.slice(0, MAX_PROXY_CATALOG_QUERIES - 1), normalizedFallback]);
}

const hasExactIdentity = (source: ProxyProductIdentity, candidate: ProxyProductIdentity): boolean => {
  if (source.identityCandidates.length === 0 || candidate.identityCandidates.length === 0) return false;
  const candidateTokens = new Set(candidate.identityCandidates.map(compactToken));
  return source.identityCandidates.some(token => candidateTokens.has(compactToken(token)));
};

const countSeriesMatches = (source: ProxyProductIdentity, candidate: ProxyProductIdentity): number => {
  const candidateTokens = new Set(candidate.seriesTokens.map(compactToken));
  return source.seriesTokens.filter(token => candidateTokens.has(compactToken(token))).length;
};

const hasVersionMatch = (source: ProxyProductIdentity, candidate: ProxyProductIdentity): boolean => {
  if (source.versionTokens.length === 0 || candidate.versionTokens.length === 0) return false;
  const candidateVersions = new Set(candidate.versionTokens.map(compactToken));
  return source.versionTokens.some(token => candidateVersions.has(compactToken(token)));
};

export function scoreProxyCatalogCandidate<T extends ProxyCatalogCandidate>(sourceTitle: string, candidate: T): ProxyCandidateScore<T> {
  const sourceIdentity = normalizeProxyProductIdentity(sourceTitle);
  const candidateIdentity = normalizeProxyProductIdentity(candidate.name || '', candidate.manufacturer || candidate.brand?.name || '');
  if (sourceIdentity.productType && candidateIdentity.productType && sourceIdentity.productType !== candidateIdentity.productType) {
    return { candidate, confidence: 0, rejected: true, reason: 'type_conflict', sourceIdentity, candidateIdentity };
  }
  if (sourceIdentity.productLine && candidateIdentity.productLine && sourceIdentity.productLine !== candidateIdentity.productLine) {
    return { candidate, confidence: 0, rejected: true, reason: 'product_line_conflict', sourceIdentity, candidateIdentity };
  }
  if (sourceIdentity.size && candidateIdentity.size && sourceIdentity.size !== candidateIdentity.size) {
    return { candidate, confidence: 0, rejected: true, reason: 'size_conflict', sourceIdentity, candidateIdentity };
  }
  if (!hasExactIdentity(sourceIdentity, candidateIdentity)) {
    return { candidate, confidence: 0, rejected: true, reason: 'identity_missing', sourceIdentity, candidateIdentity };
  }

  let confidence = 0.4;
  if (sourceIdentity.productType && sourceIdentity.productType === candidateIdentity.productType) confidence += 0.55;
  if (sourceIdentity.productLine && sourceIdentity.productLine === candidateIdentity.productLine) confidence += 0.55;
  if (sourceIdentity.size && sourceIdentity.size === candidateIdentity.size) confidence += 0.03;
  if (sourceIdentity.manufacturer && sourceIdentity.manufacturer === candidateIdentity.manufacturer) confidence += 0.02;
  if (hasVersionMatch(sourceIdentity, candidateIdentity)) confidence += 0.05;
  confidence += Math.min(0.05, countSeriesMatches(sourceIdentity, candidateIdentity) * 0.025);
  return { candidate, confidence: Math.min(1, confidence), rejected: false, reason: 'scored', sourceIdentity, candidateIdentity };
}

const candidateKey = (candidate: ProxyCatalogCandidate): string => {
  const stableId = candidate.id ?? candidate.url ?? candidate.slug;
  if (stableId !== null && stableId !== undefined && String(stableId).trim()) return String(stableId).trim();
  return `${candidate.name || ''}::${candidate.catalog?.deadlineAt || ''}`;
};

const productIdentityKey = (identity: ProxyProductIdentity): string => JSON.stringify({
  productType: identity.productType,
  productLine: identity.productLine,
  identityTokens: identity.identityTokens.map(compactToken).sort(),
  size: identity.size,
  versionTokens: identity.versionTokens.map(compactToken).sort(),
});

const supplierPriority = (candidate: ProxyCatalogCandidate): number => {
  const supplierCode = candidate.catalog?.supplier?.code?.trim().toLocaleLowerCase() ?? '';
  const index = PROXY_DEFAULT_SUPPLIER_PRIORITY.indexOf(supplierCode as (typeof PROXY_DEFAULT_SUPPLIER_PRIORITY)[number]);
  return index === -1 ? PROXY_DEFAULT_SUPPLIER_PRIORITY.length : index;
};

const chooseSupplierListing = <T extends ProxyCatalogCandidate>(matches: ProxyCandidateScore<T>[]): ProxyCandidateScore<T> => [...matches].sort((left, right) => {
  const priorityDifference = supplierPriority(left.candidate) - supplierPriority(right.candidate);
  if (priorityDifference !== 0) return priorityDifference;
  return right.confidence - left.confidence;
})[0];

export function selectProxyCatalogCandidate<T extends ProxyCatalogCandidate>(sourceTitle: string, candidates: T[]): ProxyCatalogSelection<T> {
  const deduped = Array.from(new Map(candidates.map(candidate => [candidateKey(candidate), candidate])).values());
  const scored = deduped.map(candidate => scoreProxyCatalogCandidate(sourceTitle, candidate)).filter(result => !result.rejected);
  const groupedByIdentity = new Map<string, ProxyCandidateScore<T>[]>();
  for (const result of scored) {
    const key = productIdentityKey(result.candidateIdentity);
    const matches = groupedByIdentity.get(key) ?? [];
    matches.push(result);
    groupedByIdentity.set(key, matches);
  }
  const identityGroups = Array.from(groupedByIdentity.values()).map(matches => ({
    identityConfidence: Math.max(...matches.map(match => match.confidence)),
    selectedListing: chooseSupplierListing(matches),
  })).sort((left, right) => right.identityConfidence - left.identityConfidence);

  const top = identityGroups[0];
  const runnerUp = identityGroups[1];
  if (!top || top.identityConfidence < PROXY_IDENTITY_MIN_CONFIDENCE) {
    return { status: 'no_match', candidate: null, confidence: top?.identityConfidence ?? 0, runnerUpConfidence: runnerUp?.identityConfidence ?? null, bestCandidate: top?.selectedListing.candidate, message: '無法可靠識別商品，需要人工確認' };
  }
  if (runnerUp && runnerUp.identityConfidence >= PROXY_IDENTITY_MIN_CONFIDENCE && top.identityConfidence - runnerUp.identityConfidence < PROXY_IDENTITY_AMBIGUITY_DELTA) {
    return { status: 'ambiguous', candidate: null, confidence: top.identityConfidence, runnerUpConfidence: runnerUp.identityConfidence, candidates: [top.selectedListing.candidate, runnerUp.selectedListing.candidate], message: '找到多筆相似商品，需要人工確認' };
  }
  return { status: 'match', candidate: top.selectedListing.candidate, confidence: top.selectedListing.confidence, runnerUpConfidence: runnerUp?.identityConfidence ?? null };
}

export function isSafeProxyCatalogSelection<T extends ProxyCatalogCandidate>(sourceTitle: string, selection: ProxyCatalogSelection<T>): selection is Extract<ProxyCatalogSelection<T>, { status: 'match' }> {
  if (selection.status !== 'match') return false;
  const verification = scoreProxyCatalogCandidate(sourceTitle, selection.candidate);
  return !verification.rejected && verification.confidence >= PROXY_IDENTITY_MIN_CONFIDENCE;
}
