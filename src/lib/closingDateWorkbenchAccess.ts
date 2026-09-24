import type { ProviderMode } from '../providers/providerMode';
import { getProviderMode } from '../providers/providerMode';
import { getBuildSandboxMode } from './testSandboxEnvironment';

export const CLOSING_DATE_WORKBENCH_UI_FEATURE_FLAG = 'VITE_ENABLE_CLOSING_DATE_WORKBENCH_UI';

export type ClosingDateWorkbenchMode = 'next' | 'cloud';

const defaultFeatureFlagValue = import.meta.env.VITE_ENABLE_CLOSING_DATE_WORKBENCH_UI;

export function parseClosingDateWorkbenchUiFeatureFlag(
  rawValue: string | boolean | null | undefined,
): boolean {
  return rawValue === true || rawValue === 'true';
}

export function getClosingDateWorkbenchMode(
  providerMode: ProviderMode = getProviderMode(),
  buildMode: ReturnType<typeof getBuildSandboxMode> = getBuildSandboxMode(),
  featureEnabled = parseClosingDateWorkbenchUiFeatureFlag(defaultFeatureFlagValue),
): ClosingDateWorkbenchMode | null {
  if (buildMode === 'next' && providerMode === 'next' && featureEnabled) return 'next';
  if (buildMode === null && (providerMode === 'cloud' || providerMode === 'fallback')) return 'cloud';
  if (buildMode === 'experimental' && (providerMode === 'experimental' || providerMode === 'cloud')) return 'cloud';
  return null;
}

export function canUseClosingDateWorkbenchUi(
  providerMode: ProviderMode = getProviderMode(),
  buildMode: ReturnType<typeof getBuildSandboxMode> = getBuildSandboxMode(),
  featureEnabled = parseClosingDateWorkbenchUiFeatureFlag(defaultFeatureFlagValue),
): boolean {
  return getClosingDateWorkbenchMode(providerMode, buildMode, featureEnabled) !== null;
}

export function assertClosingDateWorkbenchUiAccess(): void {
  if (!canUseClosingDateWorkbenchUi()) {
    throw new Error('Closing Date Resolution Workbench is unavailable in this build/provider combination.');
  }
}

export function assertNextClosingDateWorkbenchUiAccess(): void {
  if (getClosingDateWorkbenchMode() !== 'next') {
    throw new Error('The local atomic Closing Date apply path is available only in the enabled Next Sandbox build.');
  }
}
