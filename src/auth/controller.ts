export interface AuthUser { id: string; email?: string; name?: string }
export interface AuthError { code: string; message: string }
export interface AuthSnapshot {
  status: 'unconfigured' | 'loading' | 'signed-out' | 'signed-in';
  user: AuthUser | null;
  pending: 'signing-in' | 'signing-out' | 'refreshing' | null;
  error: AuthError | null;
  configIssue: string | null;
  /** Local prepared account access only; no network writes until session recovery. */
  offline: boolean;
}
interface ProviderUser {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  identities?: { provider: string }[];
}
export interface ProviderSession { user: ProviderUser }
export interface AuthResult { data: { session: ProviderSession | null }; error: unknown }
export interface AuthPort {
  getSession(): Promise<AuthResult>;
  /** Await the SDK-owned exchange; never exchange the single-use code a second time. */
  completeCallback(): Promise<AuthResult>;
  signInWithOAuth(input: { provider: 'google'; options: { redirectTo: string; skipBrowserRedirect: true } }): Promise<{ data: { url: string | null }; error: unknown }>;
  signOut(input: { scope: 'local' }): Promise<{ error: unknown }>;
  onAuthStateChange(listener: (event: string, session: ProviderSession | null) => void): () => void;
}
export interface AuthEnvironment {
  href(): string;
  /** Captured before SDK initialization can clean authentication parameters. */
  initialHref?: string;
  replaceURL(path: string): void;
  navigate(url: string): void;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now(): number;
  /** Exact project origin. Reject unexpected redirect destinations from the SDK. */
  authOrigin: string;
  online?(): boolean;
  offlineProfile?: {read(): AuthUser | null; clear(): void};
}
export const AUTH_RETURN_KEY = 'daytrail.auth.return.v1';
const RETURN_MAX_AGE = 30 * 60_000;
const callbackFields = ['auth', 'code', 'sb_flow_id', 'error', 'error_code', 'error_description', 'error_uri', 'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'token_type', 'expires_in', 'expires_at'];

function callbackFragment(url: URL): URLSearchParams | null {
  if (!url.hash || url.hash.startsWith('#trip=')) return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  return callbackFields.some(field => fragment.has(field)) ? fragment : null;
}

/** Read callback metadata only; provider text never becomes display text. */
export function readAuthCallback(url: URL) {
  const fragment = callbackFragment(url);
  const get = (name: string) => url.searchParams.get(name) || fragment?.get(name) || null;
  const providerError = get('error');
  const errorCode = get('error_code');
  return {
    isCallback: url.searchParams.get('auth') === 'callback',
    code: get('code'),
    error: providerError || errorCode ? { code: providerError === 'access_denied' ? 'access_denied' : errorCode || providerError, message: get('error_description') || '' } : null,
  };
}

export function safeReturnPath(value: unknown, origin: string): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const parsed = new URL(value, origin);
    return parsed.origin === origin ? parsed.pathname + parsed.search + parsed.hash : null;
  } catch { return null; }
}

function cleanCallbackURL(url: URL): string {
  const clean = new URL(url);
  for (const field of callbackFields) clean.searchParams.delete(field);
  const fragment = callbackFragment(clean);
  if (fragment) {
    for (const field of callbackFields) fragment.delete(field);
    clean.hash = fragment.toString();
  }
  return clean.pathname + clean.search + clean.hash;
}

function displayUser(session: ProviderSession | null): AuthUser | null {
  if (!session?.user || typeof session.user.id !== 'string' || !session.user.id) return null;
  const user = session.user;
  const metadata = user.user_metadata || {};
  const name = typeof metadata.full_name === 'string' ? metadata.full_name : typeof metadata.name === 'string' ? metadata.name : '';
  return { id: user.id, ...(typeof user.email === 'string' ? { email: user.email.slice(0, 320) } : {}), ...(name ? { name: name.slice(0, 160) } : {}) };
}

/** Never surface provider text: it can contain URLs, tokens, or arbitrary callback content. */
export function authError(error: unknown, context: 'session' | 'callback' | 'sign-in' | 'sign-out'): AuthError {
  const value = error && typeof error === 'object' ? error as { code?: unknown; name?: unknown; status?: unknown; message?: unknown } : {};
  if (value.code === 'storage_unavailable') return { code: 'storage', message: 'Browser storage is unavailable. Allow site storage, then try signing in again.' };
  if (value.code === 'access_denied') return { code: 'cancelled', message: 'Google sign-in was cancelled. Your trips are still on this device.' };
  if (typeof value.message === 'string' && /unable to exchange external code/i.test(value.message)) return { code: 'provider-exchange', message: 'Supabase could not complete sign-in with Google. The app owner should check Supabase’s Google provider settings.' };
  if (value.code === 'pkce_code_verifier_not_found' || value.name === 'AuthPKCECodeVerifierMissingError' || value.code === 'bad_code_verifier') return { code: 'verifier', message: 'This browser could not match the sign-in attempt. Start Google sign-in again and finish in the same browser and tab.' };
  if (['flow_state_expired', 'flow_state_not_found', 'bad_oauth_state'].includes(String(value.code))) return { code: 'expired', message: 'This sign-in attempt has expired or has already been used. Start Google sign-in again.' };
  if (['invalid_client', 'unauthorized_client', 'redirect_uri_mismatch'].includes(String(value.code))) return { code: 'google-config', message: 'Google rejected the app’s sign-in configuration. The app owner should check the OAuth client and callback settings.' };
  if (value.name === 'AuthRetryableFetchError' || value.name === 'TypeError' || value.status === 0) return { code: 'network', message: 'Could not reach the sign-in service. Check your connection and try again.' };
  if (value.code === 'provider_disabled' || value.code === 'oauth_provider_not_supported') return { code: 'provider', message: 'Google sign-in is not enabled for this project yet.' };
  if (context === 'callback') return { code: 'callback', message: 'This sign-in link could not be completed. Please sign in with Google again in this browser.' };
  if (context === 'sign-out') return { code: 'sign-out', message: 'Could not sign out. Check your connection and try again.' };
  if (context === 'sign-in') return { code: 'sign-in', message: 'Could not start Google sign-in. Please try again.' };
  return { code: 'session', message: 'Could not check your sign-in session. Please try again.' };
}

export function createAuthController(client: AuthPort | null, env: AuthEnvironment, configIssue: string | null = null) {
  let snapshot: AuthSnapshot = { status: client ? 'loading' : 'unconfigured', user: null, pending: null, error: null, configIssue, offline: false };
  const listeners = new Set<() => void>();
  let startPromise: Promise<void> | null = null;
  let actionPromise: Promise<boolean> | null = null;
  let actionKind: 'sign-in' | 'sign-out' | 'refresh' | null = null;
  let unsubscribe: (() => void) | null = null;
  let sessionEpoch = 0;
  let disposed = false;
  let redirecting = false;
  const publish = (patch: Partial<AuthSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const acceptSession = (session: ProviderSession | null) => {
    const user = displayUser(session);
    const prepared=env.offlineProfile?.read();
    if(prepared&&(!user||prepared.id!==user.id)){try{env.offlineProfile?.clear();}catch{/* Never turn a failed local cleanup into account authorization. */}}
    publish({ status: user ? 'signed-in' : 'signed-out', user, offline: false });
  };
  const removeReturn = () => { try { env.storage.removeItem(AUTH_RETURN_KEY); } catch { /* The trip store is never touched. */ } };
  function returnPath(url: URL) {
    try {
      const raw = env.storage.getItem(AUTH_RETURN_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved.createdAt === 'number' && saved.createdAt <= env.now() && env.now() - saved.createdAt <= RETURN_MAX_AGE) {
          const safe = safeReturnPath(saved.path, url.origin);
          if (safe) return safe;
        }
      }
    } catch { /* Missing metadata must not prevent a valid callback. */ }
    return cleanCallbackURL(url);
  }
  async function loadSession() {
    if (!client) return;
    const epoch = sessionEpoch;
    const resume=()=>{const user=env.offlineProfile?.read();if(!user)return false;publish({status:'signed-in',user,offline:true,error:null});return true;};
    if(env.online?.()===false&&resume())return;
    try {
      const result = await client.getSession();
      if (epoch !== sessionEpoch || disposed) return;
      if (result.error) throw result.error;
      acceptSession(result.data.session);
    } catch (error) {
      if (epoch === sessionEpoch) {const failure=authError(error,'session');if(failure.code==='network'&&resume())return;publish({ status: snapshot.user ? 'signed-in' : 'signed-out', offline:!!snapshot.user,error: failure });}
    }
  }
  async function initialize() {
    if (!client) {
      const url = new URL(env.initialHref || env.href());
      if (url.searchParams.get('auth') === 'callback') {
        env.replaceURL(returnPath(url));
        removeReturn();
      }
      return;
    }
    unsubscribe = client.onAuthStateChange((event, session) => {
      if (disposed) return;
      // INITIAL_SESSION may arrive during the explicit PKCE exchange; it must not
      // replace the resulting sign-in with an earlier empty session.
      if (event === 'INITIAL_SESSION') return;
      if(!session&&event==='SIGNED_OUT'&&env.online?.()===false&&env.offlineProfile?.read())return;
      sessionEpoch += 1;
      acceptSession(session);
      if (session || event === 'SIGNED_OUT') publish({ error: null });
    });
    const url = new URL(env.initialHref || env.href());
    const callback = readAuthCallback(url);
    if (callback.isCallback) {
      publish({ pending: 'signing-in' });
      const destination = returnPath(url);
      try {
        if (callback.error) throw callback.error;
        const code = callback.code;
        if (!code || code.length > 4096) throw { code: 'invalid_callback' };
        const epoch = sessionEpoch;
        const result = await client.completeCallback();
        if (result.error) throw result.error;
        // The exchange normally emits SIGNED_IN. A later SIGNED_OUT event wins.
        if (epoch === sessionEpoch) acceptSession(result.data.session);
        if (!result.data.session) throw { code: 'invalid_callback' };
      } catch (error) {
        await loadSession();
        publish({ error: authError(error, 'callback') });
      } finally {
        removeReturn();
        env.replaceURL(destination);
        publish({ pending: null });
      }
    } else {
      await loadSession();
      // Returning with the browser Back button leaves no OAuth callback.
      // Clear only the flow metadata; an ordinary visit is not a sign-in error.
      removeReturn();
    }
  }
  const start = () => startPromise ??= initialize();
  const signIn = (beforeRedirect?: () => void | Promise<void>): Promise<boolean> => {
    if (!client || disposed) return Promise.resolve(false);
    if (actionPromise) return actionKind === 'sign-in' ? actionPromise : Promise.resolve(false);
    actionKind = 'sign-in';
    actionPromise = (async () => {
      await start();
      publish({ pending: 'signing-in', error: null });
      const saveBeforeLeaving = async () => {
        try { await beforeRedirect?.(); return true; } catch {
          publish({ error: { code: 'local-save', message: 'Your latest changes could not be saved on this device. Resolve the save error before signing in.' } });
          return false;
        }
      };
      const rememberReturn = () => {
        const current = new URL(env.href());
        const path = safeReturnPath(current.pathname + current.search + current.hash, current.origin) || '/';
        try {
          env.storage.setItem(AUTH_RETURN_KEY, JSON.stringify({ path, createdAt: env.now() }));
          return true;
        } catch {
          removeReturn();
          publish({ error: { code: 'storage', message: 'Browser storage is unavailable. Allow site storage, then try signing in again.' } });
          return false;
        }
      };
      try {
        if (!await saveBeforeLeaving()) return false;
        const current = new URL(env.href());
        if (!rememberReturn()) return false;
        const result = await client.signInWithOAuth({ provider: 'google', options: { redirectTo: current.origin + '/?auth=callback', skipBrowserRedirect: true } });
        if (result.error) throw result.error;
        if (!result.data.url) throw Error();
        const redirect = new URL(result.data.url);
        if (redirect.origin !== env.authOrigin || redirect.pathname !== '/auth/v1/authorize' || redirect.searchParams.get('provider') !== 'google') throw Error();
        // The account panel can close while the SDK prepares its OAuth URL.
        // Flush again using the caller's latest state immediately before leaving.
        if (!await saveBeforeLeaving()) { removeReturn(); return false; }
        if (!rememberReturn()) return false;
        env.navigate(redirect.href);
        redirecting = true;
        return true;
      } catch (error) {
        removeReturn();
        publish({ error: authError(error, 'sign-in') });
        return false;
      } finally {
        if (!redirecting) { publish({ pending: null }); actionPromise = null; actionKind = null; }
      }
    })();
    return actionPromise;
  };
  const signOut = (): Promise<boolean> => {
    if (!client || disposed) return Promise.resolve(false);
    if (actionPromise) return actionKind === 'sign-out' ? actionPromise : Promise.resolve(false);
    actionKind = 'sign-out';
    actionPromise = (async () => {
      await start();
      publish({ pending: 'signing-out', error: null });
      try {
        // Disable offline resume before the provider clears its cached session.
        env.offlineProfile?.clear();
        const result = await client.signOut({ scope: 'local' });
        if (result.error) throw result.error;
        sessionEpoch += 1;
        acceptSession(null);
        removeReturn();
        return true;
      } catch (error) {
        publish({ error: authError(error, 'sign-out') });
        return false;
      } finally { publish({ pending: null }); actionPromise = null; actionKind = null; }
    })();
    return actionPromise;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start,
    signIn,
    signOut,
    retry: (): Promise<void> => {
      if (!client || actionPromise || disposed) return Promise.resolve();
      actionKind = 'refresh';
      actionPromise = (async () => {
        await start();
        publish({ pending: 'refreshing', error: null });
        try { await loadSession(); return true; }
        finally { publish({ pending: null }); actionPromise = null; actionKind = null; }
      })();
      return actionPromise.then(() => {});
    },
    dismissError: () => publish({ error: null }),
    resumeFromNavigation: async () => {
      if (!redirecting || disposed) return;
      redirecting = false;
      actionPromise = null;
      actionKind = null;
      removeReturn();
      publish({ pending: null });
      await loadSession();
    },
    dispose: () => { disposed = true; unsubscribe?.(); listeners.clear(); },
  };
}
