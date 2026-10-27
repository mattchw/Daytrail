import { useEffect, useSyncExternalStore } from 'react';
import { getBrowserAuth } from './auth/browser';
export type { AuthUser, AuthSnapshot, AuthError } from './auth/controller';

/** Authentication only. Signing in or out never reads or writes trip storage. */
export function useAuth() {
  const auth = getBrowserAuth();
  const snapshot = useSyncExternalStore(auth.subscribe, auth.getSnapshot, auth.getSnapshot);
  useEffect(() => {
    void auth.start();
    const resume = (event: PageTransitionEvent) => { if (event.persisted) void auth.resumeFromNavigation(); };
    window.addEventListener('pageshow', resume);
    return () => window.removeEventListener('pageshow', resume);
  }, [auth]);
  return { ...snapshot, signIn: auth.signIn, signOut: auth.signOut, retry: auth.retry, dismissError: auth.dismissError };
}
