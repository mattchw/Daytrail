import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CATEGORIES, formatDuration, formatTime } from '../model';
import type { Activity, Day, Place, schedule as computeSchedule } from '../model';
import { GOOGLE_MAP_ID, loadGoogleMaps } from '../googleMaps';
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
  onChooseBase?: () => void;
  onLocatePlace?: (id: string) => void;
  loadingRoutes?: boolean;
  discoveryActive?: boolean;
  discoveryPlaces?: Place[];
  discoverySelectedId?: string | null;
  discoveryResultsKey?: string;
  discoveryScope?: 'destination' | 'area';
  onSelectDiscovery?: (id: string) => void;
  onSearchArea?: (bounds: MapArea) => void;
  searchingArea?: boolean;
  onBackToDiscovery?: () => void;
  resetCameraKey?: string;
};

type Coordinate = { lat: number; lng: number };
type MapArea = { north: number; south: number; east: number; west: number };
function longitudeSpan(area: MapArea) { return (area.east - area.west + 360) % 360 || 360; }
function areaChanged(area: MapArea, baseline: MapArea | null) {
  if (!baseline) return true;
  const height = Math.max(.00001, baseline.north - baseline.south);
  const width = longitudeSpan(baseline);
  const nextWidth = longitudeSpan(area);
  const centreShift = Math.abs(((area.west + nextWidth / 2 - baseline.west - width / 2 + 540) % 360) - 180);
  return Math.abs(area.north + area.south - baseline.north - baseline.south) / 2 > height * .12
    || centreShift > width * .12
    || Math.abs(area.north - area.south - height) > height * .15
    || Math.abs(nextWidth - width) > width * .15;
}
function identity(place: Place) { return place.googlePlaceId || place.id; }
function coordinate(place?: Place | null): Coordinate | null {
  return place && typeof place.lat === 'number' && typeof place.lng === 'number'
    && Number.isFinite(place.lat) && Number.isFinite(place.lng)
    && Math.abs(place.lat) <= 90 && Math.abs(place.lng) <= 180
    ? { lat: place.lat, lng: place.lng } : null;
}
function safeLink(url?: string) {
  try { const parsed = new URL(url ?? ''); return parsed.protocol === 'https:' ? parsed.href : undefined; }
  catch { return undefined; }
}
function PlaceCredits({ place }: { place: Place }) {
  const mapsLink = safeLink(place.googleMapsURI);
  return <div className="dt-map-place-credits">
    {mapsLink && <a href={mapsLink} target="_blank" rel="noreferrer">View on Google Maps ↗</a>}
    {place.attributions?.map((credit, index) => {
      const href = safeLink(credit.providerURI);
      return <span key={`${credit.provider}-${index}`}>{href ? <a href={href} target="_blank" rel="noreferrer">{credit.provider}</a> : credit.provider}</span>;
    })}
  </div>;
}
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

export default function MapPanel({ day, places, schedule, selected, onSelect, previewPlace, onClosePreview, onSavePlace, onAddPlace, placeStatus, onOpenDetails, destination = 'your destination', onChooseBase, onLocatePlace, loadingRoutes = false, discoveryActive = false, discoveryPlaces = [], discoverySelectedId = null, discoveryResultsKey = '', discoveryScope = 'destination', onSelectDiscovery, onSearchArea, searchingArea = false, onBackToDiscovery, resetCameraKey }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const maps = useRef<typeof google.maps | null>(null);
  const markerLibrary = useRef<google.maps.MarkerLibrary | null>(null);
  const markers = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const lines = useRef<google.maps.Polyline[]>([]);
  const latest = useRef({ onSelect, onChooseBase, onSelectDiscovery, discoveryActive });
  latest.current = { onSelect, onChooseBase, onSelectDiscovery, discoveryActive };
  const cameraIntent = useRef<'itinerary' | 'discovery' | 'manual'>('itinerary');
  const pendingUserMovement = useRef(false);
  const baselineArea = useRef<MapArea | null>(null);
  const resetBaselineOnIdle = useRef(false);
  const pendingFit = useRef<Coordinate[] | null>(null);
  const lastResultsCamera = useRef('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(2);
  const [areaDirty, setAreaDirty] = useState(false);
  const [areaTooWide, setAreaTooWide] = useState(false);
  const hotel = places.hotel;
  const selectedIndex = schedule.rows.findIndex(row => row.it.aid === selected);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const active = schedule.rows[activeIndex];
  const selectedRow = selectedIndex >= 0 ? schedule.rows[selectedIndex] : null;
  const previewStatus = previewPlace ? placeStatus(previewPlace.id) : '';
  const previewPlanned = !!previewStatus && !/idea|saved/i.test(previewStatus);
  const genericGooglePreview = !!previewPlace?.googlePlaceId && previewPlace.blurb === 'A place from Google Maps. Set your own visit duration and add planning notes.';
  const previewTypical = genericGooglePreview && previewPlace?.typical === '1 h' ? '' : previewPlace?.typical;
  const missingPlaces = schedule.rows.filter(row => !coordinate(row.pl));
  const pointKey = [hotel, ...schedule.rows.map(row => row.pl)].filter(Boolean).map(place => `${place!.id}:${place!.lat ?? ''}:${place!.lng ?? ''}`).join('|');
  const journeyLegs = [...schedule.rows.map(row => row.leg), schedule.endLeg];
  const chooseBaseEnabled = !!onChooseBase;
  const standalonePreview = previewPlace
    && ![hotel, ...schedule.rows.map(row => row.pl), ...(discoveryActive ? discoveryPlaces : [])].some(place => place && identity(place) === identity(previewPlace))
    ? previewPlace : null;
  const markerData = (place: Place | null) => place ? [place.id, place.googlePlaceId, place.name, place.cat, place.lat, place.lng] : null;
  const markerKey = JSON.stringify([markerData(hotel), schedule.rows.map(row => [row.it.aid, markerData(row.pl), row.start]), markerData(standalonePreview), discoveryActive, discoveryPlaces.map(markerData)]);
  const routeKey = journeyLegs.map(leg => `${leg.mode}:${leg.status}:${leg.path?.map(point => `${point.lat},${point.lng}`).join(';') ?? ''}`).join('|');
  const points = useRef<Coordinate[]>([]);
  points.current = [hotel, ...schedule.rows.map(row => row.pl)].flatMap(place => {
    const point = coordinate(place); return point ? [point] : [];
  }).concat(journeyLegs.flatMap(leg => leg.status === 'ready' && leg.path ? leg.path : []));
  const warnings = [...new Set(journeyLegs.map(leg => leg.warning).filter((warning): warning is string => !!warning))];
  const sourceCredits = [...new Map([hotel, ...schedule.rows.map(row => row.pl), previewPlace, ...(discoveryActive ? discoveryPlaces : [])].flatMap(place => place?.attributions ?? []).map(credit => [`${credit.provider}:${credit.providerURI ?? ''}`, credit])).values()];
  const activeTime = active ? `${active.approx && active.it.fixed === null ? '≈ ' : ''}${formatTime(active.start)}–${formatTime(active.end)}${active.it.fixed != null ? ' · booked' : ''}` : '';
  const cameraKey = resetCameraKey ?? day.id;

  function currentArea(): MapArea | null { return map.current?.getBounds()?.toJSON() ?? null; }
  function beginProgrammaticCamera(resetBaseline = false) {
    pendingUserMovement.current = false;
    resetBaselineOnIdle.current = resetBaseline;
    if (resetBaseline) setAreaDirty(false);
  }
  function noteUserMovement() {
    if (!baselineArea.current) baselineArea.current = currentArea();
    cameraIntent.current = 'manual';
    pendingUserMovement.current = true;
    resetBaselineOnIdle.current = false;
    pendingFit.current = null;
  }
  function fitPoints(fit: Coordinate[]) {
    const instance = map.current, api = maps.current;
    if (!instance || !api || !fit.length) return;
    if (!surface.current?.clientWidth) { pendingFit.current = fit; return; }
    pendingFit.current = null;
    beginProgrammaticCamera(true);
    const bounds = new api.LatLngBounds();
    fit.forEach(point => bounds.extend(point));
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      instance.setCenter(fit[0]); instance.setZoom(15);
    } else {
      instance.fitBounds(bounds, { top: 55, right: 65, bottom: 45, left: 35 });
    }
  }
  function fitRoute() {
    cameraIntent.current = 'itinerary';
    fitPoints(points.current);
  }
  function revealPoint(point: Coordinate) {
    const instance = map.current;
    if (!instance || instance.getBounds()?.contains(point)) return;
    beginProgrammaticCamera();
    instance.panTo(point);
  }
  function searchCurrentArea() {
    const area = currentArea();
    if (!area || area.north - area.south > 2 || longitudeSpan(area) > 2 || searchingArea) return;
    baselineArea.current = area;
    pendingUserMovement.current = false;
    cameraIntent.current = 'manual';
    setAreaDirty(false);
    onSearchArea?.(area);
  }

  useEffect(() => {
    let disposed = false;
    let authFailed = false;
    let resize: ResizeObserver | undefined;
    const listeners: google.maps.MapsEventListener[] = [];
    const element = surface.current;
    const wheel = () => noteUserMovement();
    const touchPointers = new Set<number>();
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      touchPointers.add(event.pointerId);
      if (touchPointers.size > 1) noteUserMovement();
    };
    const pointerUp = (event: PointerEvent) => { touchPointers.delete(event.pointerId); };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-', '='].includes(event.key)) noteUserMovement();
    };
    setReady(false); setError('');
    function authError(event: Event) {
      authFailed = true;
      const detail = (event as CustomEvent<string | { message: string }>).detail;
      setError(typeof detail === 'string' ? detail : detail?.message || 'Google Maps could not authorise this website. Check the API key and billing settings, then reload.');
      setReady(false);
    }
    window.addEventListener('daytrail-maps-error', authError);
    void loadGoogleMaps().then(async api => {
      const [mapLibrary, markerApi] = await Promise.all([
        api.importLibrary('maps') as Promise<google.maps.MapsLibrary>,
        api.importLibrary('marker') as Promise<google.maps.MarkerLibrary>,
      ]);
      if (disposed || authFailed || !surface.current) return;
      maps.current = api;
      markerLibrary.current = markerApi;
      const instance = new mapLibrary.Map(surface.current, {
        mapId: GOOGLE_MAP_ID,
        center: points.current[0] ?? { lat: 20, lng: 0 },
        zoom: points.current.length ? 12 : 2,
        minZoom: 2, maxZoom: 21,
        disableDefaultUI: true,
        clickableIcons: false,
        gestureHandling: 'greedy',
        keyboardShortcuts: true,
        tilt: 0,
      });
      map.current = instance;
      listeners.push(instance.addListener('zoom_changed', () => setZoom(instance.getZoom() ?? 2)));
      listeners.push(instance.addListener('dragstart', noteUserMovement));
      listeners.push(instance.addListener('idle', () => {
        const area = currentArea();
        if (!area) return;
        setAreaTooWide(area.north - area.south > 2 || longitudeSpan(area) > 2);
        if (resetBaselineOnIdle.current || !baselineArea.current) {
          baselineArea.current = area;
          resetBaselineOnIdle.current = false;
        } else if (pendingUserMovement.current) setAreaDirty(areaChanged(area, baselineArea.current));
        pendingUserMovement.current = false;
      }));
      element?.addEventListener('wheel', wheel, { passive: true, capture: true });
      element?.addEventListener('dblclick', wheel, true);
      element?.addEventListener('keydown', key, true);
      element?.addEventListener('pointerdown', pointerDown, true);
      element?.addEventListener('pointerup', pointerUp, true);
      element?.addEventListener('pointercancel', pointerUp, true);
      resize = new ResizeObserver(() => {
        if (!surface.current?.clientWidth || !surface.current.clientHeight) return;
        api.event.trigger(instance, 'resize');
        if (pendingFit.current) fitPoints(pendingFit.current);
      });
      resize.observe(surface.current);
      setReady(true);
    }).catch(() => {
      if (!disposed && !authFailed) { setError('Google Maps could not load. Check your connection and the map configuration, then try again.'); setReady(false); }
    });
    return () => {
      disposed = true;
      resize?.disconnect(); listeners.forEach(listener => listener.remove());
      element?.removeEventListener('wheel', wheel, true);
      element?.removeEventListener('dblclick', wheel, true);
      element?.removeEventListener('keydown', key, true);
      element?.removeEventListener('pointerdown', pointerDown, true);
      element?.removeEventListener('pointerup', pointerUp, true);
      element?.removeEventListener('pointercancel', pointerUp, true);
      window.removeEventListener('daytrail-maps-error', authError);
      markers.current.forEach(marker => { marker.map = null; }); markers.current = [];
      lines.current.forEach(line => line.setMap(null)); lines.current = [];
      map.current = null;
    };
  }, [attempt]);

  useEffect(() => {
    if (!ready || !map.current || !markerLibrary.current) return;
    markers.current.forEach(marker => { marker.map = null; });
    markers.current = [];
    const { AdvancedMarkerElement } = markerLibrary.current;
    const resultsByIdentity = new Map((discoveryActive ? discoveryPlaces : []).map(place => [identity(place), place]));
    const plannedIdentities = new Set([hotel, ...schedule.rows.map(row => row.pl)].filter(Boolean).map(identity));
    function addMarker(place: Place, content: HTMLElement, title: string, zIndex: number, activityId?: string, discoveryId?: string) {
      const position = coordinate(place);
      if (!position || !map.current) return;
      const marker = new AdvancedMarkerElement({ map: map.current, position, title, zIndex });
      marker.append(content);
      if (activityId) marker.dataset.activityId = activityId;
      if (discoveryId) marker.dataset.discoveryId = discoveryId;
      markers.current.push(marker);
    }
    if (coordinate(hotel)) {
      const result = resultsByIdentity.get(identity(hotel));
      const content = document.createElement(onChooseBase || result ? 'button' : 'div');
      content.className = 'dt-map-hotel';
      content.textContent = '⌂';
      content.setAttribute('aria-label', `${hotel.name} · start and end of day${onChooseBase ? '. Change hotel' : ''}`);
      content.title = `${hotel.name} · start and end of day`;
      if (onChooseBase || result) content.addEventListener('click', () => {
        if (result && latest.current.discoveryActive) latest.current.onSelectDiscovery?.(result.id);
        else latest.current.onChooseBase?.();
      });
      addMarker(hotel, content, hotel.name, 5, undefined, result?.id);
    }
    schedule.rows.forEach((row, index) => {
      const result = resultsByIdentity.get(identity(row.pl));
      const content = document.createElement('button');
      content.type = 'button';
      content.className = `dt-map-pin${row.it.aid === selected ? ' is-selected' : ''}`;
      content.style.setProperty('--pin-color', CATEGORIES[row.pl.cat].ink);
      content.textContent = String(index + 1);
      content.setAttribute('aria-label', `Stop ${index + 1}: ${row.pl.name}, ${formatTime(row.start)}`);
      content.setAttribute('aria-pressed', String(row.it.aid === selected));
      content.addEventListener('click', () => {
        if (result && latest.current.discoveryActive) latest.current.onSelectDiscovery?.(result.id);
        else latest.current.onSelect(row.it.aid);
      });
      addMarker(row.pl, content, row.pl.name, row.it.aid === selected ? 20 : 10, row.it.aid, result?.id);
    });
    resultsByIdentity.forEach(place => {
      if (plannedIdentities.has(identity(place))) return;
      const content = document.createElement('button');
      content.type = 'button';
      content.className = 'dt-map-discovery-pin';
      content.style.setProperty('--pin-color', CATEGORIES[place.cat].ink);
      content.textContent = '●';
      content.setAttribute('aria-label', `Discover ${place.name}`);
      content.setAttribute('aria-pressed', String(place.id === discoverySelectedId));
      content.addEventListener('click', () => latest.current.onSelectDiscovery?.(place.id));
      addMarker(place, content, place.name, 15, undefined, place.id);
    });
    if (standalonePreview) {
      const content = document.createElement('div');
      content.className = 'dt-map-preview-pin'; content.textContent = '+';
      content.setAttribute('aria-label', standalonePreview.name);
      addMarker(standalonePreview, content, standalonePreview.name, 30);
    }
    return () => { markers.current.forEach(marker => { marker.map = null; }); markers.current = []; };
  }, [ready, markerKey, chooseBaseEnabled]);

  // Keep the focused marker in the DOM when selection changes via keyboard.
  useEffect(() => {
    markers.current.forEach(marker => {
      const button = marker.querySelector('button');
      const isSelected = !!marker.dataset.activityId && marker.dataset.activityId === selected;
      const isDiscoverySelected = !!marker.dataset.discoveryId && marker.dataset.discoveryId === discoverySelectedId;
      if (marker.dataset.activityId) button?.classList.toggle('is-selected', isSelected);
      button?.classList.toggle('is-discovery-selected', isDiscoverySelected);
      button?.setAttribute('aria-pressed', String(isSelected || isDiscoverySelected));
      marker.zIndex = isDiscoverySelected ? 35 : isSelected ? 20 : marker.dataset.discoveryId ? 15 : marker.dataset.activityId ? 10 : 5;
    });
  }, [ready, markerKey, selected, discoverySelectedId]);

  useEffect(() => {
    if (!ready || !map.current || !maps.current) return;
    const api = maps.current;
    lines.current.forEach(line => line.setMap(null));
    lines.current = [];
    journeyLegs.forEach(leg => {
      if (leg.status !== 'ready' || !leg.path || leg.path.length < 2) return;
      const color = leg.mode === 'transit' ? '#466d94' : '#0e6e68';
      const line = new api.Polyline({
        map: map.current, path: leg.path, clickable: false, geodesic: false,
        strokeColor: color, strokeOpacity: leg.mode === 'drive' ? .9 : 0,
        strokeWeight: 5, zIndex: 1,
        icons: leg.mode === 'drive' ? undefined : [{
          icon: leg.mode === 'walk'
            ? { path: api.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeOpacity: 0, scale: 2.5 }
            : { path: 'M 0,-1 0,1', strokeColor: color, strokeOpacity: 1, strokeWeight: 4, scale: 3 },
          offset: '0', repeat: leg.mode === 'walk' ? '11px' : '18px',
        }],
      });
      lines.current.push(line);
    });
    return () => { lines.current.forEach(line => line.setMap(null)); lines.current = []; };
  }, [ready, routeKey]);

  useEffect(() => {
    cameraIntent.current = 'itinerary';
    baselineArea.current = null;
    pendingUserMovement.current = false;
    setAreaDirty(false);
    if (ready) fitPoints(points.current);
  }, [cameraKey]);
  // Route responses and place hydration can fill the initial view, but never move
  // the camera once someone is exploring a search or has moved the map.
  useEffect(() => {
    if (ready && cameraIntent.current === 'itinerary') fitPoints(points.current);
  }, [ready, pointKey]);
  useEffect(() => {
    if (!ready || !discoveryActive || !discoveryResultsKey || lastResultsCamera.current === discoveryResultsKey) return;
    lastResultsCamera.current = discoveryResultsKey;
    if (discoveryScope === 'area') return;
    const discoveredPoints = discoveryPlaces.flatMap(place => { const point = coordinate(place); return point ? [point] : []; });
    if (!discoveredPoints.length) return;
    cameraIntent.current = 'discovery';
    fitPoints(discoveredPoints);
  }, [ready, discoveryActive, discoveryResultsKey, discoveryScope]);
  const previousSelection = useRef({ cameraKey, selected });
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { cameraKey, selected };
    if (!ready || previous.cameraKey !== cameraKey || previous.selected === selected) return;
    const point = coordinate(selectedRow?.pl);
    if (point) revealPoint(point);
  }, [ready, selected, cameraKey, selectedRow?.pl.lat, selectedRow?.pl.lng]);
  useEffect(() => {
    const point = coordinate(previewPlace);
    if (ready && point && map.current) {
      revealPoint(point);
    }
  }, [ready, previewPlace?.id, previewPlace?.lat, previewPlace?.lng]);
  useEffect(() => {
    const point = coordinate(discoveryPlaces.find(place => place.id === discoverySelectedId));
    if (ready && discoveryActive && point) revealPoint(point);
  }, [ready, discoveryActive, discoverySelectedId]);

  function zoomBy(delta: number) {
    if (map.current) { noteUserMovement(); map.current.setZoom(Math.max(2, Math.min(21, (map.current.getZoom() ?? 12) + delta))); }
  }
  function goToStop(delta: number) {
    if (schedule.rows.length) onSelect(schedule.rows[(activeIndex + delta + schedule.rows.length) % schedule.rows.length].it.aid);
  }
  const pendingPlace = selectedRow && !coordinate(selectedRow.pl) ? selectedRow.pl : missingPlaces[0]?.pl;

  return <section className={`dt-map${discoveryActive ? ' is-discovering' : ''}`} aria-label="Itinerary map">
    <div className="dt-map-surface">
      <div className="dt-map-heading"><Icon name="compass" size={18} /><div><strong>{day.label} <span>·</span> {day.title}</strong><span>{schedule.rows.length} stops <i>·</i> {loadingRoutes ? 'Updating journeys…' : `${formatDuration(schedule.travel)} ${schedule.unknown ? 'known travel' : 'travel'}`}</span></div><span className="dt-map-live-label">Google Maps</span></div>
      <div className="dt-map-viewport">
        <div className="dt-map-google" ref={surface} aria-label={`Map of your itinerary in ${destination}`} />
        {!ready && <div className="dt-map-loading" role={error ? 'alert' : 'status'}>
          <Icon name="compass" size={28} /><strong>{error ? 'Map unavailable' : 'Opening your map…'}</strong>
          <p>{error || 'Loading Google Maps and your saved places.'}</p>
          {error && <button className="dt-map-primary" onClick={() => setAttempt(value => value + 1)}>Try again</button>}
        </div>}
        {ready && <>
          <div className="dt-map-controls" aria-label="Map controls">
            <button onClick={fitRoute} disabled={!points.current.length} title="Fit all stops" aria-label="Fit all stops"><Icon name="fit" /></button><span />
            <button onClick={() => zoomBy(1)} disabled={zoom >= 21} title="Zoom in" aria-label="Zoom in"><Icon name="plus" /></button>
            <button onClick={() => zoomBy(-1)} disabled={zoom <= 2} title="Zoom out" aria-label="Zoom out"><Icon name="minus" /></button>
            <button className="dt-map-reset" onClick={() => { map.current?.setHeading(0); map.current?.setTilt(0); fitRoute(); }} title="Reset map view" aria-label="Reset map view">N<span>↑</span></button>
          </div>
          {discoveryActive && onSearchArea && <div className="dt-map-search-area" aria-label="Map area search">
            {areaDirty || searchingArea ? <><button className="dt-map-primary" onClick={searchCurrentArea} disabled={searchingArea || areaTooWide}>{searchingArea ? 'Searching this area…' : 'Search this area'}</button>{areaTooWide && <span role="status">Zoom in to search a neighbourhood or city.</span>}</> : <span className="dt-map-search-hint">Move the map to explore another area</span>}
          </div>}
          {!discoveryActive && !previewPlace && (!coordinate(hotel) || pendingPlace) && <div className="dt-map-location-help">
            {!coordinate(hotel) ? <><Icon name="home" size={17} /><div><strong>Where are you staying?</strong><span>Set your base to complete each day’s route.</span></div>{onChooseBase && <button onClick={onChooseBase}>Choose hotel</button>}</> : pendingPlace ? <><Icon name="compass" size={17} /><div><strong>{pendingPlace.name}</strong><span>{missingPlaces.length} {missingPlaces.length === 1 ? 'stop needs a location' : 'stops need locations'}.</span></div>{onLocatePlace && <button onClick={() => onLocatePlace(pendingPlace.id)}>Locate stop</button>}</> : null}
          </div>}
          {selectedRow && coordinate(selectedRow.pl) && !previewPlace && !discoveryActive && <div className="dt-map-selected"><span className="dt-map-stop-number">{selectedIndex + 1}</span><div><strong>{selectedRow.pl.name}</strong><span>{activeTime}</span><PlaceCredits place={selectedRow.pl} /></div></div>}
        </>}
      </div>
      <div className="dt-map-bottom">
        <div className="dt-map-legend" aria-label="Route legend"><span><RouteSample mode="walk" />Walk</span><span><RouteSample mode="transit" />Transit</span><span><RouteSample mode="drive" />Drive</span>{discoveryActive && !!discoveryPlaces.length && <span><i className="dt-map-discovery-key" />Places</span>}</div>
        <span className="dt-map-disclaimer" role="status">{loadingRoutes ? 'Updating routes…' : schedule.unknown ? 'Some journeys are unavailable' : schedule.rows.length ? 'Routes follow your itinerary' : 'Add places to plan your route'}</span>
      </div>
      {!!sourceCredits.length && <div className="dt-map-provider-credits">{sourceCredits.map((credit, index) => <span key={`${credit.provider}-${index}`}>{safeLink(credit.providerURI) ? <a href={safeLink(credit.providerURI)} target="_blank" rel="noreferrer">{credit.provider}</a> : credit.provider}</span>)}</div>}
      {!!warnings.length && <div className="dt-map-route-warnings">{warnings.map(warning => <p key={warning}>{warning}</p>)}</div>}
      {previewPlace && <div className="dt-map-place-preview" role="dialog" aria-label={previewPlace.name} onKeyDown={event => { if (event.key === 'Escape') onClosePreview(); }}>
        <div className="dt-map-preview-heading">{discoveryActive && onBackToDiscovery && <button className="dt-map-back-results" onClick={onBackToDiscovery}><Icon name="left" size={15} />Back to results</button>}<span className="dt-map-category" style={{ color: CATEGORIES[previewPlace.cat].ink, background: CATEGORIES[previewPlace.cat].tint }}>{CATEGORIES[previewPlace.cat].label}</span><button className="dt-map-close" onClick={onClosePreview} aria-label="Close place details"><Icon name="close" size={17} /></button></div>
        <h3>{previewPlace.name}</h3><p className="dt-map-preview-meta">{previewPlace.area} {previewTypical && <><span>·</span><Icon name="clock" size={12} />{previewTypical}</>}</p>
        {previewPlace.blurb && !genericGooglePreview && <p className="dt-map-preview-description">{previewPlace.blurb}</p>}
        {!coordinate(previewPlace) && <p className="dt-map-unlocated">This place needs a location before it can appear on the map.</p>}
        <div className="dt-map-preview-actions">
          {!previewStatus && <button className="dt-map-secondary" onClick={() => onSavePlace(previewPlace.id)}><Icon name="bookmark" size={15} />Save to Ideas</button>}
          {!previewPlanned && <button className="dt-map-primary" onClick={() => onAddPlace(previewPlace.id)}><Icon name="plus" size={15} />Add to {day.label}</button>}
          {!coordinate(previewPlace) && onLocatePlace && <button className="dt-map-secondary" onClick={() => onLocatePlace(previewPlace.id)}>Locate place</button>}
          {previewStatus && <span className="dt-map-place-status">{previewStatus}</span>}
        </div><PlaceCredits place={previewPlace} />
      </div>}
      {!previewPlace && discoveryActive && onBackToDiscovery && <div className="dt-map-mobile-results"><div><strong>{discoveryPlaces.length ? `${discoveryPlaces.length} places to explore` : 'Discover your next stop'}</strong><span>Tap a place pin to see its details.</span></div><button className="dt-map-primary" onClick={onBackToDiscovery}>Back to results<Icon name="right" size={14} /></button></div>}
      {!previewPlace && !discoveryActive && <div className="dt-map-mobile-stop">
        {active ? <><div className="dt-map-mobile-stop-main"><span className="dt-map-stop-number">{activeIndex + 1}</span><div><strong>{active.pl.name}</strong><span>{activeTime}</span><PlaceCredits place={active.pl} /></div></div><div className="dt-map-stop-actions"><button className="dt-map-secondary" onClick={() => goToStop(-1)} aria-label="Previous stop"><Icon name="left" /></button><button className="dt-map-secondary" onClick={() => goToStop(1)} aria-label="Next stop"><Icon name="right" /></button><button className="dt-map-primary" onClick={() => { onSelect(active.it.aid); onOpenDetails?.(); }}>Details<Icon name="right" size={14} /></button></div></> : <p>No stops yet. Add a place to start your route.</p>}
      </div>}
    </div>
  </section>;
}
