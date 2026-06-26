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

  const isEditor = role === 'owner' || role === 'staff' || role === 'helper';
  const isOwnerOrStaff = role === 'owner' || role === 'staff';
  const isOwner = role === 'owner';

  return {
    role,
    displayName,
    isProfileLoading: loading || profileLoading,
    canViewPage: (path: string) => {
      // Unauthenticated (role is null)
      if (!role) {
        return path === '/' || path === '/dashboard' || path === '/purchase-records' || path === '/inventory' || path === '/login';
      }
      // Viewer
      if (role === 'viewer') {
        return path === '/' || path === '/dashboard' || path === '/purchase-records' || path === '/inventory' || path === '/purchasing' || path === '/login' || path === '/japan-packages' || path.startsWith('/japan-packages/');
      }
      // Helper (cannot view settings)
      if (role === 'helper') {
        return path !== '/settings';
      }
      // Owner and Staff can view all pages
      return true;
    },
    canCreate: () => isEditor,
    canEdit: () => isEditor,
    canDeleteGroup: () => isOwner,
    canImportXLS: () => isOwnerOrStaff,
    canSwitchMode: () => isOwnerOrStaff,
    canManageUsers: () => isOwner,
  };
}
