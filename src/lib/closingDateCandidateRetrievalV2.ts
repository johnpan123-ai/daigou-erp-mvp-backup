import {
  parseProxyProductIdentityV21,
  type ProxyProductIdentityV21,
  type ProxySemanticProductLine,
} from './proxyProductIdentityV2';
import { normalizeProxyProductIdentity } from './proxyProductIdentity';

export const CLOSING_DATE_CATALOG_NATIVE_LIMIT = 5;
export const CLOSING_DATE_RELIABLE_NATIVE_TOP_N = 3;

export type ClosingDateCandidateQueryKind =
  | 'PRODUCT_LINE_SUBJECT'
  | 'SERIES_SUBJECT'
  | 'SUBJECT_VERSION_FORM'
  | 'SUBJECT';

export interface ClosingDateCandidateRetrievalQuery {
  text: string;
  priority: 1 | 2 | 3 | 4;
  kind: ClosingDateCandidateQueryKind;
}

const PRODUCT_LINE_QUERY_LABELS: Partial<Record<ProxySemanticProductLine, string>> = {
  KDCOLLE: 'KDcolle',
  KADOKAWA_PLASTIC_MODEL_SERIES: 'KADOKAWA PLASTIC MODEL SERIES',
  KEMO_PLA: 'KEMO PLA',
  SMP: 'SMP',
  SHF: 'S.H.Figuarts',
  PLAMATEA: 'PLAMATEA',
  CHOUZOUKADOU: '超像可動',
  T_SPARK_LEGACYSOUL: 'T-SPARK LEGACYSOUL',
  G_S_COLLECTION: 'G.S. Collection',
  YUMEMIRIZE: 'Yumemirize',
  RELAX_TIME: 'Relax time',
  HIKKAKE: 'Hikkake',
  CHOCOPUNI: 'Chocopuni',
  MOCHIPICO: 'MOCHIPICO',
};

const LOW_INFORMATION_TOKENS = new Set([
  '&',
  'pla',
  'pvc',
  '模型',
  '公仔',
  '完成品',
  '組裝模型',
  '無比例',
  '無比例模型',
  '可動模型',
  '景品',
  '盒玩',
  '魂商店',
  '商店限定',
  '附特典',
  '特典',
  '代理版',
  '一般版',
  '普通版',
  '通常版',
  'standard',
  '再販',
  '重販',
  '限定版',
  'dx',
  'ver',
  'version',
  'figma',
  '黏土人',
  'nendoroid',
  'pup',
  'pop',
  'up',
  'parade',
  'smp',
  'plamatea',
  'kdcolle',
  'kemo',
  's.h.figuarts',
  'gsc',
  'good',
  'smile',
  'company',
  'bandai',
  '萬代',
  '角川',
  'takaratomy',
]);

const normalizeQuery = (value: string): string => value
  .normalize('NFKC')
  .replace(/&amp;/giu, '&')
  .replace(/[’‘`']/gu, '')
  .replace(/[《》「」【】()[\]{}]/gu, ' ')
  .replace(/[・‧·]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

const compactQuery = (value: string): string => normalizeQuery(value).toLocaleLowerCase();

export const isLowInformationCatalogQuery = (query: string): boolean => {
  const normalized = compactQuery(query);
  if (!normalized) return true;
  if (LOW_INFORMATION_TOKENS.has(normalized)) return true;
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  return tokens.length === 0 || tokens.every(token => (
    LOW_INFORMATION_TOKENS.has(token)
    || /^\d+\/\d+$/u.test(token)
    || /^(?:約|全高|高約)?\d+(?:\.\d+)?(?:cm|mm|公分)$/iu.test(token)
    || /^\d{2,8}$/u.test(token)
  ));
};

const subjectQuery = (identity: ProxyProductIdentityV21): string => {
  const compound = identity.compoundSubjects[0]?.members ?? [];
  if (compound.length > 0) return normalizeQuery(compound.join(' '));
  return normalizeQuery(identity.subjects.join(' '));
};

const isBusinessSeriesToken = (token: string): boolean => (
  /^(?:第?[一二三四1234]季|(?:19|20)\d{2}|\d{2}年第?[一二三四1234]季)$/u.test(token.trim())
);

const fallbackSeriesQuery = (tokens: readonly string[]): string => normalizeQuery(
  tokens
    .filter(token => (
      token.trim().length > 1
      && !LOW_INFORMATION_TOKENS.has(compactQuery(token))
      && !isBusinessSeriesToken(token)
      && !/^\d{2,8}$/u.test(token.trim())
    ))
    .slice(-2)
    .join(' '),
);

const seriesQuery = (identity: ProxyProductIdentityV21): string => normalizeQuery(
  identity.series
    .filter(token => (
      token.trim().length > 1
      && !LOW_INFORMATION_TOKENS.has(compactQuery(token))
      && !isBusinessSeriesToken(token)
    ))
    .slice(-2)
    .join(' '),
);

const versionFormQuery = (identity: ProxyProductIdentityV21): string => normalizeQuery(
  Array.from(new Set([...identity.versions, ...identity.forms]))
    .filter(token => !LOW_INFORMATION_TOKENS.has(compactQuery(token)))
    .slice(0, 2)
    .join(' '),
);

/**
 * Candidate Retrieval v2 deliberately produces only a few high-information
 * native Catalog queries. It never falls back to a bare product type,
 * qualifier, full ERP title, or residual token.
 */
export function buildClosingDateCandidateRetrievalQueries(
  title: string,
): readonly ClosingDateCandidateRetrievalQuery[] {
  const identity = parseProxyProductIdentityV21(title);
  const fallbackIdentity = normalizeProxyProductIdentity(title);
  const structuredSubject = subjectQuery(identity);
  const subject = structuredSubject || normalizeQuery(fallbackIdentity.identityTokens[0] ?? '');
  if (!subject || isLowInformationCatalogQuery(subject)) return [];

  const productLine = identity.productLines
    .map(line => PRODUCT_LINE_QUERY_LABELS[line])
    .find(Boolean) ?? '';
  const series = seriesQuery(identity)
    || (!structuredSubject && !productLine ? fallbackSeriesQuery(fallbackIdentity.seriesTokens) : '');
  const versionForm = versionFormQuery(identity);
  const planned: ClosingDateCandidateRetrievalQuery[] = [
    {
      text: productLine ? `${productLine} ${subject}` : '',
      priority: 1,
      kind: 'PRODUCT_LINE_SUBJECT',
    },
    {
      text: series ? `${series} ${subject}` : '',
      priority: 2,
      kind: 'SERIES_SUBJECT',
    },
    {
      text: versionForm ? `${subject} ${versionForm}` : '',
      priority: 3,
      kind: 'SUBJECT_VERSION_FORM',
    },
    { text: subject, priority: 4, kind: 'SUBJECT' },
  ];

  const seen = new Set<string>();
  return planned.flatMap(query => {
    const text = normalizeQuery(query.text);
    const key = compactQuery(text);
    if (!text || seen.has(key) || isLowInformationCatalogQuery(text)) return [];
    seen.add(key);
    return [{ ...query, text }];
  });
}
