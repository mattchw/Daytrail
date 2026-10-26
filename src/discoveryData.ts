import type { Place } from './model';
import { fromGooglePlace, loadGoogleMaps, mapsErrorMessage, placeSearchQuery } from './googleMaps';
import type { OpeningPoint, OpeningSchedule } from './openingHours';
export { getOpeningSummary } from './openingHours';
export type { OpeningSchedule, OpeningSummary } from './openingHours';

export interface SearchBounds { north: number; south: number; east: number; west: number }
export type DiscoveryCategory = 'all' | 'attractions' | 'temples' | 'museums' | 'restaurants' | 'cafes';
export interface DiscoveryPhoto { key: string; width: number; height: number; authors: { name: string; uri?: string }[] }
export interface DiscoveryInfo {
  rating?: number;
  ratingCount?: number;
  primaryType?: string;
  businessStatus?: string;
  utcOffsetMinutes?: number;
  fetchedAt: number;
  photos: DiscoveryPhoto[];
  currentHours?: OpeningSchedule;
  regularHours?: OpeningSchedule;
}
export interface DiscoveryResult { place: Place; info: DiscoveryInfo }
const CACHE_MS = 5 * 60_000;
const CACHE_LIMIT = 100;
interface CacheEntry<T> { at: number; promise: Promise<T> }
const searchCache = new Map<string, CacheEntry<DiscoveryResult[]>>();
// Detail responses never reuse the intentionally smaller card response.
const detailCache = new Map<string, CacheEntry<DiscoveryResult>>();
const photoHandles = new Map<string, { at: number; photo: google.maps.places.Photo; urls: Map<number, string> }>();
let photoSequence = 0;
const baseFields = ['id', 'displayName', 'location', 'formattedAddress', 'googleMapsURI', 'types', 'attributions'];
const cardFields = [...baseFields, 'primaryType', 'primaryTypeDisplayName', 'businessStatus', 'rating', 'userRatingCount', 'photos', 'currentOpeningHours', 'utcOffsetMinutes'];
const detailFields = [...cardFields, 'regularOpeningHours'];
const categoryText: Record<DiscoveryCategory, string> = { all: 'tourist attractions', attractions: 'tourist attractions', temples: 'temples', museums: 'museums', restaurants: 'restaurants', cafes: 'cafes' };
const categoryType: Partial<Record<DiscoveryCategory, string>> = { attractions: 'tourist_attraction', museums: 'museum', restaurants: 'restaurant', cafes: 'cafe' };
const safeURL = (value?: string | null): string | undefined => value && /^https:\/\//i.test(value) ? value : undefined;

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string, work: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const previous = cache.get(key);
  if (previous && now - previous.at < CACHE_MS) return previous.promise;
  cache.delete(key);
  while (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  const promise = work();
  cache.set(key, { at: now, promise });
  void promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  return promise;
}
async function timeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 20_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function validSearchBounds(bounds: SearchBounds): boolean {
  return Object.values(bounds).every(Number.isFinite) && bounds.north <= 90 && bounds.south >= -90 &&
    bounds.north > bounds.south && bounds.west >= -180 && bounds.west <= 180 && bounds.east >= -180 && bounds.east <= 180 && bounds.east !== bounds.west;
}
/** A wrapped longitude range also works when the map crosses the date line. */
export function withinSearchBounds(place: Pick<Place, 'lat' | 'lng'>, bounds: SearchBounds): boolean {
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return false;
  return place.lat! <= bounds.north && place.lat! >= bounds.south &&
    (bounds.west < bounds.east ? place.lng! >= bounds.west && place.lng! <= bounds.east : place.lng! >= bounds.west || place.lng! <= bounds.east);
}
/** Place names remain anchored to the trip only for destination searches. */
export function discoverySearchRequest(query: string, destination: string, category: DiscoveryCategory, bounds?: SearchBounds): google.maps.places.SearchByTextRequest {
  if (bounds && !validSearchBounds(bounds)) throw new Error('Move or zoom the map to choose a valid search area.');
  let clean = query.trim().slice(0, 240) || categoryText[category];
  if (category === 'temples' && !/temple|shrine|寺|神社/i.test(clean)) clean = `${clean} temples`;
  const request: google.maps.places.SearchByTextRequest = {
    textQuery: bounds ? clean : placeSearchQuery(clean, destination), fields: [...cardFields], maxResultCount: 8, language: 'en',
    ...(bounds ? { locationRestriction: { ...bounds } } : {}),
  };
  const includedType = categoryType[category];
  if (includedType) { request.includedType = includedType; request.useStrictTypeFiltering = true; }
  return request;
}
function openingPoint(point: google.maps.places.OpeningHoursPoint): OpeningPoint {
  return { day: point.day, hour: point.hour, minute: point.minute };
}
function openingSchedule(schedule?: google.maps.places.OpeningHours | null): OpeningSchedule | undefined {
  if (!schedule || !Array.isArray(schedule.periods)) return undefined;
  return {
    periods: schedule.periods.map(period => ({ open: openingPoint(period.open), ...(period.close ? { close: openingPoint(period.close) } : {}) })),
    weekdayDescriptions: (schedule.weekdayDescriptions ?? []).filter(line => typeof line === 'string').map(line => line.slice(0, 300)),
  };
}
function photoDescriptor(photo: google.maps.places.Photo): DiscoveryPhoto {
  const now = Date.now();
  for (const [key, entry] of photoHandles) if (now - entry.at > 15 * 60_000) photoHandles.delete(key);
  while (photoHandles.size >= 1_000) photoHandles.delete(photoHandles.keys().next().value!);
  const key = `discovery-photo-${++photoSequence}`;
  photoHandles.set(key, { at: now, photo, urls: new Map() });
  return {
    key, width: photo.widthPx, height: photo.heightPx,
    authors: (photo.authorAttributions ?? []).filter(author => author.displayName).map(author => ({ name: author.displayName.slice(0, 300), uri: safeURL(author.uri) })),
  };
}
/** Call only when a visible thumbnail or detail image is needed. No provider URL is persisted. */
export function getDiscoveryPhotoURL(photo: DiscoveryPhoto, maxWidth = 400): string | undefined {
  const entry = photoHandles.get(photo.key);
  if (!entry || Date.now() - entry.at > 15 * 60_000) return undefined;
  const width = Math.max(100, Math.min(1_600, Math.round(maxWidth / 100) * 100));
  const prior = entry.urls.get(width);
  if (prior) return prior;
  try {
    const url = safeURL(entry.photo.getURI({ maxWidth: width }));
    if (url) entry.urls.set(width, url);
    return url;
  } catch { return undefined; }
}
async function normalize(value: google.maps.places.Place, details = false): Promise<DiscoveryResult | null> {
  const place = await fromGooglePlace(value);
  if (!place) return null;
  // Secondary facilities (a museum café, for example) must not redefine the place.
  if (value.primaryType) {
    const food = /(?:^|_)(?:restaurant|cafe|bakery|food|bar|meal|coffee_shop|tea_house|pub)(?:_|$)/.test(value.primaryType);
    const lodging = /(?:^|_)(?:lodging|hotel|hostel|motel|resort|guest_house|bed_and_breakfast)(?:_|$)/.test(value.primaryType);
    place.cat = food ? 'food' : lodging ? 'custom' : 'attr';
  }
  return { place, info: {
    rating: Number.isFinite(value.rating) && value.rating! >= 0 && value.rating! <= 5 ? value.rating! : undefined,
    ratingCount: Number.isInteger(value.userRatingCount) && value.userRatingCount! >= 0 ? value.userRatingCount! : undefined,
    primaryType: value.primaryTypeDisplayName?.slice(0, 100),
    businessStatus: value.businessStatus ?? undefined,
    utcOffsetMinutes: Number.isFinite(value.utcOffsetMinutes) ? value.utcOffsetMinutes! : undefined,
    fetchedAt: Date.now(), photos: (value.photos ?? []).slice(0, details ? 6 : 1).map(photoDescriptor),
    currentHours: openingSchedule(value.currentOpeningHours), regularHours: openingSchedule(value.regularOpeningHours),
  } };
}
export function searchDiscovery(query: string, destination: string, category: DiscoveryCategory = 'all', bounds?: SearchBounds): Promise<DiscoveryResult[]> {
  let request: google.maps.places.SearchByTextRequest;
  try { request = discoverySearchRequest(query, destination, category, bounds); }
  catch (error) { return Promise.reject(error); }
  const key = JSON.stringify([request.textQuery, category, bounds]);
  return cached(searchCache, key, async () => {
    try {
      const maps = await loadGoogleMaps();
      const { Place: GooglePlace } = await maps.importLibrary('places') as google.maps.PlacesLibrary;
      const response = await timeout(GooglePlace.searchByText(request));
      const normalized = await Promise.all(response.places.slice(0, 8).map(place => normalize(place)));
      return normalized.filter((result): result is DiscoveryResult => result !== null && (!bounds || withinSearchBounds(result.place, bounds)));
    } catch (error) { throw new Error(mapsErrorMessage(error)); }
  });
}
export function fetchDiscoveryDetails(googleId: string): Promise<DiscoveryResult> {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(googleId)) return Promise.reject(new Error('This saved place has an invalid Google Maps ID.'));
  return cached(detailCache, googleId, async () => {
    try {
      const maps = await loadGoogleMaps();
      const { Place: GooglePlace } = await maps.importLibrary('places') as google.maps.PlacesLibrary;
      const value = new GooglePlace({ id: googleId });
      await timeout(value.fetchFields({ fields: [...detailFields] }));
      const result = await normalize(value, true);
      if (!result) throw { code: 'NOT_FOUND' };
      return result;
    } catch (error) { throw new Error(mapsErrorMessage(error)); }
  });
}
