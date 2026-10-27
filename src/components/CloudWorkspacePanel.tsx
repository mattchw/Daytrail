import {useId} from 'react';
import {AlertCircle, ArrowRight, Check, CheckCheck, Cloud, CloudOff, Copy, HardDrive, Info, LoaderCircle, LogOut, RefreshCw, RotateCcw, Trash2, Upload, UserRound, WifiOff, type LucideIcon} from 'lucide-react';
import './cloud-workspace.css';

export type CloudLibrary = 'account' | 'device';
export type CloudSaveState = 'local' | 'saving' | 'syncing' | 'saved' | 'offline' | 'auth' | 'conflict' | 'failed' | 'setup';
export interface CloudTripSummary { id: string; name: string; destination?: string; startDate?: string; dayCount?: number }
export interface CloudTrashSummary extends CloudTripSummary { deletedAt?: string | null }
export interface CloudConflictSummary { id: string; tripName: string; updatedAt?: string | null; savedVersionDeleted?: boolean }

const statusInfo: Record<CloudSaveState, {label: string; detail: string; tone: string; icon: LucideIcon}> = {
  local: {label: 'On this device', detail: 'These plans are saved in this browser. Move them to your account to open them on another device.', tone: 'quiet', icon: HardDrive},
  saving: {label: 'Saving on this device…', detail: 'Your latest changes are being saved in this browser. Keep this page open until saving finishes.', tone: 'working', icon: LoaderCircle},
  syncing: {label: 'Syncing your trips…', detail: 'Sending saved device changes to your account and checking for updates from other devices.', tone: 'working', icon: RefreshCw},
  saved: {label: 'Saved to your account', detail: 'Your latest changes have been saved to your account.', tone: 'saved', icon: CheckCheck},
  offline: {label: 'Offline', detail: 'Connect to the internet to sync with your account.', tone: 'attention', icon: WifiOff},
  auth: {label: 'Sign in to finish saving', detail: 'Sign in to the same account to reconnect and finish saving your changes.', tone: 'attention', icon: UserRound},
  conflict: {label: 'Review changes', detail: 'A trip changed elsewhere while you were editing. Choose which changes to keep below.', tone: 'attention', icon: Copy},
  failed: {label: 'Couldn’t save', detail: 'Your latest changes could not be saved. Keep this page open, review the message below, and try again.', tone: 'attention', icon: AlertCircle},
  setup: {label: 'Cloud saving unavailable', detail: 'Cloud saving is not ready on this version yet. You can still use the trips stored on this device.', tone: 'quiet', icon: CloudOff},
};

function dateLabel(value?: string | number | null, includeTime = false): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric', ...(includeTime ? {hour: 'numeric' as const, minute: '2-digit' as const} : {})}).format(date);
}

function tripDescription(trip: CloudTripSummary): string {
  return [trip.destination, dateLabel(trip.startDate), trip.dayCount !== undefined ? `${trip.dayCount} ${trip.dayCount === 1 ? 'day' : 'days'}` : null].filter(Boolean).join(' · ');
}

export interface CloudLibrarySwitchProps {
  value: CloudLibrary;
  signedIn: boolean;
  disabled?: boolean;
  onChange: (library: CloudLibrary) => void;
}

/** Native radios provide arrow-key navigation and a single selected library. */
export function CloudLibrarySwitch({value, signedIn, disabled = false, onChange}: CloudLibrarySwitchProps) {
  const id = useId();
  return <fieldset className="cw-library-switch" disabled={disabled} aria-describedby={!signedIn ? `${id}-help` : undefined}>
    <legend className="cw-sr-only">Trip library</legend>
    <label className={`cw-library-option ${value === 'account' ? 'is-active' : ''}`}>
      <input type="radio" name={`${id}-library`} value="account" checked={value === 'account'} disabled={!signedIn} onChange={() => onChange('account')}/>
      <Cloud size={16} aria-hidden="true"/><span>Your account</span>
    </label>
    <label className={`cw-library-option ${value === 'device' ? 'is-active' : ''}`}>
      <input type="radio" name={`${id}-library`} value="device" checked={value === 'device'} onChange={() => onChange('device')}/>
      <HardDrive size={16} aria-hidden="true"/><span>On this device</span>
    </label>
    {!signedIn && <span id={`${id}-help`} className="cw-sr-only">Sign in to use your account library.</span>}
  </fieldset>;
}

export interface CloudSaveStatusProps {
  /** Pass "saved" only after the server acknowledges the current revision. */
  status: CloudSaveState;
  pendingCount?: number;
  savedAt?: string | number | null;
  onAction?: () => void;
  actionLabel?: string;
  compact?: boolean;
}

export function CloudSaveStatus({status, pendingCount = 0, savedAt, onAction, actionLabel, compact = false}: CloudSaveStatusProps) {
  const waiting = Math.max(0, pendingCount);
  const effectiveStatus = status === 'saved' && waiting > 0 ? 'syncing' : status;
  const info = statusInfo[effectiveStatus], Icon = info.icon;
  const label = effectiveStatus === 'offline' && waiting > 0 ? `Offline · ${waiting} ${waiting === 1 ? 'change' : 'changes'} waiting` : info.label;
  const savedLabel = effectiveStatus === 'saved' ? dateLabel(savedAt, true) : null;
  const action = actionLabel ?? (effectiveStatus === 'failed' || effectiveStatus === 'offline' ? 'Retry' : effectiveStatus === 'auth' ? 'Sign in' : effectiveStatus === 'conflict' ? 'Review' : 'Manage');
  return <div className={`cw-save-status cw-tone-${info.tone} ${compact ? 'is-compact' : ''}`}>
    <span className="cw-save-status-text" role="status" aria-live="polite" aria-atomic="true" title={savedLabel ? `Saved ${savedLabel}` : info.detail}>
      <Icon size={15} className={effectiveStatus === 'saving' || effectiveStatus === 'syncing' ? 'cw-spin' : undefined} aria-hidden="true"/><span>{label}</span>
    </span>
    {onAction && <button type="button" className="cw-status-action" onClick={onAction}>{action}<ArrowRight size={12} aria-hidden="true"/></button>}
  </div>;
}

export interface CloudWorkspacePanelProps {
  signedIn: boolean;
  /** Identifies which library supplies trashTrips and receives restored trips. */
  library?: CloudLibrary;
  accountName?: string;
  accountEmail?: string;
  status: CloudSaveState;
  pendingCount?: number;
  savedAt?: string | number | null;
  guestTrips: readonly CloudTripSummary[];
  selectedGuestIds: readonly string[];
  onSelectGuestIds: (ids: string[]) => void;
  onImportGuest: (ids: string[]) => void;
  trashTrips: readonly CloudTrashSummary[];
  onRestore: (id: string) => void;
  conflicts?: readonly CloudConflictSummary[];
  onKeepConflictCopy: (id: string) => void;
  onUseSavedVersion: (id: string) => void;
  onRetry?: () => void;
  onSignIn?: () => void;
  loading?: boolean;
  importing?: boolean;
  restoringId?: string | null;
  resolvingConflictId?: string | null;
  error?: string | null;
  message?: string | null;
  /** Optional developer-only setup guidance; never put credentials here. */
  setupDetail?: string;
}

/** Content for Daytrail's shared Modal; all mutations are controlled by its caller. */
export default function CloudWorkspacePanel({signedIn, library = signedIn ? 'account' : 'device', accountName, accountEmail, status, pendingCount = 0, savedAt, guestTrips,
  selectedGuestIds, onSelectGuestIds, onImportGuest, trashTrips, onRestore, conflicts = [], onKeepConflictCopy,
  onUseSavedVersion, onRetry, onSignIn, loading = false, importing = false, restoringId = null,
  resolvingConflictId = null, error, message, setupDetail}: CloudWorkspacePanelProps) {
  const id = useId();
  const selected = new Set(selectedGuestIds);
  const selectedIds = guestTrips.filter(trip => selected.has(trip.id)).map(trip => trip.id);
  const busy = loading || importing || restoringId !== null || resolvingConflictId !== null;
  const unavailable = !signedIn || status === 'auth' || status === 'setup';
  const actionsDisabled = busy || unavailable;
  const restoreDisabled = busy || library === 'account' && unavailable;
  const allSelected = guestTrips.length > 0 && selectedIds.length === guestTrips.length;
  const accountLabel = accountEmail || accountName || 'your account';
  const retryable = status === 'failed' || status === 'offline';
  const effectiveStatus = status === 'saved' && pendingCount > 0 ? 'syncing' : status;

  function toggleTrip(tripId: string, checked: boolean) {
    const next = new Set(selectedIds);
    if (checked) next.add(tripId); else next.delete(tripId);
    onSelectGuestIds([...next]);
  }

  return <div className="cw-panel">
    <div className="cw-panel-intro">
      <span className="cw-hero-icon"><Cloud size={26} aria-hidden="true"/></span>
      <div><p className="cw-eyebrow">YOUR DAYTRAIL</p><h3>Your plans, ready to go.</h3><p>Keep account trips together, and choose which plans to bring from this device.</p></div>
    </div>
    {signedIn && <div className="cw-account-identity"><UserRound size={18} aria-hidden="true"/><div><strong>{accountName || 'Your Google account'}</strong>{accountEmail && <span>{accountEmail}</span>}</div><span className="cw-account-tag">{library === 'account' ? 'Account library' : 'Device library'}</span></div>}
    <div className={`cw-state-card cw-tone-${statusInfo[effectiveStatus].tone}`}>
      <CloudSaveStatus status={effectiveStatus} pendingCount={pendingCount} savedAt={savedAt}/>
      <p>{statusInfo[effectiveStatus].detail}</p>
      {retryable && onRetry && <button type="button" className="text-button" disabled={busy} onClick={onRetry}><RefreshCw size={14} aria-hidden="true"/>Try again</button>}
      {(!signedIn || status === 'auth') && onSignIn && <button type="button" className="text-button" disabled={busy} onClick={onSignIn}>Sign in to your account<ArrowRight size={14} aria-hidden="true"/></button>}
      {status === 'setup' && import.meta.env.DEV && setupDetail && <details className="cw-setup-details"><summary>Local setup</summary><p>{setupDetail}</p></details>}
    </div>
    {error && <div className="cw-feedback is-error" role="alert"><AlertCircle size={17} aria-hidden="true"/><p>{error}</p></div>}
    {message && <div className="cw-feedback is-success" role="status"><CheckCheck size={17} aria-hidden="true"/><p>{message}</p></div>}

    {signedIn && conflicts.length > 0 && <section className="cw-section cw-conflicts" aria-labelledby={`${id}-conflicts`}>
      <div className="cw-section-heading"><span className="cw-section-icon is-attention"><Copy size={18} aria-hidden="true"/></span><div><h3 id={`${id}-conflicts`}>Choose the changes to keep</h3><p>{conflicts.length} {conflicts.length === 1 ? 'trip needs' : 'trips need'} your attention.</p></div></div>
      <div className="cw-conflict-list">{conflicts.map(conflict => {
        const resolving = resolvingConflictId === conflict.id, updated = dateLabel(conflict.updatedAt, true);
        return <article className="cw-conflict-card" key={conflict.id} aria-label={`Resolve changes to ${conflict.tripName}`} aria-busy={resolving}>
          <div className="cw-conflict-title"><strong>{conflict.tripName}</strong><span>Two versions</span></div>
          <p>{conflict.savedVersionDeleted ? 'This trip was moved to Trash elsewhere. Your changes on this device have not been applied to that saved version.' : 'This trip changed elsewhere while you were editing on this device.'}</p>
          {updated && <p className="cw-small-note">Account version updated {updated}.</p>}
          <div className="cw-conflict-actions">
            <button type="button" className="button primary" disabled={actionsDisabled} onClick={() => onKeepConflictCopy(conflict.id)}><Copy size={15} aria-hidden="true"/>Keep my changes as a separate trip</button>
            <button type="button" className="button" disabled={actionsDisabled} onClick={() => onUseSavedVersion(conflict.id)}><Cloud size={15} aria-hidden="true"/>Use saved version</button>
          </div>
          {resolving && <p className="cw-inline-loading" role="status"><LoaderCircle size={15} className="cw-spin" aria-hidden="true"/>Resolving changes…</p>}
          <p className="cw-small-note">A separate trip keeps your edits. Using the saved version replaces your unsaved edits{conflict.savedVersionDeleted ? ' and keeps this trip in Trash' : ''}.</p>
        </article>;
      })}</div>
    </section>}

    <section className="cw-section" aria-labelledby={`${id}-import`}>
      <div className="cw-section-heading"><span className="cw-section-icon"><Upload size={19} aria-hidden="true"/></span><div><h3 id={`${id}-import`}>Bring trips into your account</h3><p>Choose plans from this device. They stay here until your account confirms they are saved.</p></div></div>
      {guestTrips.length > 0 ? <>
        <div className="cw-selection-toolbar"><span>{selectedIds.length} of {guestTrips.length} selected</span><button type="button" className="text-button" disabled={actionsDisabled} onClick={() => onSelectGuestIds(allSelected ? [] : guestTrips.map(trip => trip.id))}>{allSelected ? 'Clear selection' : 'Select all'}</button></div>
        <fieldset className="cw-trip-choices" disabled={actionsDisabled} aria-describedby={`${id}-destination`}>
          <legend className="cw-sr-only">Trips to move from this device</legend>
          {guestTrips.map(trip => <label className={`cw-trip-choice ${selected.has(trip.id) ? 'is-selected' : ''}`} key={trip.id}>
            <input type="checkbox" checked={selected.has(trip.id)} onChange={event => toggleTrip(trip.id, event.currentTarget.checked)}/>
            <span className="cw-trip-copy"><strong>{trip.name}</strong><small>{tripDescription(trip)}</small></span><HardDrive size={15} aria-hidden="true"/>
          </label>)}
        </fieldset>
        <p id={`${id}-destination`} className="cw-import-destination"><Cloud size={14} aria-hidden="true"/><span>{signedIn ? <>Save to <strong>{accountLabel}</strong></> : 'Sign in to choose an account for these trips.'}</span></p>
        <button type="button" className="button primary full cw-import-button" disabled={actionsDisabled || selectedIds.length === 0} onClick={() => onImportGuest(selectedIds)}>{importing ? <LoaderCircle size={16} className="cw-spin" aria-hidden="true"/> : <Upload size={16} aria-hidden="true"/>}{importing ? 'Adding your trips…' : selectedIds.length > 0 ? `Move ${selectedIds.length} ${selectedIds.length === 1 ? 'trip' : 'trips'} to account` : 'Choose trips to move'}</button>
        <p className="cw-small-note">Only selected trips move. Once saved, find and edit them in Your account.</p>
      </> : <div className="cw-empty"><HardDrive size={23} aria-hidden="true"/><strong>No device trips to bring over</strong><p>Trips created in the device library will appear here.</p></div>}
    </section>

    <section className="cw-section cw-trash" aria-labelledby={`${id}-trash`}>
      <div className="cw-section-heading"><span className="cw-section-icon"><Trash2 size={18} aria-hidden="true"/></span><div><h3 id={`${id}-trash`}>{library === 'account' ? 'Account Trash' : 'Device Trash'} <span className="cw-count">{trashTrips.length}</span></h3><p>{library === 'account' ? 'Restore a removed trip to your account library.' : 'Restore a removed trip to the library on this device. Signing in is not required.'}</p></div></div>
      {loading ? <p className="cw-inline-loading" role="status"><LoaderCircle size={16} className="cw-spin" aria-hidden="true"/>Opening {library === 'account' ? 'account' : 'device'} Trash…</p> : trashTrips.length > 0 ? <ul className="cw-trash-list">{trashTrips.map(trip => {
        const removed = dateLabel(trip.deletedAt);
        return <li key={trip.id}><div><strong>{trip.name}</strong><span>{removed ? `Moved to Trash ${removed}` : tripDescription(trip)}</span></div><button type="button" className="button small" disabled={restoreDisabled} onClick={() => onRestore(trip.id)} aria-label={`Restore ${trip.name} to ${library === 'account' ? 'your account' : 'this device'}`}>{restoringId === trip.id ? <LoaderCircle size={15} className="cw-spin" aria-hidden="true"/> : <RotateCcw size={15} aria-hidden="true"/>}<span>Restore</span></button></li>;
      })}</ul> : <div className="cw-trash-empty"><Check size={17} aria-hidden="true"/><p>No trips in {library === 'account' ? 'account' : 'device'} Trash.</p></div>}
    </section>
  </div>;
}

export interface PendingSignOutPanelProps {
  pendingCount: number;
  accountEmail?: string;
  /** The controller must verify durable local drafts before sign-out is allowed. */
  draftsSafe: boolean;
  onStayAndSync: () => void;
  onSignOutKeepDrafts: () => void;
  busy?: boolean;
  error?: string | null;
}

/** Content for a confirmation Modal; the controller remains the sign-out authority. */
export function PendingSignOutPanel({pendingCount, accountEmail, draftsSafe, onStayAndSync, onSignOutKeepDrafts, busy = false, error}: PendingSignOutPanelProps) {
  const waiting = Math.max(0, pendingCount);
  return <div className="cw-signout-panel">
    <span className="cw-signout-icon"><CloudOff size={28} aria-hidden="true"/></span>
    <h3>Some changes are still on this device.</h3>
    <p>{waiting > 0 ? `${waiting} ${waiting === 1 ? 'change has' : 'changes have'} not finished saving to your account.` : 'Your latest changes have not finished saving to your account.'} Stay signed in to finish syncing, or keep the drafts here for later.</p>
    <div className={`cw-signout-note ${!draftsSafe ? 'is-warning' : ''}`}><Info size={18} aria-hidden="true"/><p>{draftsSafe ? <>Your drafts will stay in this browser. Sign back in{accountEmail ? <> as <strong>{accountEmail}</strong></> : ' to the same account'} here to finish saving them. They will not appear on other devices until then.</> : 'Your drafts have not been confirmed in this browser’s storage. Stay signed in and try syncing before signing out.'}</p></div>
    {error && <div className="cw-feedback is-error" role="alert"><AlertCircle size={17} aria-hidden="true"/><p>{error}</p></div>}
    <div className="cw-signout-actions">
      <button type="button" className="button primary full" disabled={busy} onClick={onStayAndSync}>{busy ? <LoaderCircle size={16} className="cw-spin" aria-hidden="true"/> : <RefreshCw size={16} aria-hidden="true"/>}Stay and sync</button>
      <button type="button" className="button full" disabled={busy || !draftsSafe} onClick={onSignOutKeepDrafts}><LogOut size={16} aria-hidden="true"/>Sign out and keep drafts here</button>
    </div>
  </div>;
}
