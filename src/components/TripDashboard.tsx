import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Check, Compass, Copy, MapPin, Plus, Route, Trash2, X } from 'lucide-react';
import type { Trip } from '../model';
import './dashboard.css';

type Props = {
  trips: Trip[];
  onOpen: (id: string) => void;
  onCreate: (name: string, destination: string, startDate: string, days: number, timezone: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
};

function dateRange(trip: Trip) {
  const start = new Date(`${trip.startDate}T12:00:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + Math.max(0, trip.days.length - 1));
  if (Number.isNaN(start.getTime())) return 'Dates to be decided';
  const format = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  if (trip.days.length === 1) return `${format.format(start)} ${start.getFullYear()}`;
  if (start.getFullYear() !== end.getFullYear()) {
    const full = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return `${full.format(start)} – ${full.format(end)}`;
  }
  return `${format.format(start)} – ${format.format(end)} ${end.getFullYear()}`;
}

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function JourneyIllustration({ variant = 0 }: { variant?: number }) {
  const palettes = [
    { background: '#DDE9DE', hill: '#BCCFBE', building: '#F8E7C7', roof: '#3B7165', accent: '#C48658' },
    { background: '#E5E6EE', hill: '#C8CEDD', building: '#FAE9D6', roof: '#74799C', accent: '#BE806D' },
    { background: '#EFE3CF', hill: '#D7CCB5', building: '#FFF3DB', roof: '#8C986C', accent: '#BD785B' },
  ];
  const palette = palettes[variant % palettes.length];
  return (
    <svg className="dt-dash-journey" viewBox="0 0 420 200" fill="none" aria-hidden="true">
      <rect width="420" height="200" fill={palette.background} />
      <circle cx="320" cy="49" r="24" fill="#FFFCF7" opacity=".8" />
      <path d="M-30 161C41 94 64 106 110 138C167 45 202 49 260 121C302 92 368 100 450 159V220H-30Z" fill={palette.hill} />
      <path d="M-10 184C76 149 124 168 191 159C265 148 321 142 430 180V220H-10Z" fill={palette.roof} opacity=".12" />
      <path d="M19 192C67 164 120 191 150 179C174 168 148 152 174 141C209 126 232 168 278 164C309 160 318 137 355 132" stroke="#FFFCF7" strokeWidth="9" strokeLinecap="round" />
      <path d="M19 192C67 164 120 191 150 179C174 168 148 152 174 141C209 126 232 168 278 164C309 160 318 137 355 132" stroke={palette.roof} strokeWidth="2" strokeLinecap="round" strokeDasharray="3 7" opacity=".6" />
      <rect x="71" y="116" width="57" height="46" rx="2" fill={palette.building} />
      <path d="M59 117L99 92L140 117Z" fill={palette.roof} />
      <rect x="82" y="91" width="36" height="25" fill={palette.building} />
      <path d="M74 93L100 73L126 93Z" fill={palette.roof} />
      <rect x="91" y="73" width="18" height="20" fill={palette.building} />
      <path d="M83 75L100 60L117 75Z" fill={palette.roof} />
      <path d="M100 53V64" stroke={palette.roof} strokeWidth="3" strokeLinecap="round" />
      <rect x="92" y="136" width="15" height="26" rx="7" fill={palette.roof} opacity=".6" />
      <path d="M81 128H85M114 128H118M96 102H104" stroke={palette.accent} strokeWidth="4" strokeLinecap="round" />
      <path d="M267 140V96M257 111L267 119L279 106" stroke={palette.roof} strokeWidth="4" strokeLinecap="round" />
      <circle cx="258" cy="93" r="17" fill={palette.accent} opacity=".7" />
      <circle cx="278" cy="88" r="18" fill={palette.accent} opacity=".8" />
      <circle cx="268" cy="74" r="18" fill={palette.accent} />
      <path d="M51 164V145M47 150L51 153L57 147M375 164V144M370 150L375 154L382 146" stroke={palette.roof} strokeWidth="3" strokeLinecap="round" />
      <circle cx="355" cy="126" r="13" fill={palette.roof} />
      <circle cx="355" cy="126" r="5" fill="#FFFCF7" />
      <path d="M355 143L350 136H360Z" fill={palette.roof} />
      <path d="M185 51C191 47 195 47 201 51M207 42C213 38 217 38 223 42" stroke={palette.roof} strokeWidth="2" strokeLinecap="round" opacity=".5" />
    </svg>
  );
}

export default function TripDashboard({ trips, onOpen, onCreate, onDuplicate, onDelete }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const destinationInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [days, setDays] = useState('3');
  const [timezone, setTimezone] = useState('');
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  function openCreate() {
    setName('');
    setDestination('');
    setStartDate(today());
    setDays('3');
    setTimezone('');
    setError('');
    dialog.current?.showModal();
  }

  function createTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const submittedName = String(data.get('name') ?? '').trim();
    const submittedDestination = String(data.get('destination') ?? '').trim();
    const submittedStartDate = String(data.get('startDate') ?? '');
    const submittedDays = Number(data.get('days'));
    if (!submittedName) {
      setError('Give your trip a name to get started.');
      nameInput.current?.focus();
      return;
    }
    if (!submittedDestination) {
      setError('Add a destination for your trip.');
      destinationInput.current?.focus();
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(submittedStartDate) || Number.isNaN(new Date(`${submittedStartDate}T12:00:00`).getTime()) || !Number.isInteger(submittedDays) || submittedDays < 1 || submittedDays > 14) {
      setError('Choose a start date and a trip length from 1 to 14 days.');
      return;
    }
    const submittedTimezone=String(data.get('timezone')??'').trim();
    try{new Intl.DateTimeFormat('en',{timeZone:submittedTimezone});}catch{setError('Choose the destination time zone, such as Asia/Tokyo.');return;}
    onCreate(submittedName, submittedDestination, submittedStartDate, submittedDays, submittedTimezone);
    dialog.current?.close();
  }

  return (
    <div className="dt-dash">
      <header className="dt-dash-header">
        <div className="dt-dash-brand"><span className="dt-dash-brandmark"><Route size={22} aria-hidden="true" /></span><span>Daytrail</span></div>
        <span className="dt-dash-nav" aria-current="page">My trips</span>
        <div className="dt-dash-person" aria-label="Personal workspace">You</div>
      </header>

      <main className="dt-dash-main">
        <section className="dt-dash-welcome" aria-labelledby="dt-dash-heading">
          <div>
            <p className="dt-dash-eyebrow"><Compass size={15} aria-hidden="true" /> Find your places. Plan your days.</p>
            <h1 id="dt-dash-heading">A little planning.<br />A world to explore.</h1>
            <p className="dt-dash-intro">Your next adventure starts with a few good ideas.<br className="dt-dash-desktop-break" /> Keep them together, then make a day of it.</p>
            <button className="dt-dash-button dt-dash-primary" onClick={openCreate}><Plus size={18} aria-hidden="true" /> Plan a new trip</button>
          </div>
          <div className="dt-dash-welcome-art" aria-hidden="true">
            <div className="dt-dash-art-halo" />
            <div className="dt-dash-art-paper">
              <span className="dt-dash-art-label">Somewhere wonderful</span>
              <JourneyIllustration />
              <span className="dt-dash-art-caption"><Route size={15} /> A few stops. So many possibilities.</span>
            </div>
            <span className="dt-dash-art-stamp"><MapPin size={20} /> LET’S GO</span>
          </div>
        </section>

        <section aria-labelledby="dt-dash-trips-heading" className="dt-dash-trips">
          <div className="dt-dash-section-heading"><div><h2 id="dt-dash-trips-heading">Your trips <span>{trips.length}</span></h2><p>A home for every adventure, big or small.</p></div><span className="dt-dash-device"><Check size={14} aria-hidden="true" /> On this device</span></div>
          <div className="dt-dash-grid">
            {trips.map((trip, index) => {
              const stops = trip.days.reduce((total, day) => total + day.items.length, 0);
              return (
                <article key={trip.id} className="dt-dash-card">
                  <button className="dt-dash-card-open" onClick={() => onOpen(trip.id)} aria-label={`Open ${trip.name}`}>
                    <div className="dt-dash-card-art"><JourneyIllustration variant={index} /><span className="dt-dash-destination"><MapPin size={12} aria-hidden="true" />{trip.destination}</span></div>
                    <div className="dt-dash-card-info"><h3>{trip.name}</h3><p className="dt-dash-card-dates"><CalendarDays size={14} aria-hidden="true" />{dateRange(trip)}</p><div className="dt-dash-card-bottom"><span>{trip.days.length} {trip.days.length === 1 ? 'day' : 'days'}<span className="dt-dash-dot">·</span>{stops} {stops === 1 ? 'stop' : 'stops'}</span><span className="dt-dash-open-label">Open trip <ArrowRight size={15} aria-hidden="true" /></span></div></div>
                  </button>
                  <div className="dt-dash-card-actions">
                    {deleteId === trip.id ? (
                      <div className="dt-dash-delete-confirm" role="group" aria-label={`Confirm deleting ${trip.name}`}><span>Delete this trip?</span><button onClick={() => setDeleteId(null)}>Keep trip</button><button className="dt-dash-delete-action" onClick={() => { onDelete(trip.id); setDeleteId(null); }}>Delete</button></div>
                    ) : (
                      <><button onClick={() => onDuplicate(trip.id)} aria-label={`Duplicate ${trip.name}`}><Copy size={13} aria-hidden="true" />Duplicate</button><button className="dt-dash-delete-trigger" onClick={() => setDeleteId(trip.id)} aria-label={`Delete ${trip.name}`}><Trash2 size={13} aria-hidden="true" />Delete</button></>
                    )}
                  </div>
                </article>
              );
            })}
            <button className="dt-dash-new-card" onClick={openCreate}><span className="dt-dash-new-icon"><Plus size={24} aria-hidden="true" /></span><strong>{trips.length ? 'Where to next?' : 'Your first adventure awaits'}</strong><span>{trips.length ? 'Start a fresh page in your travel story.' : 'Pick a destination. We’ll make room for the possibilities.'}</span><span className="dt-dash-new-link">Create a trip <ArrowRight size={15} aria-hidden="true" /></span></button>
          </div>
        </section>
        <footer className="dt-dash-footer"><span className="dt-dash-footer-dot" /> This is your personal planning space. Trips are stored in this browser.</footer>
      </main>

      <dialog ref={dialog} className="dt-dash-dialog" aria-labelledby="dt-dash-create-title" aria-describedby="dt-dash-create-description" onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.current?.close(); } }}>
        <form onSubmit={createTrip} className="dt-dash-form">
          <div className="dt-dash-form-heading"><span className="dt-dash-form-icon"><Compass size={24} aria-hidden="true" /></span><button type="button" className="dt-dash-close" aria-label="Close new trip" onClick={() => dialog.current?.close()}><X size={19} aria-hidden="true" /></button></div>
          <h2 id="dt-dash-create-title">Let’s go somewhere.</h2>
          <p id="dt-dash-create-description">Start with the basics. The good stuff comes next.</p>
          <label className="dt-dash-field">Trip name<input ref={nameInput} name="name" value={name} onChange={event => setName(event.target.value)} autoFocus required maxLength={80} placeholder="e.g. Kyoto in spring" autoComplete="off" /></label>
          <label className="dt-dash-field">Destination<input ref={destinationInput} name="destination" value={destination} onChange={event => setDestination(event.target.value)} required maxLength={80} placeholder="e.g. Kyoto, Japan" autoComplete="off" /></label>
          <div className="dt-dash-form-row"><label className="dt-dash-field">Start date<input type="date" name="startDate" value={startDate} onChange={event => setStartDate(event.target.value)} onInput={event => setStartDate(event.currentTarget.value)} required /></label><label className="dt-dash-field">Number of days<input type="number" name="days" aria-label="Number of days" aria-describedby="dt-dash-days-hint" value={days} onChange={event => setDays(event.target.value)} required min="1" max="14" step="1" inputMode="numeric" /><span id="dt-dash-days-hint" className="dt-dash-field-hint">1–14 days</span></label></div>
          <label className="dt-dash-field">Destination time zone<input name="timezone" value={timezone} onChange={event=>setTimezone(event.target.value)} list="create-timezones" placeholder="e.g. Asia/Tokyo" required autoComplete="off"/><datalist id="create-timezones">{['Asia/Tokyo','Europe/London','Europe/Paris','America/New_York','America/Los_Angeles','Asia/Hong_Kong','Asia/Singapore','Australia/Sydney','UTC'].map(zone=><option key={zone} value={zone}/>)}</datalist><span className="dt-dash-field-hint">Transit times use the destination's local time.</span></label>
          {error && <p className="dt-dash-form-error" role="alert">{error}</p>}
          <p className="dt-dash-form-note"><MapPin size={15} aria-hidden="true" /> Search real places with Google Maps, then choose your hotel or starting point.</p>
          <div className="dt-dash-form-actions"><button type="button" className="dt-dash-button dt-dash-secondary" onClick={() => dialog.current?.close()}>Cancel</button><button type="submit" className="dt-dash-button dt-dash-primary">Create trip <ArrowRight size={16} aria-hidden="true" /></button></div>
        </form>
      </dialog>
    </div>
  );
}
