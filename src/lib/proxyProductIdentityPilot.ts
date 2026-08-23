import type { ProviderMode } from '../providers/providerMode';
import {
  PROXY_DEFAULT_SUPPLIER_PRIORITY,
  PROXY_IDENTITY_AMBIGUITY_DELTA,
  PROXY_IDENTITY_MIN_CONFIDENCE,
  isSafeProxyCatalogSelection,
  type ProxyCatalogCandidate,
  type ProxyCatalogSelection,
} from './proxyProductIdentity';
import {
  parseProxyProductIdentityV21,
  parseProxyProductIdentityV21Metadata,
  type ProxyProductIdentityV21,
  type ProxyProductIdentityV21Metadata,
} from './proxyProductIdentityV2';

export type ProxyIdentityPilotEvidence =
  | 'SUBJECT_EXACT'
  | 'COMPOUND_SUBJECT_EXACT'
  | 'PRODUCT_TYPE_EXACT'
  | 'PRODUCT_LINE_EXACT'
  | 'VERSION_EXACT'
  | 'VERSION_DEFAULT_COMPATIBLE'
  | 'FORM_EXACT'
  | 'SCALE_EXACT'
  | 'DIMENSION_EXACT'
  | 'MODEL_CODE_EXACT'
  | 'SERIES_OVERLAP';

export type ProxyIdentityPilotRejectReason =
  | 'subject_missing'
  | 'subject_conflict'
  | 'compound_subject_conflict'
  | 'product_type_conflict'
  | 'product_line_conflict'
  | 'version_missing'
  | 'version_conflict'
  | 'form_conflict'
  | 'scale_conflict'
  | 'dimension_conflict'
  | 'model_code_conflict'
  | 'insufficient_evidence'
  | 'scored';

export interface ProxyIdentityPilotCandidateScore<T extends ProxyCatalogCandidate = ProxyCatalogCandidate> {
  candidate: T;
  confidence: number;
  rejected: boolean;
  reason: ProxyIdentityPilotRejectReason;
  evidence: ProxyIdentityPilotEvidence[];
  sourceIdentity: ProxyProductIdentityV21Metadata;
  candidateIdentity: ProxyProductIdentityV21Metadata;
}

export type ProxyIdentityPilotSelection<T extends ProxyCatalogCandidate = ProxyCatalogCandidate> =
  | {
    status: 'match';
    candidate: T;
    confidence: number;
    runnerUpConfidence: number | null;
    evidence: ProxyIdentityPilotEvidence[];
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

export type ProxyCatalogDecisionSource = 'V1' | 'V2_PILOT';

export type ProxyIdentitySafetyVetoReason = 'version_conflict';

export interface ProxyIdentitySafetyVeto<T extends ProxyCatalogCandidate = ProxyCatalogCandidate> {
  candidate: T;
  reason: ProxyIdentitySafetyVetoReason;
  sourceIdentity: ProxyProductIdentityV21Metadata;
  candidateIdentity: ProxyProductIdentityV21Metadata;
  sourceVersions: string[];
  candidateVersions: string[];
}

export interface ProxyCatalogDecisionResolution<T extends ProxyCatalogCandidate = ProxyCatalogCandidate> {
  match: {
    decisionSource: ProxyCatalogDecisionSource;
    candidate: T;
    confidence: number;
    pilotEvidence?: ProxyIdentityPilotEvidence[];
  } | null;
  pilotSelection: ProxyIdentityPilotSelection<T> | null;
  safetyVeto: ProxyIdentitySafetyVeto<T> | null;
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

const hasOverlap = (left: string[], right: string[]): boolean => {
  const rightSet = new Set(compactSet(right));
  return compactSet(left).some(value => rightSet.has(value));
};

const DEFAULT_VERSION_TOKENS = new Set([
  '一般版',
  '普通版',
  '通常版',
  'standard',
  'standardver',
]);

const RELEASE_STATUS_VERSION_TOKENS = new Set(['再版', '再販']);

const toPilotMetadataIdentity = (
  identity: ProxyProductIdentityV21,
): ProxyProductIdentityV21Metadata => ({
  ...identity,
  metadataVersion: 'generalized-retrieval-phase1',
  subjectCandidates: identity.subjects.map((value, index) => ({
    value,
    evidence: [],
    rank: index + 1,
    queryEligible: true,
  })),
  editions: identity.versions.filter(version => (
    !RELEASE_STATUS_VERSION_TOKENS.has(compact(version))
  )),
  releaseStatuses: identity.versions.filter(version => (
    RELEASE_STATUS_VERSION_TOKENS.has(compact(version))
  )),
  productTypeEvidence: identity.productTypes.map(productType => ({
    productType,
    source: 'EXPLICIT_MARKER',
  })),
});

const parsePilotIdentity = (
  title: string,
  manufacturerName = '',
): ProxyProductIdentityV21Metadata => toPilotMetadataIdentity(
  parseProxyProductIdentityV21(title, manufacturerName),
);

const identityBearingVersions = (versions: string[]): string[] => versions.filter((version) => {
  const normalized = compact(version);
  return normalized
    && !DEFAULT_VERSION_TOKENS.has(normalized)
    && !RELEASE_STATUS_VERSION_TOKENS.has(normalized);
});

const matchingSubjects = (identity: ProxyProductIdentityV21Metadata): string[] => (
  identity.subjects
);

const subjectFamilyTokens = (identity: ProxyProductIdentityV21Metadata): string[] => [
  ...identity.subjects,
  ...identity.series,
  ...compoundMembers(identity),
];

/**
 * Next-only safety veto for a v1 MATCH.
 *
 * Parser v2.1 is not allowed to promote a match here. It may only stop a v1
 * result when both titles have reliable same-family evidence and exactly one
 * side carries an explicit identity-bearing version. This protects distinct
 * editions such as PLAMATEA standard vs Black Barrel Edition while leaving
 * unresolved aliases and release-status labels for manual review.
 */
export function evaluateProxyCatalogV2SafetyVeto<T extends ProxyCatalogCandidate>(
  sourceTitle: string,
  candidate: T,
): ProxyIdentitySafetyVeto<T> | null {
  const sourceIdentity = parsePilotIdentity(sourceTitle);
  const candidateIdentity = parsePilotIdentity(
    candidate.name || '',
    candidate.manufacturer || candidate.brand?.name || '',
  );

  if (
    sourceIdentity.productLines.length === 0
    || candidateIdentity.productLines.length === 0
    || !setsEqual(sourceIdentity.productLines, candidateIdentity.productLines)
  ) return null;

  if (
    sourceIdentity.productTypes.length > 0
    && candidateIdentity.productTypes.length > 0
    && !setsEqual(sourceIdentity.productTypes, candidateIdentity.productTypes)
  ) return null;

  if (
    sourceIdentity.forms.length > 0
    && candidateIdentity.forms.length > 0
    && !setsEqual(sourceIdentity.forms, candidateIdentity.forms)
  ) return null;

  const hasSubjectFamilyEvidence = hasOverlap(
    subjectFamilyTokens(sourceIdentity),
    subjectFamilyTokens(candidateIdentity),
  );
  if (!hasSubjectFamilyEvidence) return null;

  const sourceVersions = identityBearingVersions(sourceIdentity.editions);
  const candidateVersions = identityBearingVersions(candidateIdentity.editions);
  const hasOneSidedExplicitVersion = (sourceVersions.length === 0) !== (candidateVersions.length === 0);
  if (!hasOneSidedExplicitVersion) return null;

  return {
    candidate,
    reason: 'version_conflict',
    sourceIdentity,
    candidateIdentity,
    sourceVersions,
    candidateVersions,
  };
}

const compoundMembers = (identity: ProxyProductIdentityV21Metadata): string[] => identity.compoundSubjects
  .flatMap(compound => compound.members);

const rejectedScore = <T extends ProxyCatalogCandidate>(
  candidate: T,
  reason: Exclude<ProxyIdentityPilotRejectReason, 'scored'>,
  sourceIdentity: ProxyProductIdentityV21Metadata,
  candidateIdentity: ProxyProductIdentityV21Metadata,
  evidence: ProxyIdentityPilotEvidence[] = [],
): ProxyIdentityPilotCandidateScore<T> => ({
  candidate,
  confidence: 0,
  rejected: true,
  reason,
  evidence,
  sourceIdentity,
  candidateIdentity,
});

export const canUseProxyIdentityPilot = (mode: ProviderMode): boolean => mode === 'next';

const scoreProxyCatalogCandidateV2PilotWithParser = <T extends ProxyCatalogCandidate>(
  sourceTitle: string,
  candidate: T,
  generalizedMetadata: boolean,
): ProxyIdentityPilotCandidateScore<T> => {
  const parseIdentity = generalizedMetadata
    ? parseProxyProductIdentityV21Metadata
    : parsePilotIdentity;
  const sourceIdentity = parseIdentity(sourceTitle);
  const candidateIdentity = parseIdentity(
    candidate.name || '',
    candidate.manufacturer || candidate.brand?.name || '',
  );
  const evidence: ProxyIdentityPilotEvidence[] = [];

  if (sourceIdentity.productTypes.length > 0 && candidateIdentity.productTypes.length > 0) {
    if (!setsEqual(sourceIdentity.productTypes, candidateIdentity.productTypes)) {
      return rejectedScore(candidate, 'product_type_conflict', sourceIdentity, candidateIdentity);
    }
    evidence.push('PRODUCT_TYPE_EXACT');
  }

  if (sourceIdentity.productLines.length > 0 && candidateIdentity.productLines.length > 0) {
    if (!setsEqual(sourceIdentity.productLines, candidateIdentity.productLines)) {
      return rejectedScore(candidate, 'product_line_conflict', sourceIdentity, candidateIdentity, evidence);
    }
    evidence.push('PRODUCT_LINE_EXACT');
  }

  const sourceSubjects = matchingSubjects(sourceIdentity);
  const candidateSubjects = matchingSubjects(candidateIdentity);
  if (sourceSubjects.length === 0 || candidateSubjects.length === 0) {
    return rejectedScore(candidate, 'subject_missing', sourceIdentity, candidateIdentity, evidence);
  }

  const sourceCompound = compoundMembers(sourceIdentity);
  const candidateCompound = compoundMembers(candidateIdentity);
  if (sourceCompound.length > 0 || candidateCompound.length > 0) {
    if (sourceCompound.length === 0 || candidateCompound.length === 0 || !setsEqual(sourceCompound, candidateCompound)) {
      return rejectedScore(candidate, 'compound_subject_conflict', sourceIdentity, candidateIdentity);
    }
    evidence.push('SUBJECT_EXACT', 'COMPOUND_SUBJECT_EXACT');
  } else if (!setsEqual(sourceSubjects, candidateSubjects)) {
    return rejectedScore(candidate, 'subject_conflict', sourceIdentity, candidateIdentity);
  } else {
    evidence.push('SUBJECT_EXACT');
  }

  if (sourceIdentity.editions.length > 0 || candidateIdentity.editions.length > 0) {
    if (sourceIdentity.editions.length === 0 || candidateIdentity.editions.length === 0) {
      return rejectedScore(candidate, 'version_missing', sourceIdentity, candidateIdentity, evidence);
    }
    if (!setsEqual(sourceIdentity.editions, candidateIdentity.editions)) {
      return rejectedScore(candidate, 'version_conflict', sourceIdentity, candidateIdentity, evidence);
    }
    evidence.push('VERSION_EXACT');
  }

  if (sourceIdentity.releaseStatuses.length > 0 || candidateIdentity.releaseStatuses.length > 0) {
    if (sourceIdentity.releaseStatuses.length === 0 || candidateIdentity.releaseStatuses.length === 0) {
      return rejectedScore(candidate, 'version_missing', sourceIdentity, candidateIdentity, evidence);
    }
    if (!setsEqual(sourceIdentity.releaseStatuses, candidateIdentity.releaseStatuses)) {
      return rejectedScore(candidate, 'version_conflict', sourceIdentity, candidateIdentity, evidence);
    }
    if (!evidence.includes('VERSION_EXACT')) evidence.push('VERSION_EXACT');
  }

  if (sourceIdentity.forms.length > 0 || candidateIdentity.forms.length > 0) {
    if (!setsEqual(sourceIdentity.forms, candidateIdentity.forms)) {
      return rejectedScore(candidate, 'form_conflict', sourceIdentity, candidateIdentity, evidence);
    }
    evidence.push('FORM_EXACT');
  }

  if (sourceIdentity.scales.length > 0 && candidateIdentity.scales.length > 0) {
    if (!setsEqual(sourceIdentity.scales, candidateIdentity.scales)) {
      return rejectedScore(candidate, 'scale_conflict', sourceIdentity, candidateIdentity, evidence);
    }
    evidence.push('SCALE_EXACT');
  }

  if (sourceIdentity.dimensions.length > 0 && candidateIdentity.dimensions.length > 0) {
    if (!setsEqual(sourceIdentity.dimensions, candidateIdentity.dimensions)) {
      return rejectedScore(candidate, 'dimension_conflict', sourceIdentity, candidateIdentity, evidence);
    }
    evidence.push('DIMENSION_EXACT');
  }

  if (sourceIdentity.modelCodes.length > 0 && candidateIdentity.modelCodes.length > 0) {
    if (!hasOverlap(sourceIdentity.modelCodes, candidateIdentity.modelCodes)) {
      return rejectedScore(candidate, 'model_code_conflict', sourceIdentity, candidateIdentity, evidence);
    }
    evidence.push('MODEL_CODE_EXACT');
  }

  if (hasOverlap(sourceIdentity.series, candidateIdentity.series)) evidence.push('SERIES_OVERLAP');

  const corroboratingEvidence = evidence.filter(item => (
    item !== 'SUBJECT_EXACT'
    && item !== 'DIMENSION_EXACT'
  ));
  let confidence = 0.7;
  if (evidence.includes('COMPOUND_SUBJECT_EXACT')) confidence += 0.1;
  if (evidence.includes('PRODUCT_TYPE_EXACT')) confidence += 0.1;
  if (evidence.includes('PRODUCT_LINE_EXACT')) confidence += 0.1;
  if (evidence.includes('VERSION_EXACT')) confidence += 0.1;
  if (evidence.includes('VERSION_DEFAULT_COMPATIBLE')) confidence += 0.05;
  if (evidence.includes('FORM_EXACT')) confidence += 0.05;
  if (evidence.includes('SCALE_EXACT')) confidence += 0.05;
  if (evidence.includes('MODEL_CODE_EXACT')) confidence += 0.1;
  if (evidence.includes('SERIES_OVERLAP')) confidence += 0.05;
  confidence = Math.min(1, Number(confidence.toFixed(6)));

  if (corroboratingEvidence.length < 2 || confidence < PROXY_IDENTITY_MIN_CONFIDENCE) {
    return {
      candidate,
      confidence,
      rejected: true,
      reason: 'insufficient_evidence',
      evidence,
      sourceIdentity,
      candidateIdentity,
    };
  }
  return {
    candidate,
    confidence,
    rejected: false,
    reason: 'scored',
    evidence,
    sourceIdentity,
    candidateIdentity,
  };
};

export function scoreProxyCatalogCandidateV2Pilot<T extends ProxyCatalogCandidate>(
  sourceTitle: string,
  candidate: T,
): ProxyIdentityPilotCandidateScore<T> {
  return scoreProxyCatalogCandidateV2PilotWithParser(sourceTitle, candidate, false);
}

/** Workbench-only generalized metadata score used for retrieval safety. */
export function scoreProxyCatalogCandidateV21MetadataSafety<T extends ProxyCatalogCandidate>(
  sourceTitle: string,
  candidate: T,
): ProxyIdentityPilotCandidateScore<T> {
  return scoreProxyCatalogCandidateV2PilotWithParser(sourceTitle, candidate, true);
}

const candidateKey = (candidate: ProxyCatalogCandidate): string => {
  const stableId = candidate.id ?? candidate.url ?? candidate.slug;
  if (stableId !== null && stableId !== undefined && String(stableId).trim()) return String(stableId).trim();
  return `${candidate.name || ''}::${candidate.catalog?.deadlineAt || ''}`;
};

const effectiveIdentityKey = (
  source: ProxyProductIdentityV21Metadata,
  candidate: ProxyProductIdentityV21Metadata,
): string => JSON.stringify({
  subjects: compactSet(matchingSubjects(candidate)),
  productTypes: compactSet(candidate.productTypes.length > 0 ? candidate.productTypes : source.productTypes),
  productLines: compactSet(candidate.productLines.length > 0 ? candidate.productLines : source.productLines),
  versions: compactSet(candidate.versions.length > 0 ? candidate.versions : source.versions),
  forms: compactSet(candidate.forms.length > 0 ? candidate.forms : source.forms),
  scales: compactSet(candidate.scales.length > 0 ? candidate.scales : source.scales),
  dimensions: compactSet(candidate.dimensions.length > 0 ? candidate.dimensions : source.dimensions),
  modelCodes: compactSet(candidate.modelCodes.length > 0 ? candidate.modelCodes : source.modelCodes),
});

const supplierPriority = (candidate: ProxyCatalogCandidate): number => {
  const supplierCode = candidate.catalog?.supplier?.code?.trim().toLocaleLowerCase() ?? '';
  const index = PROXY_DEFAULT_SUPPLIER_PRIORITY.indexOf(
    supplierCode as (typeof PROXY_DEFAULT_SUPPLIER_PRIORITY)[number],
  );
  return index === -1 ? PROXY_DEFAULT_SUPPLIER_PRIORITY.length : index;
};

const chooseSupplierListing = <T extends ProxyCatalogCandidate>(
  matches: ProxyIdentityPilotCandidateScore<T>[],
): ProxyIdentityPilotCandidateScore<T> => [...matches].sort((left, right) => {
  const priorityDifference = supplierPriority(left.candidate) - supplierPriority(right.candidate);
  if (priorityDifference !== 0) return priorityDifference;
  return right.confidence - left.confidence;
})[0];

export function selectProxyCatalogCandidateV2Pilot<T extends ProxyCatalogCandidate>(
  sourceTitle: string,
  candidates: T[],
): ProxyIdentityPilotSelection<T> {
  const sourceIdentity = parsePilotIdentity(sourceTitle);
  const deduped = Array.from(new Map(candidates.map(candidate => [candidateKey(candidate), candidate])).values());
  const scored = deduped
    .map(candidate => scoreProxyCatalogCandidateV2Pilot(sourceTitle, candidate))
    .filter(result => !result.rejected);
  const groupedByIdentity = new Map<string, ProxyIdentityPilotCandidateScore<T>[]>();
  for (const result of scored) {
    const key = effectiveIdentityKey(sourceIdentity, result.candidateIdentity);
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
    return {
      status: 'no_match',
      candidate: null,
      confidence: top?.identityConfidence ?? 0,
      runnerUpConfidence: runnerUp?.identityConfidence ?? null,
      bestCandidate: top?.selectedListing.candidate,
      message: 'Parser v2.1 Pilot 證據不足，需要人工確認',
    };
  }
  if (
    runnerUp
    && runnerUp.identityConfidence >= PROXY_IDENTITY_MIN_CONFIDENCE
    && top.identityConfidence - runnerUp.identityConfidence < PROXY_IDENTITY_AMBIGUITY_DELTA
  ) {
    return {
      status: 'ambiguous',
      candidate: null,
      confidence: top.identityConfidence,
      runnerUpConfidence: runnerUp.identityConfidence,
      candidates: [top.selectedListing.candidate, runnerUp.selectedListing.candidate],
      message: 'Parser v2.1 Pilot 找到多筆相似商品，需要人工確認',
    };
  }
  return {
    status: 'match',
    candidate: top.selectedListing.candidate,
    confidence: top.selectedListing.confidence,
    runnerUpConfidence: runnerUp?.identityConfidence ?? null,
    evidence: top.selectedListing.evidence,
  };
}

export function isSafeProxyCatalogPilotSelection<T extends ProxyCatalogCandidate>(
  sourceTitle: string,
  selection: ProxyIdentityPilotSelection<T>,
): selection is Extract<ProxyIdentityPilotSelection<T>, { status: 'match' }> {
  if (selection.status !== 'match') return false;
  const verification = scoreProxyCatalogCandidateV2Pilot(sourceTitle, selection.candidate);
  return !verification.rejected
    && verification.confidence >= PROXY_IDENTITY_MIN_CONFIDENCE
    && selection.confidence >= PROXY_IDENTITY_MIN_CONFIDENCE;
}

export function resolveProxyCatalogDecision<T extends ProxyCatalogCandidate>(
  mode: ProviderMode,
  sourceTitle: string,
  candidates: T[],
  v1Selection: ProxyCatalogSelection<T>,
): ProxyCatalogDecisionResolution<T> {
  if (isSafeProxyCatalogSelection(sourceTitle, v1Selection)) {
    const safetyVeto = canUseProxyIdentityPilot(mode)
      ? evaluateProxyCatalogV2SafetyVeto(sourceTitle, v1Selection.candidate)
      : null;
    if (!safetyVeto) {
      return {
        match: {
          decisionSource: 'V1',
          candidate: v1Selection.candidate,
          confidence: v1Selection.confidence,
        },
        pilotSelection: null,
        safetyVeto: null,
      };
    }

    const pilotSelection = selectProxyCatalogCandidateV2Pilot(sourceTitle, candidates);
    if (!isSafeProxyCatalogPilotSelection(sourceTitle, pilotSelection)) {
      return { match: null, pilotSelection, safetyVeto };
    }
    return {
      match: {
        decisionSource: 'V2_PILOT',
        candidate: pilotSelection.candidate,
        confidence: pilotSelection.confidence,
        pilotEvidence: pilotSelection.evidence,
      },
      pilotSelection,
      safetyVeto,
    };
  }
  if (!canUseProxyIdentityPilot(mode)) return { match: null, pilotSelection: null, safetyVeto: null };

  const pilotSelection = selectProxyCatalogCandidateV2Pilot(sourceTitle, candidates);
  if (!isSafeProxyCatalogPilotSelection(sourceTitle, pilotSelection)) {
    return { match: null, pilotSelection, safetyVeto: null };
  }
  return {
    match: {
      decisionSource: 'V2_PILOT',
      candidate: pilotSelection.candidate,
      confidence: pilotSelection.confidence,
      pilotEvidence: pilotSelection.evidence,
    },
    pilotSelection,
    safetyVeto: null,
  };
}
