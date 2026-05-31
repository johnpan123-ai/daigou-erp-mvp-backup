import { useAuth } from './AuthProvider';
import { getProviderMode } from '../providers/providerMode';

export interface UserRole {
  role: 'owner' | 'staff' | 'viewer' | 'helper' | null;
  displayName: string | null;
  isProfileLoading: boolean;
  canViewPage: (path: string) => boolean;
  canCreate: () => boolean;
  canEdit: () => boolean;
  canDeleteGroup: () => boolean;
  canImportXLS: () => boolean;
  canSwitchMode: () => boolean;
  canManageUsers: () => boolean;
}

export function useRole(): UserRole {
  const { user, profile, loading, profileLoading } = useAuth();
  const mode = getProviderMode();

  // Local Mode always returns Owner with full permissions
  if (mode === 'local') {
    return {
      role: 'owner',
      displayName: '本地管理員',
      isProfileLoading: false,
      canViewPage: () => true,
      canCreate: () => true,
      canEdit: () => true,
      canDeleteGroup: () => true,
      canImportXLS: () => true,
      canSwitchMode: () => true,
      canManageUsers: () => true,
    };
  }

  // Cloud or Fallback Mode
  const role = profile?.role ?? null;
  const displayName = profile?.display_name ?? user?.email ?? null;

  return {
    role,
    displayName,
    isProfileLoading: loading || profileLoading,
    // Phase 2-E restrictions disabled as per user request: allow all actions
    canViewPage: () => true,
    canCreate: () => true,
    canEdit: () => true,
    canDeleteGroup: () => true,
    canImportXLS: () => true,
    canSwitchMode: () => true,
    canManageUsers: () => true,
  };
}
