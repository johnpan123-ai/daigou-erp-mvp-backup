import type { ProviderMode } from '../providers/providerMode';
import { getProviderMode } from '../providers/providerMode';
import { getBuildSandboxMode } from './testSandboxEnvironment';

export const CLOSING_DATE_WORKBENCH_UI_FEATURE_FLAG = 'VITE_ENABLE_CLOSING_DATE_WORKBENCH_UI';

const defaultFeatureFlagValue = import.meta.env.VITE_ENABLE_CLOSING_DATE_WORKBENCH_UI;

export function parseClosingDateWorkbenchUiFeatureFlag(
  rawValue: string | boolean | null | undefined,
): boolean {
  return rawValue === true || rawValue === 'true';
}

/**
 * The build role and the active provider role must both be Next. Checking only
 * the mutable provider mode would allow the tool to appear in another build.
 */
export function canUseClosingDateWorkbenchUi(
  providerMode: ProviderMode = getProviderMode(),
  buildMode: ReturnType<typeof getBuildSandboxMode> = getBuildSandboxMode(),
  featureEnabled = parseClosingDateWorkbenchUiFeatureFlag(defaultFeatureFlagValue),
): boolean {
  return buildMode === 'next' && providerMode === 'next' && featureEnabled;
}

export function assertClosingDateWorkbenchUiAccess(): void {
  if (!canUseClosingDateWorkbenchUi()) {
    throw new Error('Closing Date Resolution Workbench is available only in the enabled Next Sandbox build.');
  }
}
