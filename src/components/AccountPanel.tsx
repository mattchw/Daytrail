import { ArrowRight, Check, Download, LoaderCircle, LogOut, Monitor, UserRound, X } from 'lucide-react';
import type { useAuth } from '../useAuth';
import './account.css';

type Auth = ReturnType<typeof useAuth>;

export function GoogleMark() {
  return <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.4 38.03 46.98 31.87 46.98 24.55Z"/><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.78 24c0-1.59.27-3.13.75-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>;
}

export function AccountButton({ auth, onClick }: { auth: Auth; onClick: () => void }) {
  const name = auth.user?.name || auth.user?.email || 'Your account';
  const initials = (auth.user?.name || auth.user?.email || '').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return <button className={`dt-account-button ${auth.user ? 'is-connected' : ''}`} onClick={onClick}
    aria-label={auth.user ? `Account: ${name}` : 'Sign in or manage this device'} title={auth.user ? name : 'Your account and device'}>
    {auth.status === 'loading' ? <LoaderCircle size={17} className="dt-auth-spinner" /> : auth.user ? <span className="dt-account-initials">{initials || <UserRound size={16} />}</span> : <UserRound size={17} />}
    <span className="dt-account-button-label">{auth.user ? 'Account' : auth.status === 'loading' ? 'Account' : 'Sign in'}</span>
    {auth.error && <span className="dt-account-attention" aria-label="Account needs attention" />}
  </button>;
}

export default function AccountPanel({ auth, onSignIn, onClose, onBackup, onCloud, onSignOut }: {
  auth: Auth; onSignIn: () => Promise<void>; onClose: () => void; onBackup: () => void; onCloud: () => void; onSignOut: () => void;
}) {
  const busy = auth.status === 'loading' || !!auth.pending;
  return <div className="dt-account-panel">
    <div className="dt-account-intro">
      <span className="dt-account-hero-icon">{auth.user ? <Check size={26} /> : <UserRound size={26} />}</span>
      <p className="dt-account-eyebrow">YOUR DAYTRAIL</p>
      <h3>{auth.user ? `Welcome${auth.user.name ? `, ${auth.user.name.split(' ')[0]}` : ' back'}.` : 'A place for your adventures.'}</h3>
      <p>{auth.user ? 'Your Google account is connected.' : 'Connect your Google account, or keep planning on this device.'}</p>
    </div>
    {auth.error && <div className="dt-auth-error" role="alert"><p>{auth.error.message}</p><button className="icon-button" aria-label="Dismiss account message" onClick={auth.dismissError}><X size={16} /></button></div>}
    {auth.status === 'loading' ? <div className="dt-auth-loading" role="status"><LoaderCircle size={19} className="dt-auth-spinner" /> Checking your account…<button className="text-button" onClick={onClose}>Keep planning</button></div> : auth.user ?
      <div className="dt-account-identity"><GoogleMark /><div><strong>{auth.user.name || 'Google account'}</strong>{auth.user.email && <span>{auth.user.email}</span>}</div><span className="dt-account-connected">Connected</span></div> : <>
        <button className="dt-google-button" onClick={() => void onSignIn()} disabled={busy || auth.status === 'unconfigured'}>{auth.pending === 'signing-in' ? <LoaderCircle size={18} className="dt-auth-spinner" /> : <GoogleMark />}{auth.pending === 'signing-in' ? 'Opening Google…' : 'Continue with Google'}</button>
        {auth.status === 'unconfigured' && <div className="dt-auth-unavailable"><p>Google sign-in is not ready on this version yet. You can still plan and save trips on this device.</p>{import.meta.env.DEV && <details><summary>Local setup</summary><p>{auth.configIssue}</p><p>Follow <code>docs/GOOGLE_SIGN_IN_SETUP.md</code>, then restart the development server.</p></details>}</div>}
      </>}
    <div className="dt-account-device"><Monitor size={21} /><div><strong>Your plans, wherever you go</strong><p>Account trips sync across devices. Existing device trips stay here until you choose to save them to your account.</p></div></div>
    <button className="dt-account-backup" onClick={onCloud}><Check size={18}/><span><strong>Cloud saving & device trips</strong><small>Move device trips, review changes, or restore a deleted trip.</small></span><ArrowRight size={17}/></button>
    <button className="dt-account-backup" onClick={onBackup}><Download size={18} /><span><strong>Back up / import trips</strong><small>Keep an editable copy or move to a new browser.</small></span><ArrowRight size={17} /></button>
    <div className="dt-account-footer">
      {auth.user ? <button className="button full" disabled={busy} onClick={onSignOut}>{auth.pending === 'signing-out' ? <LoaderCircle size={16} className="dt-auth-spinner" /> : <LogOut size={16} />}{auth.pending === 'signing-out' ? 'Signing out…' : 'Sign out on this device'}</button> : <button className="button full" onClick={onClose}>Continue on this device <ArrowRight size={15} /></button>}
      {auth.error?.code === 'session' || (auth.error?.code === 'network' && !auth.pending) ? <button className="text-button" disabled={busy} onClick={() => void auth.retry()}>Check connection again</button> : null}
      <p>{auth.user ? 'Device-only trips stay in this browser. Account trips are hidden after sign-out; pending drafts remain tied to their original account.' : <>By continuing, you agree to our <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a> and <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy notice</a>.</>}</p>
    </div>
  </div>;
}
