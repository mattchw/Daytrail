import type { Category, Journey, Mode, Place } from './model';

export const GOOGLE_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID?.trim() || 'DEMO_MAP_ID';
const browserKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim();
export const GOOGLE_MAPS_CONFIGURED = Boolean(browserKey);
const LOAD_ERROR = 'Google Maps could not load. Check your connection and try again.';
const AUTH_ERROR = 'Google Maps access was denied. Check billing, enabled APIs and website restrictions, then reload.';
let loader: Promise<typeof google.maps> | undefined;
let authError: string | null = null;

type MapsWindow = Window & {
  google?: typeof google;
  __daytrailMapsReady?: () => void;
  gm_authFailure?: () => void;
};

/** One browser loader shared by the map, place search and routes. The key is never logged. */
export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (!browserKey) return Promise.reject(new Error('Google Maps is not configured. Add the browser API key and rebuild.'));
  if (authError) return Promise.reject(new Error(authError));
  const host = window as MapsWindow;
  if (host.google?.maps?.importLibrary) return Promise.resolve(host.google.maps);
  if (loader) return loader;
  const attempt = new Promise<typeof google.maps>((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      delete host.__daytrailMapsReady;
      script.onerror = null;
      if (error) { script.remove(); reject(new Error(error)); }
      else if (host.google?.maps?.importLibrary) resolve(host.google.maps);
      else reject(new Error(LOAD_ERROR));
    };
    host.__daytrailMapsReady = () => finish();
    // Authentication can fail after the API's load callback has fired.
    host.gm_authFailure = () => {
      authError = AUTH_ERROR;
      window.dispatchEvent(new CustomEvent<{ message: string }>('daytrail-maps-error', { detail: { message: AUTH_ERROR } }));
      finish(AUTH_ERROR);
    };
    const timer = window.setTimeout(() => finish(LOAD_ERROR), 20_000);
    const parameters = new URLSearchParams({ key: browserKey, v: 'weekly', loading: 'async', language: 'en', callback: '__daytrailMapsReady' });
    script.src = `https://maps.googleapis.com/maps/api/js?${parameters}`;
    script.async = true;
    script.dataset.daytrailMaps = 'true';
    script.onerror = () => finish(LOAD_ERROR);
    document.head.append(script);
  });
  loader = attempt;
  void attempt.catch(() => { if (loader === attempt) loader = undefined; });
  return attempt;
}

/** Only fixed messages cross the service boundary: SDK errors can contain request URLs. */
export function mapsErrorMessage(error: unknown, action: 'places' | 'routes' = 'places'): string {
  if (authError) return authError;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (/PERMISSION_DENIED|REQUEST_DENIED|API_KEY|BILLING/i.test(code)) return AUTH_ERROR;
  if (/RESOURCE_EXHAUSTED|OVER_QUERY_LIMIT|QUOTA/i.test(code)) return 'Google Maps usage limit reached. Please try again later.';
  if (/ZERO_RESULTS|NOT_FOUND/i.test(code)) return action === 'places' ? 'This place could not be found on Google Maps.' : 'No route is available for this journey.';
  return action === 'places' ? 'Place search is unavailable. Check your connection and try again.' : 'Route unavailable. Check your connection and retry.';
}

interface Cached<T> { at: number; promise: Promise<T> }
const placeCache = new Map<string, Cached<Place>>();
const searchCache = new Map<string, Cached<Place[]>>();
const routeCache = new Map<string, Cached<Journey>>();
const CACHE_MS = 10 * 60_000;
const CACHE_LIMIT = 200;
function cached<T>(cache: Map<string, Cached<T>>, key: string, work: () => Promise<T>, good: (value: T) => boolean = () => true): Promise<T> {
  const now = Date.now();
  const prior = cache.get(key);
  if (prior && now - prior.at < CACHE_MS) return prior.promise;
  if (prior) cache.delete(key);
  while (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  const promise = work();
  cache.set(key, { at: now, promise });
  void promise.then(value => { if (!good(value) && cache.get(key)?.promise === promise) cache.delete(key); }, () => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

function timeout<T>(promise: Promise<T>, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

const placeFields = ['id', 'displayName', 'location', 'formattedAddress', 'googleMapsURI', 'types', 'attributions'];
const placeIdPattern = /^[A-Za-z0-9_-]{1,512}$/;
const safeURL = (value?: string | null): string | undefined => value && /^https:\/\//i.test(value) ? value : undefined;

/** Keep existing short IDs compatible while bounding long address identifiers. */
export async function googlePlaceKey(id: string): Promise<string> {
  if (!placeIdPattern.test(id)) throw new Error('This saved place has an invalid Google Maps ID.');
  if (id.length <= 93) return `google-${id}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return `gplace-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function fromGooglePlace(value: google.maps.places.Place): Promise<Place | null> {
  if (!placeIdPattern.test(value.id) || !value.location || !value.displayName) return null;
  const types = value.types ?? [];
  const food = types.some(type => /restaurant|cafe|bakery|food|bar|meal/.test(type));
  const custom = types.some(type => /lodging|hotel|hostel/.test(type));
  const cat: Category = food ? 'food' : custom ? 'custom' : 'attr';
  const lat = value.location.lat(); const lng = value.location.lng();
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    id: await googlePlaceKey(value.id), googlePlaceId: value.id,
    name: value.displayName.slice(0, 160), cat, lat, lng, x: 50, y: 50,
    area: (value.formattedAddress ?? '').slice(0, 300), typical: '1 h',
    blurb: 'A place from Google Maps. Set your own visit duration and add planning notes.',
    googleMapsURI: safeURL(value.googleMapsURI),
    attributions: (value.attributions ?? []).filter(item => item.provider).map(item => ({
      provider: item.provider!.slice(0, 300), providerURI: safeURL(item.providerURI),
    })),
  };
}

/** Keep explicit geographic queries intact; otherwise anchor the search to this trip. */
export function placeSearchQuery(query: string, destination: string): string {
  const clean = query.trim().slice(0, 240);
  const city = destination.split(',')[0].trim();
  const explicit = /\b(?:in|near|around|at)\s+\S/i.test(clean) || clean.includes(',') || (city && clean.toLocaleLowerCase().includes(city.toLocaleLowerCase()));
  return explicit || !destination.trim() ? clean : `${clean} in ${destination.trim().slice(0, 160)}`;
}

export function searchPlaces(query: string, destination: string, category?: string): Promise<Place[]> {
  if (!query.trim()) return Promise.resolve([]);
  const textQuery = placeSearchQuery(query, destination);
  const key = JSON.stringify([textQuery, category]);
  return cached(searchCache, key, async () => {
    try {
      const maps = await loadGoogleMaps();
      const { Place: GooglePlace } = await maps.importLibrary('places') as google.maps.PlacesLibrary;
      const request: google.maps.places.SearchByTextRequest = { textQuery, fields: placeFields, maxResultCount: 8, language: 'en' };
      if (category === 'food') request.includedType = 'restaurant';
      else if (category === 'attr') request.includedType = 'tourist_attraction';
      const response = await timeout(GooglePlace.searchByText(request));
      const results = (await Promise.all(response.places.map(fromGooglePlace))).filter((place): place is Place => place !== null);
      for (const place of results) {
        while (placeCache.size >= CACHE_LIMIT) placeCache.delete(placeCache.keys().next().value!);
        placeCache.set(place.googlePlaceId!, { at: Date.now(), promise: Promise.resolve(place) });
      }
      return results;
    } catch (error) { throw new Error(mapsErrorMessage(error, 'places')); }
  });
}

export function fetchPlace(id: string): Promise<Place> {
  if (!placeIdPattern.test(id)) return Promise.reject(new Error('This saved place has an invalid Google Maps ID.'));
  return cached(placeCache, id, async () => {
    try {
      const maps = await loadGoogleMaps();
      const { Place: GooglePlace } = await maps.importLibrary('places') as google.maps.PlacesLibrary;
      const result = new GooglePlace({ id });
      await timeout(result.fetchFields({ fields: placeFields }));
      const place = await fromGooglePlace(result);
      if (!place) throw { code: 'NOT_FOUND' };
      return place;
    } catch (error) { throw new Error(mapsErrorMessage(error, 'places')); }
  });
}

/** Never turn a vague meal, neighbourhood pair, experience or sample hotel into a business. */
export async function findSamplePlace(place: Place, destination: string): Promise<Place | null> {
  const namedSamples = new Set(['fushimi', 'kiyomizu', 'nishiki', 'bamboo', 'tenryuji', 'kinkakuji', 'heian', 'ginkakuji', 'nanzenji', 'philosopher', 'nijo', 'railway', 'tofukuji', 'sanjusangendo', 'yasaka', 'palace', 'ramen', 'demachi']);
  if (place.googlePlaceId) return fetchPlace(place.googlePlaceId);
  if (!namedSamples.has(place.id) || !/kyoto/i.test(destination)) return null;
  return (await searchPlaces(place.name, destination))[0] ?? null;
}

export function hasCoordinates(place: Place | undefined): place is Place & { lat: number; lng: number } {
  return Boolean(place && Number.isFinite(place.lat) && Number.isFinite(place.lng) && Math.abs(place.lat!) <= 90 && Math.abs(place.lng!) <= 180);
}

interface RoutesResult {
  routes?: { durationMillis?: number; distanceMeters?: number; path?: { lat: number | (() => number); lng: number | (() => number) }[]; warnings?: string[] }[];
}
interface RouteLibrary {
  Route: { computeRoutes(request: {
    origin: google.maps.places.Place | google.maps.LatLngLiteral;
    destination: google.maps.places.Place | google.maps.LatLngLiteral;
    travelMode: 'WALKING' | 'DRIVING' | 'TRANSIT';
    fields: string[];
    routingPreference?: 'TRAFFIC_UNAWARE';
    departureTime?: Date;
  }): Promise<RoutesResult> };
}

export function unavailableJourney(mode: Mode, reason: string): Journey {
  return { min: null, km: '—', mode, status: 'unavailable', reason };
}

export function computeJourney(from: Place, to: Place, mode: Mode, departure?: Date): Promise<Journey> {
  if (!hasCoordinates(from) || !hasCoordinates(to)) return Promise.resolve(unavailableJourney(mode, 'Choose a map location'));
  if ((from.googlePlaceId && from.googlePlaceId === to.googlePlaceId) || (from.lat === to.lat && from.lng === to.lng)) {
    return Promise.resolve({ min: 0, km: '0.0', mode, status: 'ready', path: [] });
  }
  if (mode === 'transit' && (!departure || !Number.isFinite(departure.getTime()))) return Promise.resolve(unavailableJourney(mode, 'Confirm the departure time before calculating transit'));
  const key = JSON.stringify([from.googlePlaceId, from.lat, from.lng, to.googlePlaceId, to.lat, to.lng, mode, mode === 'transit' ? departure!.toISOString() : null]);
  return cached(routeCache, key, async () => {
    try {
      const maps = await loadGoogleMaps();
      const [{ Route }, { Place: GooglePlace }] = await Promise.all([
        maps.importLibrary('routes') as unknown as Promise<RouteLibrary>,
        maps.importLibrary('places') as Promise<google.maps.PlacesLibrary>,
      ]);
      const response = await timeout(Route.computeRoutes({
        origin: from.googlePlaceId ? new GooglePlace({ id: from.googlePlaceId }) : { lat: from.lat, lng: from.lng },
        destination: to.googlePlaceId ? new GooglePlace({ id: to.googlePlaceId }) : { lat: to.lat, lng: to.lng },
        travelMode: mode === 'walk' ? 'WALKING' : mode === 'drive' ? 'DRIVING' : 'TRANSIT',
        fields: ['durationMillis', 'distanceMeters', 'path', 'warnings'],
        ...(mode === 'drive' ? { routingPreference: 'TRAFFIC_UNAWARE' as const } : {}),
        ...(mode === 'transit' ? { departureTime: departure } : {}),
      }));
      const route = response.routes?.[0];
      if (!route || !Number.isFinite(route.durationMillis) || !Number.isFinite(route.distanceMeters)) {
        return unavailableJourney(mode, 'No route is available for this journey');
      }
      const path = (route.path ?? []).map(point => ({ lat: typeof point.lat === 'function' ? point.lat() : point.lat, lng: typeof point.lng === 'function' ? point.lng() : point.lng })).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
      return { min: Math.ceil(route.durationMillis! / 60_000), km: (route.distanceMeters! / 1000).toFixed(1), mode, status: 'ready', path, warning: route.warnings?.join(' ') };
    } catch (error) { return unavailableJourney(mode, mapsErrorMessage(error, 'routes')); }
  }, journey => journey.min !== null);
}
