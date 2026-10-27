import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readAuthConfiguration, type AuthConfig } from './config';
import { createAuthController, readAuthCallback, type AuthPort, type AuthResult } from './controller';

import {readOfflineProfile,clearOfflineProfile} from '../offline/profile';

let controller: ReturnType<typeof createAuthController> | undefined;
let browserClient: SupabaseClient | null = null;

/** The SDK must process a callback before recovering an older invalid session,
 * whose cleanup would otherwise remove the new flow's PKCE verifier. */
export function createSupabaseAuthAdapter(config: AuthConfig, initialHref: string, options: {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey?: string;
  fetch?: typeof globalThis.fetch;
} = {}) {
  const callback = readAuthCallback(new URL(initialHref));
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  let exchangeAttempted = false;
  let exchangeSucceeded = false;
  let completion: Promise<AuthResult> | null = null;
  const client = createClient(config.url, config.publishableKey, {
    auth: {
      flowType: 'pkce',
      // A boolean matters: auth-js interprets a function as an implicit-flow
      // detector. Only this document's explicit Daytrail callback is handled.
      detectSessionInUrl: callback.isCallback,
      persistSession: true,
      autoRefreshToken: true,
      ...(options.storage ? { storage: options.storage } : {}),
      ...(options.storageKey ? { storageKey: options.storageKey } : {}),
    },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const exchanging = callback.isCallback && url.origin === config.url && url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce';
      if (exchanging) exchangeAttempted = true;
      const response = await fetcher(input, init);
      if (exchanging && response.ok) exchangeSucceeded = true;
      return response;
    } },
  });
  const port: AuthPort = {
    getSession: () => client.auth.getSession(),
    completeCallback: () => completion ??= (async () => {
      const result = await client.auth.initialize();
      if (result.error) return { data: { session: null }, error: result.error };
      if (!callback.isCallback || !callback.code || callback.error) return { data: { session: null }, error: { code: 'invalid_callback' } };
      // With no verifier the SDK can fall back to an existing stored session.
      // That must never count as successful completion of this new attempt.
      if (!exchangeAttempted || !exchangeSucceeded) return { data: { session: null }, error: { code: 'pkce_code_verifier_not_found' } };
      return client.auth.getSession();
    })(),
    signInWithOAuth: async input => {
      // PKCE's verifier must survive the external redirect. Supabase otherwise
      // falls back to memory when storage is blocked, which cannot do that.
      const probe = 'daytrail.auth.storage-check';
      try {
        const storage = options.storage || window.localStorage;
        storage.setItem(probe, '1');
        if (storage.getItem(probe) !== '1') throw Error();
        storage.removeItem(probe);
      } catch { return { data: { url: null }, error: { code: 'storage_unavailable' } }; }
      return client.auth.signInWithOAuth(input);
    },
    signOut: input => client.auth.signOut(input),
    onAuthStateChange: listener => {
      const { data: { subscription } } = client.auth.onAuthStateChange(listener);
      return () => subscription.unsubscribe();
    },
  };
  return { port, client, dispose: () => client.auth.dispose() };
}

/** One client and one callback exchange per document, including React StrictMode. */
export function getBrowserAuth() {
  if (controller) return controller;
  const initialHref = window.location.href;
  const { config, issue } = readAuthConfiguration(import.meta.env);
  const adapter = config ? createSupabaseAuthAdapter(config, initialHref) : null;
  const port = adapter?.port ?? null;
  browserClient = adapter?.client ?? null;
  controller = createAuthController(port, {
    href: () => window.location.href,
    initialHref,
    replaceURL: path => {
      const previousURL = window.location.href;
      const previousHash = window.location.hash;
      window.history.replaceState(window.history.state, '', path);
      // Restore existing shared-trip views after OAuth without a second page load.
      const nextURL = window.location.href;
      if (previousHash !== window.location.hash) queueMicrotask(() => window.dispatchEvent(new HashChangeEvent('hashchange', {oldURL:previousURL,newURL:nextURL})));
    },
    navigate: url => window.location.assign(url),
    storage: {
      getItem: key => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: key => window.sessionStorage.removeItem(key),
    },
    now: () => Date.now(),
    authOrigin: config?.url || '',
    online:()=>navigator.onLine!==false,
    offlineProfile:{read:()=>readOfflineProfile(),clear:()=>clearOfflineProfile()},
  }, issue);
  window.addEventListener('online',()=>{void controller?.retry();});
  window.addEventListener('focus',()=>{if(controller?.getSnapshot().offline&&navigator.onLine!==false)void controller.retry();});
  return controller;
}

/** Data requests share the SDK instance that owns the PKCE exchange and session. */
export function getBrowserSupabaseClient(): SupabaseClient | null {
  getBrowserAuth();
  return browserClient;
}
