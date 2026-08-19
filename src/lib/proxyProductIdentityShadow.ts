import type { ProxyProductIdentity } from './proxyProductIdentity';
import {
  parseProxyProductIdentityV2,
  type ProxyProductIdentityV2,
} from './proxyProductIdentityV2';
import type { ProviderMode } from '../providers/providerMode';

export type ProxyIdentityShadowDisagreement =
  | 'IDENTITY_DISAGREEMENT'
  | 'PRODUCT_TYPE_DISAGREEMENT'
  | 'PRODUCT_LINE_DISAGREEMENT'
  | 'VERSION_DISAGREEMENT'
  | 'COMPOUND_SUBJECT_DETECTED'
  | 'DIMENSION_AS_V1_IDENTITY'
  | 'VERSION_AS_V1_IDENTITY'
  | 'QUALIFIER_AS_V1_IDENTITY'
  | 'SCALE_TYPE_DISAGREEMENT';

export type ProxyIdentityShadowComparison =
  | 'STRUCTURE_OK'
  | 'IDENTITY_EQUIVALENCE_UNPROVEN';

export interface ProxyIdentityShadowDiagnostic {
  v2: ProxyProductIdentityV2;
  disagreements: ProxyIdentityShadowDisagreement[];
}

const compact = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[^\p{Letter}\p{Number}]/gu, '');

const compactSet = (values: string[]): string[] => Array.from(new Set(values.map(compact).filter(Boolean))).sort();

const setsEqual = (left: string[], right: string[]): boolean => {
  const normalizedLeft = compactSet(left);
  const normalizedRight = compactSet(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
};

const intersects = (left: string[], right: string[]): boolean => {
  const rightSet = new Set(compactSet(right));
  return compactSet(left).some(value => rightSet.has(value));
};

export const canUseProxyIdentityShadow = (mode: ProviderMode): boolean => mode === 'next';

export function createProxyIdentityShadowDiagnostic(
  title: string,
  v1: ProxyProductIdentity,
  manufacturerName = '',
): ProxyIdentityShadowDiagnostic {
  const v2 = parseProxyProductIdentityV2(title, manufacturerName);
  const disagreements: ProxyIdentityShadowDisagreement[] = [];
  const v1Types = v1.productType ? [v1.productType] : [];
  const v1Lines = v1.productLine ? [v1.productLine] : [];

  if (!setsEqual(v1.identityTokens, v2.subjects)) disagreements.push('IDENTITY_DISAGREEMENT');
  if (!setsEqual(v1Types, v2.productTypes)) disagreements.push('PRODUCT_TYPE_DISAGREEMENT');
  if (!setsEqual(v1Lines, v2.productLines)) disagreements.push('PRODUCT_LINE_DISAGREEMENT');
  if (!setsEqual(v1.versionTokens, v2.versions)) disagreements.push('VERSION_DISAGREEMENT');
  if (v2.compoundSubjects.length > 0) disagreements.push('COMPOUND_SUBJECT_DETECTED');
  if (intersects(v1.identityTokens, v2.dimensions)) disagreements.push('DIMENSION_AS_V1_IDENTITY');
  if (intersects(v1.identityTokens, v2.versions)) disagreements.push('VERSION_AS_V1_IDENTITY');
  if (intersects(v1.identityTokens, v2.qualifiers)) disagreements.push('QUALIFIER_AS_V1_IDENTITY');
  if (
    v1.productType === 'SCALE_FIGURE'
    && v2.scales.length > 0
    && v2.productTypes.includes('MODEL_KIT')
    && !v2.productTypes.includes('SCALE_FIGURE')
  ) disagreements.push('SCALE_TYPE_DISAGREEMENT');

  return { v2, disagreements: Array.from(new Set(disagreements)) };
}

export function compareProxyIdentityShadows(
  source: ProxyIdentityShadowDiagnostic,
  candidate: ProxyIdentityShadowDiagnostic,
): ProxyIdentityShadowComparison[] {
  const sourceSubjects = source.v2.subjects;
  const candidateSubjects = candidate.v2.subjects;
  const hasStructuredSubjects = sourceSubjects.length > 0 && candidateSubjects.length > 0;
  if (hasStructuredSubjects && setsEqual(sourceSubjects, candidateSubjects)) return ['STRUCTURE_OK'];
  return hasStructuredSubjects
    ? ['STRUCTURE_OK', 'IDENTITY_EQUIVALENCE_UNPROVEN']
    : ['IDENTITY_EQUIVALENCE_UNPROVEN'];
}
