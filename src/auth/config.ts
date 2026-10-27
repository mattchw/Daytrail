export interface AuthConfig { url: string; publishableKey: string }
export type AuthConfiguration = { config: AuthConfig; issue: null } | { config: null; issue: string };

/** Only public hosted-project configuration belongs in a Vite browser build. */
export function readAuthConfiguration(env: Record<string, unknown>): AuthConfiguration {
  const url = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL.trim() : '';
  const key = typeof env.VITE_SUPABASE_PUBLISHABLE_KEY === 'string' ? env.VITE_SUPABASE_PUBLISHABLE_KEY.trim() : '';
  if (!url || !key) return { config: null, issue: 'Google sign-in is not configured yet. Add the Supabase project URL and publishable key.' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname)
      || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== '/') throw Error();
    if (!/^sb_publishable_[A-Za-z0-9_-]{16,512}$/.test(key)) {
      return { config: null, issue: 'Use a Supabase publishable key for browser sign-in. Secret and service-role keys must never be used here.' };
    }
    return { config: { url: parsed.origin, publishableKey: key }, issue: null };
  } catch {
    return { config: null, issue: 'Check the Supabase project URL. It must be the HTTPS project URL from your Supabase dashboard.' };
  }
}
