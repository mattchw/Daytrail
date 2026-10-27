import {useEffect, useId, useRef, useState, type ChangeEvent} from 'react';
import {AlertCircle, CheckCircle2, Download, FileJson, HardDrive, LoaderCircle, Upload} from 'lucide-react';
import type {Trip} from '../model';
import {MAX_BACKUP_BYTES, mergeTripBackup, parseTripBackup, serializeTripBackup, type TripBackup, type TripBackupMerge} from '../tripBackup';
import './backup.css';

export interface TripBackupDialogProps {
  trips: Trip[];
  activeId: string;
  onDone?: () => void;
  /** Merge against current state, persist the result, then update state. Reject on failure. */
  onImport: (backup: TripBackup) => Promise<{addedCount: number; skippedCount: number}>;
}

/** Content for the app's shared native Modal; does not create a nested dialog. */
export default function TripBackupDialog({trips, activeId, onImport, onDone}: TripBackupDialogProps) {
  const id = useId(), generation = useRef(0), fileInput = useRef<HTMLInputElement>(null);
  const [backup, setBackup] = useState<TripBackup | null>(null);
  const [preview, setPreview] = useState<TripBackupMerge | null>(null);
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false), [checking, setChecking] = useState(false), [importing, setImporting] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [imported, setImported] = useState(false);

  useEffect(() => {
    if (!backup) { setPreview(null); setChecking(false); return; }
    let current = true;
    setPreview(null); setChecking(true); setError('');
    mergeTripBackup(trips, backup).then(result => { if (current) setPreview(result); })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : 'This backup could not be checked.'); })
      .finally(() => { if (current) setChecking(false); });
    return () => { current = false; };
  }, [trips, backup]);

  useEffect(() => () => { generation.current += 1; }, []);

  function download() {
    setError(''); setMessage('');
    let url: string | undefined;
    try {
      const text = serializeTripBackup(trips, activeId);
      url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `daytrail-trips-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setMessage('Backup download started. Keep the JSON file to restore your trips in another browser or at a new Daytrail address.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The backup could not be downloaded. Please try again.');
    } finally {
      if (url) { const objectUrl = url; setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000); }
    }
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0], current = ++generation.current;
    setBackup(null); setPreview(null); setError(''); setMessage(''); setFileName(file?.name ?? '');
    setReading(!!file);
    if (!file) return;
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('This backup is too large. Choose a Daytrail backup smaller than 4 MB.');
      const text = await file.text();
      if (generation.current !== current) return;
      setBackup(parseTripBackup(text));
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : 'This file could not be read.');
    } finally {
      if (generation.current === current) setReading(false);
    }
  }

  async function restore() {
    if (!backup || !preview?.addedTrips.length || importing) return;
    setImporting(true); setError(''); setMessage('');
    try {
      const result = await onImport(backup);
      setImported(result.addedCount>0);
      setMessage(`${result.addedCount} ${result.addedCount === 1 ? 'trip added' : 'trips added'} on this device.${result.skippedCount ? ` ${result.skippedCount} already present or previously imported.` : ''}`);
      setBackup(null); setPreview(null); setFileName('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The backup could not be saved on this device. Your current trips have not changed.');
    } finally { setImporting(false); }
  }

  const busy = reading || checking || importing;
  return <div className="trip-backup">
    <p className="trip-backup-intro">Keep a restorable copy of your plans, or bring your trips to another browser or Daytrail address.</p>
    <div className="trip-backup-local"><HardDrive size={17} aria-hidden="true"/><span>Trips are stored on this device. Signing in does not upload or sync them.</span></div>
    <section className="trip-backup-section" aria-labelledby={`${id}-export`}>
      <div className="trip-backup-heading"><span className="trip-backup-icon"><Download size={19} aria-hidden="true"/></span><div><h3 id={`${id}-export`}>Download your backup</h3><p>{trips.length} {trips.length === 1 ? 'trip' : 'trips'} · Itineraries, saved places and your notes</p></div></div>
      <button type="button" className="button full" onClick={download} disabled={importing}><Download size={16} aria-hidden="true"/>Download JSON backup</button>
      <p className="trip-backup-note">Place details, photos and route estimates load again when you open a trip. This file includes your personal trip notes.</p>
    </section>
    <section className="trip-backup-section" aria-labelledby={`${id}-import`}>
      <div className="trip-backup-heading"><span className="trip-backup-icon"><Upload size={19} aria-hidden="true"/></span><div><h3 id={`${id}-import`}>Restore from a backup</h3><p>Existing trips stay in place. New trips are added.</p></div></div>
      <label className="trip-backup-file-label" htmlFor={`${id}-file`}>Choose a Daytrail JSON backup</label>
      <input ref={fileInput} className="trip-backup-file" id={`${id}-file`} type="file" accept=".json,application/json" onChange={chooseFile} disabled={importing} aria-describedby={`${id}-file-help`}/>
      <p id={`${id}-file-help`} className="trip-backup-note">Up to 4 MB and 100 trips. Read-only HTML itineraries cannot be imported.</p>
      {(reading || checking) && <p className="trip-backup-status" role="status"><LoaderCircle size={16} className="trip-backup-spin" aria-hidden="true"/>{reading ? 'Reading your backup…' : 'Checking for existing trips…'}</p>}
      {backup && <div className="trip-backup-preview" aria-label="Backup preview">
        <div className="trip-backup-preview-heading"><FileJson size={18} aria-hidden="true"/><div><strong>{fileName || 'Daytrail backup'}</strong><span>{backup.trips.length} {backup.trips.length === 1 ? 'trip' : 'trips'} · Exported {new Date(backup.exportedAt).toLocaleDateString()}</span></div></div>
        {backup.trips.length > 0 ? <ul className="trip-backup-trips">{backup.trips.map(trip => <li key={trip.id}><strong>{trip.name}</strong><span>{trip.destination} · {trip.startDate} · {trip.days.length} {trip.days.length === 1 ? 'day' : 'days'}</span></li>)}</ul> : <p className="trip-backup-note">There are no trips in this backup.</p>}
        {preview && <p className="trip-backup-summary" role="status">{preview.addedTrips.length ? `${preview.addedTrips.length} ${preview.addedTrips.length === 1 ? 'trip will be added' : 'trips will be added'}.` : 'No new trips to add.'}{preview.skippedCount > 0 && ` ${preview.skippedCount} already present or previously imported.`}</p>}
      </div>}
      {backup && <button type="button" className="button primary full" onClick={restore} disabled={busy || !preview?.addedTrips.length}>{importing ? <LoaderCircle size={16} className="trip-backup-spin" aria-hidden="true"/> : <Upload size={16} aria-hidden="true"/>}{importing ? 'Saving on this device…' : `Add ${preview?.addedTrips.length ?? 0} ${(preview?.addedTrips.length ?? 0) === 1 ? 'trip' : 'trips'} to this device`}</button>}
    </section>
    {error && <p className="trip-backup-feedback trip-backup-error" role="alert"><AlertCircle size={17} aria-hidden="true"/><span>{error}</span></p>}
    {message && <p className="trip-backup-feedback trip-backup-success" role="status"><CheckCircle2 size={17} aria-hidden="true"/><span>{message}</span></p>}
    {imported && onDone && <button className="button primary full" type="button" onClick={onDone}>Back to my trips</button>}
  </div>;
}
