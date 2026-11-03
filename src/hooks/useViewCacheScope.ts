import { useAuth } from '../auth/authContext';
import { getProviderMode } from '../providers/providerMode';

/** Provider mode + signed-in user: the identity a page-level return cache must match. */
export function useViewCacheScope(): string {
  const { user } = useAuth();
  return `${getProviderMode()}:${user?.id ?? ''}`;
}
