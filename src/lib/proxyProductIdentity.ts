export type ProxyProductType =
  | 'FIGMA'
  | 'NENDOROID'
  | 'NENDOROID_DOLL'
  | 'POP_UP_PARADE'
  | 'SCALE_FIGURE';

export interface ProxyProductIdentity {
  originalTitle: string;
  productType: ProxyProductType | null;
  identityTokens: string[];
  seriesTokens: string[];
  versionTokens: string[];
}

export interface ProxyCatalogCandidate {
  id?: string | number | null;
  name?: string | null;
  url?: string | null;
  slug?: string | null;
  catalog?: {
    deadlineAt?: string | null;
  } | null;
}

export interface ProxyCandidateScore<T extends ProxyCatalogCandidate = ProxyCatalogCandidate> {
  candidate: T;
  confidence: number;
  rejected: boolean;
  reason: 'type_conflict' | 'identity_missing' | 'scored';
  sourceIdentity: ProxyProductIdentity;
  candidateIdentity: ProxyProductIdentity;
}

export type ProxyCatalogSelection<T extends ProxyCatalogCandidate = ProxyCatalogCandidate> =
  | {
    status: 'match';
    candidate: T;
    confidence: number;
    runnerUpConfidence: number | null;
  }
  | {
    status: 'ambiguous';
    candidate: null;
    confidence: number;
    runnerUpConfidence: number;
    candidates: T[];
    message: string;
  }
  | {
    status: 'no_match';
    candidate: null;
    confidence: number;
    runnerUpConfidence: number | null;
    bestCandidate?: T;
    message: string;
  };

export const PROXY_IDENTITY_MIN_CONFIDENCE = 0.9;
export const PROXY_IDENTITY_AMBIGUITY_DELTA = 0.05;

const TYPE_PATTERNS: Array<{ type: ProxyProductType; patterns: RegExp[] }> = [
  {
    type: 'NENDOROID_DOLL',
    patterns: [/黏土娃/iu, /ねんどろいどどーる/iu, /nendoroid\s*doll/iu],
  },
  {
    type: 'POP_UP_PARADE',
    patterns: [/pop\s*up\s*parade/iu, /(?:^|\s)pup(?:\s|$)/iu],
  },
  {
    type: 'FIGMA',
    patterns: [/(?:^|\s)figma(?:\s|$)/iu],
  },
  {
    type: 'NENDOROID',
    patterns: [/黏土人/iu, /ねんどろいど/iu, /(?:^|\s)nendoroid(?:\s|$)/iu],
  },
  {
    type: 'SCALE_FIGURE',
    patterns: [/\b1\s*\/\s*[78]\b/iu, /scale\s*figure/iu, /スケールフィギュア/iu, /pvc\s*完成品/iu],
  },
];

const TYPE_REMOVERS = [
  /nendoroid\s*doll/giu,
  /ねんどろいどどーる/giu,
  /黏土娃/giu,
  /pop\s*up\s*parade/giu,
  /(?:^|\s)pup(?=\s|$)/giu,
  /(?:^|\s)figma(?=\s|$)/giu,
  /(?:^|\s)nendoroid(?=\s|$)/giu,
  /ねんどろいど/giu,
  /黏土人/giu,
  /\b1\s*\/\s*[78]\b/giu,
  /scale\s*figure/giu,
  /スケールフィギュア/giu,
  /pvc\s*完成品/giu,
];

const BUSINESS_AND_MAKER_REMOVERS = [
  /代理版\s*/giu,
  /(?:^|\s)(?:預購|廠商)(?=\s|$)/giu,
  /(?:^|\s)(?:GSC|MF|BANDAI|壽屋|Kotobukiya|ALTER|FREEing|Phat|WAVE|Aniplex|SEGA|Taito|Furyu|Myethos|Union Creative|Kadokawa|Medicom|Kaiyodo|Sentinel|Di molto bene|Hobby Max|eStream|BINDing|Ques Q|B-style|PLUM|AMAKUNI|AmiAmi|Chara-Ani|Broccoli|Megahouse|Chocopuni|ARTFX|S\.H\.Figuarts)(?=\s|$)/giu,
  /(?:玩偶|模型|景品)/giu,
];

const VERSION_TOKEN = /(?:^|[-_])(?:DX|DELUXE|BASIC)(?:$|[-_])|限定版|再販|特典版|(?:ver(?:sion)?\.?)$/iu;

const compactToken = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[\s\-_.・:：/／]/gu, '');

const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

export function detectProxyProductType(title: string): ProxyProductType | null {
  for (const entry of TYPE_PATTERNS) {
    if (entry.patterns.some(pattern => pattern.test(title))) return entry.type;
  }
  return null;
}

export function normalizeProxyProductIdentity(title: string): ProxyProductIdentity {
  const productType = detectProxyProductType(title);
  let cleaned = title;
  for (const pattern of TYPE_REMOVERS) cleaned = cleaned.replace(pattern, ' ');
  for (const pattern of BUSINESS_AND_MAKER_REMOVERS) cleaned = cleaned.replace(pattern, ' ');
  cleaned = cleaned
    .replace(/[！!？?／《》「」【】\[\]（）()]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  const tokens = cleaned.split(/\s+/u).filter(token => token.length >= 2);
  const versionTokens = tokens.filter(token => VERSION_TOKEN.test(token));
  const identityCandidates = tokens.filter(token => !VERSION_TOKEN.test(token));
  const identityTokens = identityCandidates.length > 0
    ? [identityCandidates[identityCandidates.length - 1]]
    : [];
  const identitySet = new Set(identityTokens);
  const seriesTokens = identityCandidates.filter(token => !identitySet.has(token));

  return {
    originalTitle: title,
    productType,
    identityTokens,
    seriesTokens,
    versionTokens,
  };
}

const TYPE_QUERY_ALIASES: Record<ProxyProductType, string[]> = {
  FIGMA: ['figma'],
  NENDOROID: ['黏土人', 'Nendoroid', 'ねんどろいど'],
  NENDOROID_DOLL: ['黏土娃', 'Nendoroid Doll', 'ねんどろいどどーる'],
  POP_UP_PARADE: ['POP UP PARADE'],
  SCALE_FIGURE: ['Scale Figure'],
};

export function buildProxyCatalogQueries(identity: ProxyProductIdentity): string[] {
  const coreIdentity = identity.identityTokens.join(' ').trim();
  if (!coreIdentity) return [];

  const queries: string[] = [];
  if (identity.productType) {
    for (const alias of TYPE_QUERY_ALIASES[identity.productType]) {
      queries.push(`${alias} ${coreIdentity}`);
    }
  }
  if (identity.seriesTokens.length > 0) {
    queries.push(`${identity.seriesTokens.join(' ')} ${coreIdentity}`);
  }
  queries.push(coreIdentity);
  return unique(queries);
}

const hasExactIdentity = (source: ProxyProductIdentity, candidate: ProxyProductIdentity): boolean => {
  if (source.identityTokens.length === 0 || candidate.identityTokens.length === 0) return false;
  const candidateTokens = new Set(candidate.identityTokens.map(compactToken));
  return source.identityTokens.some(token => candidateTokens.has(compactToken(token)));
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

export function scoreProxyCatalogCandidate<T extends ProxyCatalogCandidate>(
  sourceTitle: string,
  candidate: T,
): ProxyCandidateScore<T> {
  const sourceIdentity = normalizeProxyProductIdentity(sourceTitle);
  const candidateIdentity = normalizeProxyProductIdentity(candidate.name || '');

  if (
    sourceIdentity.productType
    && candidateIdentity.productType
    && sourceIdentity.productType !== candidateIdentity.productType
  ) {
    return {
      candidate,
      confidence: 0,
      rejected: true,
      reason: 'type_conflict',
      sourceIdentity,
      candidateIdentity,
    };
  }

  const identityMatched = hasExactIdentity(sourceIdentity, candidateIdentity);
  if (!identityMatched) {
    return {
      candidate,
      confidence: 0,
      rejected: true,
      reason: 'identity_missing',
      sourceIdentity,
      candidateIdentity,
    };
  }

  let confidence = 0.4;
  if (sourceIdentity.productType && sourceIdentity.productType === candidateIdentity.productType) {
    confidence += 0.55;
  }
  if (hasVersionMatch(sourceIdentity, candidateIdentity)) confidence += 0.05;
  confidence += Math.min(0.05, countSeriesMatches(sourceIdentity, candidateIdentity) * 0.025);

  return {
    candidate,
    confidence: Math.min(1, confidence),
    rejected: false,
    reason: 'scored',
    sourceIdentity,
    candidateIdentity,
  };
}

const candidateKey = (candidate: ProxyCatalogCandidate): string => {
  const stableId = candidate.id ?? candidate.url ?? candidate.slug;
  if (stableId !== null && stableId !== undefined && String(stableId).trim()) {
    return String(stableId).trim();
  }
  return `${candidate.name || ''}::${candidate.catalog?.deadlineAt || ''}`;
};

export function selectProxyCatalogCandidate<T extends ProxyCatalogCandidate>(
  sourceTitle: string,
  candidates: T[],
): ProxyCatalogSelection<T> {
  const deduped = Array.from(new Map(candidates.map(candidate => [candidateKey(candidate), candidate])).values());
  const scored = deduped
    .map(candidate => scoreProxyCatalogCandidate(sourceTitle, candidate))
    .filter(result => !result.rejected)
    .sort((left, right) => right.confidence - left.confidence);

  const top = scored[0];
  const runnerUp = scored[1];
  if (!top || top.confidence < PROXY_IDENTITY_MIN_CONFIDENCE) {
    return {
      status: 'no_match',
      candidate: null,
      confidence: top?.confidence ?? 0,
      runnerUpConfidence: runnerUp?.confidence ?? null,
      bestCandidate: top?.candidate,
      message: '無法可靠識別商品，需要人工確認',
    };
  }

  if (
    runnerUp
    && runnerUp.confidence >= PROXY_IDENTITY_MIN_CONFIDENCE
    && top.confidence - runnerUp.confidence < PROXY_IDENTITY_AMBIGUITY_DELTA
  ) {
    return {
      status: 'ambiguous',
      candidate: null,
      confidence: top.confidence,
      runnerUpConfidence: runnerUp.confidence,
      candidates: [top.candidate, runnerUp.candidate],
      message: '找到多筆相似商品，需要人工確認',
    };
  }

  return {
    status: 'match',
    candidate: top.candidate,
    confidence: top.confidence,
    runnerUpConfidence: runnerUp?.confidence ?? null,
  };
}

export function isSafeProxyCatalogSelection<T extends ProxyCatalogCandidate>(
  sourceTitle: string,
  selection: ProxyCatalogSelection<T>,
): selection is Extract<ProxyCatalogSelection<T>, { status: 'match' }> {
  if (selection.status !== 'match') return false;
  const verification = scoreProxyCatalogCandidate(sourceTitle, selection.candidate);
  return !verification.rejected && verification.confidence >= PROXY_IDENTITY_MIN_CONFIDENCE;
}
