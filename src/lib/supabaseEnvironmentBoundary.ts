export const PRODUCTION_SUPABASE_PROJECT_REF = 'twzpqyesbtnfxdkorluf';
export const STAGING_SUPABASE_PROJECT_REF = 'rhfdjsklfrgpoqsaqpkn';

export type SupabaseRuntimeRole =
  | 'production'
  | 'staging'
  | 'next'
  | 'experimental'
  | 'test'
  | 'local';

export interface SupabaseEnvironmentBoundaryInput {
  supabaseUrl: string;
  viteMode?: string | null;
  sandboxEnvironment?: string | null;
  deploymentEnvironment?: string | null;
  cloudPreviewEnabled?: boolean;
  providerMode?: string | null;
}

export interface SupabaseEnvironmentBoundaryResult {
  role: SupabaseRuntimeRole;
  projectRef: string;
}

export class SupabaseEnvironmentBoundaryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SupabaseEnvironmentBoundaryError';
    this.code = code;
  }
}

export function parseSupabaseProjectRef(supabaseUrl: string): string {
  try {
    const url = new URL(supabaseUrl);
    const [projectRef, ...suffix] = url.hostname.toLowerCase().split('.');
    if (!projectRef || suffix.join('.') !== 'supabase.co') {
      throw new Error('unexpected Supabase hostname');
    }
    return projectRef;
  } catch {
    throw new SupabaseEnvironmentBoundaryError(
      'SUPABASE_URL_INVALID',
      'Supabase URL 無效，已拒絕啟動 Cloud runtime。',
    );
  }
}

export function buildSupabaseProjectUrl(projectRef: string): string {
  const url = new URL('https://supabase.co');
  url.hostname = `${projectRef}.${url.hostname}`;
  return url.toString().replace(/\/$/u, '');
}

const normalizeRole = (value: string | null | undefined): SupabaseRuntimeRole | null => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod') return 'production';
  if (normalized === 'staging' || normalized === 'preview' || normalized === 'cloud-preview') return 'staging';
  if (normalized === 'next') return 'next';
  if (normalized === 'experimental') return 'experimental';
  if (normalized === 'test') return 'test';
  if (normalized === 'local') return 'local';
  return null;
};

export function resolveSupabaseRuntimeRole(
  input: Omit<SupabaseEnvironmentBoundaryInput, 'supabaseUrl'>,
): SupabaseRuntimeRole {
  const deploymentRole = normalizeRole(input.deploymentEnvironment);
  if (deploymentRole) return deploymentRole;

  const sandboxRole = normalizeRole(input.sandboxEnvironment);
  if (sandboxRole === 'next' || sandboxRole === 'experimental' || sandboxRole === 'test') {
    return sandboxRole;
  }

  const viteRole = normalizeRole(input.viteMode);
  if (viteRole === 'next' || viteRole === 'experimental' || viteRole === 'test' || viteRole === 'staging') {
    return viteRole;
  }

  if (input.cloudPreviewEnabled) return 'staging';
  if (viteRole === 'production') return 'production';

  const providerRole = normalizeRole(input.providerMode);
  if (providerRole === 'next' || providerRole === 'experimental' || providerRole === 'test') {
    return providerRole;
  }
  if (providerRole === 'local') return 'local';

  // The existing local operator runtime uses Vite's development mode to
  // exercise the Production-shaped Cloud provider. It must still satisfy the
  // Production project-ref rule below.
  if (input.viteMode?.trim().toLowerCase() === 'development') return 'production';

  throw new SupabaseEnvironmentBoundaryError(
    'SUPABASE_RUNTIME_ROLE_UNDECLARED',
    'Cloud runtime 未宣告 Production 或 Staging 角色，已拒絕啟動。',
  );
}

export function assertSupabaseEnvironmentBoundary(
  input: SupabaseEnvironmentBoundaryInput,
): SupabaseEnvironmentBoundaryResult {
  const role = resolveSupabaseRuntimeRole(input);
  const projectRef = parseSupabaseProjectRef(input.supabaseUrl);

  if (role === 'production') {
    if (projectRef !== PRODUCTION_SUPABASE_PROJECT_REF) {
      throw new SupabaseEnvironmentBoundaryError(
        'PRODUCTION_SUPABASE_PROJECT_REF_MISMATCH',
        `Production runtime 只能連線 ${PRODUCTION_SUPABASE_PROJECT_REF}。`,
      );
    }
    return { role, projectRef };
  }

  if (role === 'local') {
    return { role, projectRef };
  }

  if (projectRef === PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new SupabaseEnvironmentBoundaryError(
      'NON_PRODUCTION_SUPABASE_PROJECT_BLOCKED',
      `${role.toUpperCase()} runtime 禁止連線 Production Supabase。`,
    );
  }

  if (projectRef !== STAGING_SUPABASE_PROJECT_REF) {
    throw new SupabaseEnvironmentBoundaryError(
      'STAGING_SUPABASE_PROJECT_REF_MISMATCH',
      `${role.toUpperCase()} runtime 只能連線隔離 Staging ${STAGING_SUPABASE_PROJECT_REF}。`,
    );
  }

  return { role, projectRef };
}
