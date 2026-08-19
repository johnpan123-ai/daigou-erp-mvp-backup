import {
  parseProxyProductIdentityV2,
  type ProxyProductIdentityV2,
  type ProxySemanticProductLine,
  type ProxySemanticProductType,
} from './proxyProductIdentityV2';

export const MAX_PROXY_CATALOG_V2_QUERIES = 5;

const PRODUCT_TYPE_QUERY_LABELS: Partial<Record<ProxySemanticProductType, string>> = {
  FIGMA: 'figma',
  NENDOROID: '黏土人',
  NENDOROID_DOLL: '黏土娃',
  POP_UP_PARADE: 'POP UP PARADE',
  SCALE_FIGURE: 'Scale Figure',
  UNSCALED_FIGURE: '無比例模型',
  MODEL_KIT: '組裝模型',
  ACTION_FIGURE: '可動模型',
  PRIZE_FIGURE: '景品',
};

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

const normalizeQuery = (value: string): string => value
  .normalize('NFKC')
  .replace(/&amp;/giu, '&')
  .replace(/[’‘`']/gu, '')
  .replace(/[《》「」【】()[\]{}]/gu, ' ')
  .replace(/[・‧·]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

const uniqueQueries = (queries: string[]): string[] => Array.from(new Set(
  queries.map(normalizeQuery).filter(Boolean),
));

const subjectQuery = (identity: ProxyProductIdentityV2): string => {
  const compound = identity.compoundSubjects[0]?.members ?? [];
  if (compound.length > 0) return compound.join(' ');
  return identity.subjects.join(' ').trim();
};

const relevantVersion = (identity: ProxyProductIdentityV2): string => identity.versions.join(' ').trim();

const relevantSeries = (identity: ProxyProductIdentityV2): string => identity.series
  .filter(token => token.length > 1)
  .slice(-2)
  .join(' ')
  .trim();

/**
 * Next-only structured fallback planner for Parser v2.
 *
 * The order is deliberately progressive: strong metadata first, then a final
 * subject-only retrieval query. The subject fallback increases recall only;
 * the unchanged v2 Pilot matcher still has to prove subject/type/line/version
 * compatibility before any deadline can be accepted.
 */
export function buildProxyCatalogQueriesV2FromIdentity(identity: ProxyProductIdentityV2): string[] {
  const subject = subjectQuery(identity);
  if (!subject) return [];

  const line = identity.productLines
    .map(value => PRODUCT_LINE_QUERY_LABELS[value])
    .find(Boolean) ?? '';
  const type = identity.productTypes
    .map(value => PRODUCT_TYPE_QUERY_LABELS[value])
    .find(Boolean) ?? '';
  const series = relevantSeries(identity);
  const version = relevantVersion(identity);
  const modelCode = identity.modelCodes[0] ?? '';

  return uniqueQueries([
    modelCode ? `${modelCode} ${subject}` : '',
    line ? `${line} ${subject}` : '',
    type ? `${type} ${subject}` : '',
    series ? `${series} ${subject}` : '',
    version ? `${subject} ${version}` : '',
    subject,
  ]).slice(0, MAX_PROXY_CATALOG_V2_QUERIES - 1).concat(subject).filter(
    (query, index, queries) => queries.indexOf(query) === index,
  ).slice(0, MAX_PROXY_CATALOG_V2_QUERIES);
}

export function buildProxyCatalogQueriesV2(title: string): string[] {
  return buildProxyCatalogQueriesV2FromIdentity(parseProxyProductIdentityV2(title));
}
