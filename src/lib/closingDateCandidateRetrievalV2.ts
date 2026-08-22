import {
  parseProxyProductIdentityV21,
  type ProxyProductIdentityV21,
  type ProxySemanticProductLine,
} from './proxyProductIdentityV2';
import { normalizeProxyProductIdentity } from './proxyProductIdentity';

export const CLOSING_DATE_CATALOG_NATIVE_LIMIT = 5;
export const CLOSING_DATE_FAMILY_FALLBACK_NATIVE_LIMIT = 12;
export const CLOSING_DATE_RELIABLE_NATIVE_TOP_N = 3;

export type ClosingDateCandidateQueryKind =
  | 'PRODUCT_LINE_SUBJECT'
  | 'SERIES_SUBJECT'
  | 'UNRESOLVED_CONTEXT_SUBJECT'
  | 'SUBJECT_VERSION_FORM'
  | 'SUBJECT'
  | 'COMPOUND_MEMBER'
  | 'FAMILY_STEM_FALLBACK';

export interface ClosingDateCandidateRetrievalQuery {
  text: string;
  priority: 1 | 2 | 3 | 4 | 5 | 6;
  kind: ClosingDateCandidateQueryKind;
  limit: number;
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
  '限定',
  '約',
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

const cjkCharacters = (value: string): string[] => (
  Array.from(normalizeQuery(value)).filter(character => (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)
  ))
);

const commonCjkPrefix = (values: readonly string[]): string => {
  const characterSets = values.map(cjkCharacters);
  if (characterSets.length < 2 || characterSets.some(characters => characters.length < 2)) return '';
  const shortestLength = Math.min(...characterSets.map(characters => characters.length));
  let index = 0;
  while (
    index < shortestLength
    && characterSets.every(characters => characters[index] === characterSets[0][index])
  ) index += 1;
  return characterSets[0].slice(0, index).join('');
};

const sharedSingleCjkSuffix = (values: readonly string[]): string => {
  if (values.length < 2) return '';
  const normalized = values.map(value => normalizeQuery(value));
  const suffix = Array.from(normalized[0]).at(-1) ?? '';
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(suffix)) return '';
  return normalized.every(value => value.endsWith(suffix)) ? suffix : '';
};

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

const nativeSubjectFallbackQuery = (
  identity: ProxyProductIdentityV21,
  subject: string,
): string => {
  if (identity.compoundSubjects.length > 0) return subject;
  const tokens = normalizeQuery(subject).split(/\s+/u).filter(Boolean);
  if (tokens.length <= 1) return subject;
  const finalToken = tokens.at(-1) ?? '';
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/u.test(finalToken)
    ? finalToken
    : subject;
};

const isBusinessSeriesToken = (token: string): boolean => (
  /^(?:第?[一二三四1234]季|(?:19|20)\d{2}|\d{2}年第?[一二三四1234]季)$/u.test(token.trim())
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
 * Retrieval-only context for a v2.1 unresolved subject. This does not promote
 * the context token to Series or Subject and does not affect matching. It
 * merely keeps the nearest distinctive Catalog term beside the conservative
 * v1 subject fallback (for example `妮姬 小紅帽`).
 */
const unresolvedContextSubjectQuery = (
  identity: ProxyProductIdentityV21,
  subject: string,
): string => {
  if (identity.subjectResolution !== 'UNRESOLVED_SUBJECT') return '';
  const normalizedSubject = normalizeQuery(subject);
  const subjectKey = compactQuery(normalizedSubject);
  const tokens = identity.unresolvedSubjectTokens.map(normalizeQuery).filter(Boolean);
  const subjectIndex = tokens.findLastIndex(token => compactQuery(token) === subjectKey);
  if (subjectIndex < 1) return '';
  const context = tokens[subjectIndex - 1];
  if (
    !context
    || isLowInformationCatalogQuery(context)
    || isBusinessSeriesToken(context)
    || cjkCharacters(context).length < 2
  ) return '';
  return normalizeQuery(`${context} ${normalizedSubject}`);
};

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
  const subject = subjectQuery(identity)
    || normalizeQuery(fallbackIdentity.identityTokens[0] ?? '');
  if (!subject || isLowInformationCatalogQuery(subject)) return [];

  const productLine = identity.productLines
    .map(line => PRODUCT_LINE_QUERY_LABELS[line])
    .find(Boolean) ?? '';
  const series = seriesQuery(identity);
  const unresolvedContext = unresolvedContextSubjectQuery(identity, subject);
  const versionForm = versionFormQuery(identity);
  const subjectFallback = nativeSubjectFallbackQuery(identity, subject);
  const planned: ClosingDateCandidateRetrievalQuery[] = [
    {
      text: productLine ? `${productLine} ${subject}` : '',
      priority: 1,
      kind: 'PRODUCT_LINE_SUBJECT',
      limit: CLOSING_DATE_CATALOG_NATIVE_LIMIT,
    },
    {
      text: series ? `${series} ${subject}` : '',
      priority: 2,
      kind: 'SERIES_SUBJECT',
      limit: CLOSING_DATE_CATALOG_NATIVE_LIMIT,
    },
    {
      text: unresolvedContext,
      priority: 2,
      kind: 'UNRESOLVED_CONTEXT_SUBJECT',
      limit: CLOSING_DATE_CATALOG_NATIVE_LIMIT,
    },
    {
      text: versionForm ? `${subject} ${versionForm}` : '',
      priority: 3,
      kind: 'SUBJECT_VERSION_FORM',
      limit: CLOSING_DATE_CATALOG_NATIVE_LIMIT,
    },
    {
      text: subjectFallback,
      priority: 4,
      kind: 'SUBJECT',
      limit: CLOSING_DATE_CATALOG_NATIVE_LIMIT,
    },
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

/**
 * Compound member search is a retrieval-only fallback. A shared one-character
 * CJK suffix is removed only when every member also shares a distinctive CJK
 * family prefix. This converts catalog-family labels such as
 * `牙吠孔雀王 + 牙吠眼鏡蛇王` into the native-search terms
 * `牙吠孔雀` and `牙吠眼鏡蛇` without any character-specific registry.
 */
export function buildClosingDateCompoundMemberQueries(
  title: string,
): readonly ClosingDateCandidateRetrievalQuery[] {
  const identity = parseProxyProductIdentityV21(title);
  const members = identity.compoundSubjects[0]?.members.map(normalizeQuery).filter(Boolean) ?? [];
  const familyPrefix = commonCjkPrefix(members);
  const sharedSuffix = familyPrefix.length >= 2 ? sharedSingleCjkSuffix(members) : '';
  const seen = new Set<string>();
  return members.flatMap(member => {
    const text = normalizeQuery(
      sharedSuffix && cjkCharacters(member.slice(0, -sharedSuffix.length)).length >= 2
        ? member.slice(0, -sharedSuffix.length)
        : member,
    );
    const key = compactQuery(text);
    if (!text || seen.has(key) || isLowInformationCatalogQuery(text)) return [];
    seen.add(key);
    return [{
      text,
      priority: 5 as const,
      kind: 'COMPOUND_MEMBER' as const,
      limit: CLOSING_DATE_CATALOG_NATIVE_LIMIT,
    }];
  });
}

/**
 * The family stem is allowed only for two or more explicit compound members
 * with a shared, distinctive CJK prefix. It never reads product type, product
 * line, manufacturer, qualifier, or business metadata.
 */
export function buildClosingDateFamilyStemFallbackQuery(
  title: string,
): ClosingDateCandidateRetrievalQuery | null {
  const identity = parseProxyProductIdentityV21(title);
  const members = identity.compoundSubjects[0]?.members.map(normalizeQuery).filter(Boolean) ?? [];
  const stem = commonCjkPrefix(members);
  if (
    members.length < 2
    || Array.from(stem).length < 2
    || members.some(member => compactQuery(member) === compactQuery(stem))
    || isLowInformationCatalogQuery(stem)
  ) return null;
  return {
    text: stem,
    priority: 6,
    kind: 'FAMILY_STEM_FALLBACK',
    limit: CLOSING_DATE_FAMILY_FALLBACK_NATIVE_LIMIT,
  };
}
