import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { CATEGORIES, formatDuration, formatTime } from '../model';
import type { Activity, Day, Place, schedule as computeSchedule } from '../model';
import './map.css';

type Props = {
  day: Day;
  places: Record<string, Place>;
  schedule: ReturnType<typeof computeSchedule>;
  selected: string | null;
  onSelect: (aid: string) => void;
  previewPlace: Place | null;
  onClosePreview: () => void;
  onSavePlace: (id: string) => void;
  onAddPlace: (id: string) => void;
  placeStatus: (id: string) => string;
  proposed: Activity[] | null;
  onOpenDetails?: () => void;
  destination?: string;
};

type Viewport = { x: number; y: number; zoom: number };
const FULL_VIEW: Viewport = { x: 50, y: 50, zoom: 1 };
const LABELS = [
  { x: 9, y: 30, name: 'Arashiyama' },
  { x: 29, y: 8, name: 'Kita' },
  { x: 39, y: 54, name: 'Downtown' },
  { x: 77, y: 66, name: 'Higashiyama' },
  { x: 69, y: 94, name: 'Fushimi' },
  { x: 62, y: 17, name: 'Kamo River', river: true },
];

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    fit: <><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" /><path d="M9 12h6M12 9v6" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    home: <><path d="m3.5 11 8.5-7 8.5 7M6 9.5V20h12V9.5" /><path d="M10 20v-6h4v6" /></>,
    left: <path d="m15 6-6 6 6 6" />,
    right: <path d="m9 6 6 6-6 6" />,
    bookmark: <path d="M6 4h12v17l-6-4-6 4V4Z" />,
    compass: <><circle cx="12" cy="12" r="9" /><path d="m16 8-3 5-5 3 3-5 5-3Z" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function RouteSample({ mode }: { mode: string }) {
  return <svg width="24" height="6" viewBox="0 0 24 6" aria-hidden="true"><path d="M2 3h20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={mode === 'walk' ? '.1 5' : mode === 'transit' ? '6 4' : undefined} /></svg>;
}

export default function MapPanel({ day, places, schedule, selected, onSelect, previewPlace, onClosePreview, onSavePlace, onAddPlace, placeStatus, proposed, onOpenDetails, destination = 'Kyoto' }: Props) {
  const [viewport, setViewport] = useState<Viewport>(FULL_VIEW);
  const [panning, setPanning] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const pan = useRef<{ startX: number; startY: number; original: Viewport; width: number; height: number } | null>(null);
  const hotel = places.hotel ?? { x: 50, y: 72, name: 'Hotel' };
  const selectedIndex = schedule.rows.findIndex(row => row.it.aid === selected);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const active = schedule.rows[activeIndex];
  const selectedRow = selectedIndex >= 0 ? schedule.rows[selectedIndex] : null;
  const previewStatus = previewPlace ? placeStatus(previewPlace.id) : '';
  const previewPlanned = !!previewStatus && !/idea|saved/i.test(previewStatus);
  const half = 50 / viewport.zoom;
  const viewBox = `${viewport.x - half} ${viewport.y - half} ${half * 2} ${half * 2}`;
  const isKyoto = /kyoto/i.test(destination);
  const labels = isKyoto ? LABELS : [
    { x: 29, y: 18, name: 'North district' },
    { x: 39, y: 54, name: 'City centre' },
    { x: 77, y: 66, name: 'East district' },
    { x: 62, y: 17, name: 'River', river: true },
  ];

  useEffect(() => { setViewport(FULL_VIEW); }, [day.id]);

  function project(place: { x: number; y: number }): CSSProperties {
    return { left: `${(place.x - viewport.x) * viewport.zoom + 50}%`, top: `${(place.y - viewport.y) * viewport.zoom + 50}%` };
  }
  function zoomBy(delta: number) {
    setViewport(view => ({ ...view, zoom: Math.min(3, Math.max(1, +(view.zoom + delta).toFixed(2))) }));
  }
  function fitRoute() {
    const points = [hotel, ...schedule.rows.map(row => row.pl), ...(previewPlace ? [previewPlace] : [])];
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const zoom = Math.min(2.5, Math.max(1, 64 / Math.max(maxX - minX, maxY - minY, 25)));
    setViewport({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 + 3 / zoom, zoom });
  }
  function startPan(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest('button, [role="dialog"], a')) return;
    const bounds = surface.current?.getBoundingClientRect();
    if (!bounds) return;
    pan.current = { startX: event.clientX, startY: event.clientY, original: viewport, width: bounds.width, height: bounds.height };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    if (!pan.current) return;
    const { startX, startY, original, width, height } = pan.current;
    const x = original.x - (event.clientX - startX) / width * 100 / original.zoom;
    const y = original.y - (event.clientY - startY) / height * 100 / original.zoom;
    setViewport({ ...original, x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) });
  }
  function stopPan() { pan.current = null; setPanning(false); }
  function goToStop(delta: number) {
    if (!schedule.rows.length) return;
    onSelect(schedule.rows[(activeIndex + delta + schedule.rows.length) % schedule.rows.length].it.aid);
  }
  const routePoints = [hotel, ...schedule.rows.map(row => row.pl), hotel];
  const proposedPoints = proposed ? [hotel, ...proposed.map(item => places[item.placeId]).filter(Boolean), hotel] : [];
  const activeTime = active ? `${active.approx && active.it.fixed === null ? '≈ ' : ''}${formatTime(active.start)}–${formatTime(active.end)}${active.it.fixed != null ? ' · booked' : ''}` : '';

  return <section className="dt-map" aria-label="Itinerary map">
    <div className={`dt-map-surface${panning ? ' is-panning' : ''}`} ref={surface} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={stopPan} onPointerCancel={stopPan}>
      <svg className="dt-map-geography" viewBox={viewBox} preserveAspectRatio="none" aria-hidden="true">
        <defs><pattern id="daytrail-map-grid" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M7 0H0V7" fill="none" stroke="#e1dacb" strokeWidth=".16" /></pattern></defs>
        <rect x="-100" y="-100" width="300" height="300" fill="#ece7dc" />
        <rect x="-100" y="-100" width="300" height="300" fill="url(#daytrail-map-grid)" />
        <path d="M80-20H120V120H86C82 82 88 64 82 46C78 30 84 14 80-20Z" fill="#d5e0ca" />
        <path d="M-20-20H16C12 14 20 26 14 38L0 54H-20Z" fill="#d5e0ca" />
        <rect x="47" y="21" width="9" height="10" rx="1.2" fill="#d9e4cd" />
        <path d="M60-20C58 18 58 36 57.5 52C57 70 55 86 50 120" fill="none" stroke="#b6d0d9" strokeWidth="1.65" />
        <path d="M-6 0C3 26 9 42 12 62C14 80 19 100 25 120" fill="none" stroke="#b6d0d9" strokeWidth="1.8" />
        <path d="M-10 74L110 70M-10 49L110 47" fill="none" stroke="#d5cebf" strokeWidth=".55" />
        <path d="M22-10L27 110M72-10L65 110" fill="none" stroke="#dcd4c5" strokeWidth=".45" />
        {routePoints.slice(1).map((point, index) => {
          const previous = routePoints[index];
          const mode = schedule.rows[index]?.it.mode ?? day.endMode;
          return <path key={`leg-${index}`} d={`M${previous.x} ${previous.y}L${point.x} ${point.y}`} fill="none" stroke="#0e6e68" strokeWidth={mode === 'drive' ? '.6' : '.55'} strokeDasharray={mode === 'walk' ? '.1 1.15' : mode === 'transit' ? '2.1 1.3' : undefined} strokeLinecap="round" opacity=".85" />;
        })}
        {proposedPoints.length > 1 && <polyline points={proposedPoints.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#b4541a" strokeWidth=".6" strokeDasharray="2 1.3" strokeLinecap="round" />}
      </svg>

      <div className="dt-map-labels" aria-hidden="true">{labels.map(label => <span key={label.name} className={label.river ? 'dt-map-label is-river' : 'dt-map-label'} style={project(label)}>{label.name}</span>)}</div>
      <div className="dt-map-hotel" style={project(hotel)} title="Hotel · start and end of day"><Icon name="home" size={17} /><span>Hotel</span></div>

      {previewPlace && <span className="dt-map-preview-pin" style={project(previewPlace)} aria-hidden="true"><Icon name="plus" size={16} /></span>}
      {schedule.rows.map((row, index) => <button key={row.it.aid} className={`dt-map-pin${row.it.aid === selected ? ' is-selected' : ''}${index === activeIndex ? ' is-mobile-active' : ''}`} style={{ ...project(row.pl), '--pin-color': CATEGORIES[row.pl.cat].ink } as CSSProperties} aria-label={`Stop ${index + 1}: ${row.pl.name}, ${formatTime(row.start)}`} aria-pressed={row.it.aid === selected} title={row.pl.name} onClick={() => onSelect(row.it.aid)}>{index + 1}</button>)}

      {selectedRow && !previewPlace && <div className={`dt-map-bubble${(selectedRow.pl.x - viewport.x) * viewport.zoom + 50 > 58 ? ' is-left' : ''}`} style={project(selectedRow.pl)}>
        <strong>{selectedRow.pl.name}</strong><span>{selectedRow.approx && selectedRow.it.fixed === null ? '≈ ' : ''}{formatTime(selectedRow.start)}–{formatTime(selectedRow.end)}{selectedRow.it.fixed != null ? ' · booked' : ''}</span>
      </div>}

      <div className="dt-map-title"><Icon name="compass" size={18} /><div><strong>{day.label} <span>·</span> {day.title}</strong><span>{schedule.rows.length} stops <i>·</i> {formatDuration(schedule.travel)} {schedule.unknown ? 'known travel · some estimates unavailable' : 'travel'}</span></div></div>

      <div className="dt-map-controls" aria-label="Map controls">
        <button onClick={fitRoute} title="Fit all stops" aria-label="Fit all stops"><Icon name="fit" /></button>
        <span />
        <button onClick={() => zoomBy(.25)} disabled={viewport.zoom >= 3} title="Zoom in" aria-label="Zoom in"><Icon name="plus" /></button>
        <button onClick={() => zoomBy(-.25)} disabled={viewport.zoom <= 1} title="Zoom out" aria-label="Zoom out"><Icon name="minus" /></button>
        <button className="dt-map-reset" onClick={() => setViewport(FULL_VIEW)} title="Reset map view" aria-label="Reset map view">N<span>↑</span></button>
      </div>

      {previewPlace && <div className="dt-map-place-preview" role="dialog" aria-label={previewPlace.name} onKeyDown={event => { if (event.key === 'Escape') onClosePreview(); }}>
        <div className="dt-map-preview-heading"><span className="dt-map-category" style={{ color: CATEGORIES[previewPlace.cat].ink, background: CATEGORIES[previewPlace.cat].tint }}>{CATEGORIES[previewPlace.cat].label}</span><button className="dt-map-close" onClick={onClosePreview} aria-label="Close place details"><Icon name="close" size={17} /></button></div>
        <h3>{previewPlace.name}</h3>
        <p className="dt-map-preview-meta">{previewPlace.area} <span>·</span> <Icon name="clock" size={12} /> {previewPlace.typical}</p>
        <p className="dt-map-preview-description">{previewPlace.blurb}</p>
        <div className="dt-map-preview-actions">
          {!previewStatus && <button className="dt-map-secondary" onClick={() => onSavePlace(previewPlace.id)}><Icon name="bookmark" size={15} />Save to Ideas</button>}
          {!previewPlanned && <button className="dt-map-primary" onClick={() => onAddPlace(previewPlace.id)}><Icon name="plus" size={15} />Add to {day.label}</button>}
          {previewStatus && <span className="dt-map-place-status">{previewStatus}</span>}
        </div>
        <small>Sample place details for this prototype</small>
      </div>}

      <div className="dt-map-bottom">
        <div className="dt-map-legend" aria-label="Route legend"><span><RouteSample mode="walk" />Walk</span><span><RouteSample mode="transit" />Transit</span><span><RouteSample mode="drive" />Drive</span>{proposed && <span className="dt-map-proposed"><RouteSample mode="transit" />Suggested</span>}</div>
        <span className="dt-map-disclaimer">{isKyoto ? 'Illustrative map' : 'Sample map layout'} · sample travel times</span>
      </div>

      <div className="dt-map-mobile-stop">
        {active ? <><div className="dt-map-mobile-stop-main"><span className="dt-map-stop-number">{activeIndex + 1}</span><div><strong>{active.pl.name}</strong><span>{activeTime}</span></div></div><div className="dt-map-stop-actions"><button className="dt-map-secondary" onClick={() => goToStop(-1)} aria-label="Previous stop"><Icon name="left" /></button><button className="dt-map-secondary" onClick={() => goToStop(1)} aria-label="Next stop"><Icon name="right" /></button><button className="dt-map-primary" onClick={() => { onSelect(active.it.aid); onOpenDetails?.(); }}>Details<Icon name="right" size={14} /></button></div></> : <p>No stops yet. Add a place to start your route.</p>}
      </div>
    </div>
  </section>;
}
