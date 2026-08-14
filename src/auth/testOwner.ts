import type { User } from '@supabase/supabase-js';

export const TEST_OWNER_USER = {
  id: 'test-owner',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'test-owner@local.invalid',
  app_metadata: {},
  user_metadata: { display_name: 'Test Owner' },
  created_at: '1970-01-01T00:00:00.000Z',
} as User;

export const TEST_OWNER_PROFILE = {
  role: 'owner' as const,
  display_name: 'Test Owner',
  is_active: true,
};
