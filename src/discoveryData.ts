import type { Place } from './model';
import { fromGooglePlace, loadGoogleMaps, mapsErrorMessage, placeSearchQuery } from './googleMaps';
import type { OpeningInfo, OpeningPoint, OpeningSchedule } from './openingHours';
export { getOpeningSummary } from './openingHours';
export type { OpeningSchedule, OpeningSummary } from './openingHours';

export interface SearchBounds { north: number; south: number; east: number; west: number }
export type DiscoveryCategory = 'all' | 'attractions' | 'museums' | 'restaurants' | 'cafes' | 'parks' | 'shopping' | 'nightlife' | 'indoor';
export interface DiscoveryPhoto { key: string; width: number; height: number; authors: { name: string; uri?: string }[] }
export interface DiscoveryInfo {
  rating?: number;
  ratingCount?: number;
  primaryType?: string;
  primaryTypeCode?: string;
  businessStatus?: string;
  utcOffsetMinutes?: number;
  fetchedAt: number;
  photos: DiscoveryPhoto[];
  currentHours?: OpeningSchedule;
  regularHours?: OpeningSchedule;
}
export interface DiscoveryResult { place: Place; info: DiscoveryInfo }
export interface DiscoverySearchPage { results: DiscoveryResult[]; nextPageToken?: string }
/** Narrow primary venue types suggest indoor options; a venue's secondary café is not enough. */
export function indoorDiscoveryResult(result:DiscoveryResult,exposure?:'indoor'|'outdoor'|'mixed'|'unknown'):boolean {
  if(exposure)return exposure==='indoor';
  return /^(museum|art_gallery|library|movie_theater)$/.test(result.info.primaryTypeCode??'');
}
const CACHE_MS = 5 * 60_000;
const CACHE_LIMIT = 100;
interface CacheEntry<T> { at: number; promise: Promise<T> }
const searchCache = new Map<string, CacheEntry<DiscoverySearchPage>>();
// Detail responses never reuse the intentionally smaller card response.
const detailCache = new Map<string, CacheEntry<DiscoveryResult>>();
const visitHoursCache = new Map<string, CacheEntry<OpeningInfo>>();
// Current-page thumbnail responses only: never written into a saved Place or offline storage.
const itineraryPhotoCache = new Map<string, CacheEntry<DiscoveryPhoto | undefined> & { photo?: DiscoveryPhoto }>();
const photoHandles = new Map<string, { at: number; photo: google.maps.places.Photo; urls: Map<number, string> }>();
let photoSequence = 0;
const baseFields = ['id', 'displayName', 'location', 'formattedAddress', 'googleMapsURI', 'types', 'attributions'];
const cardFields = [...baseFields, 'primaryType', 'primaryTypeDisplayName', 'businessStatus', 'rating', 'userRatingCount', 'photos', 'currentOpeningHours', 'utcOffsetMinutes'];
const detailFields = [...cardFields, 'regularOpeningHours'];
const categoryText: Record<DiscoveryCategory, string> = { all: 'tourist attractions', attractions: 'tourist attractions', museums: 'museums', restaurants: 'restaurants', cafes: 'cafes', parks: 'parks and gardens', shopping: 'shopping, markets and malls', nightlife: 'bars and pubs', indoor:'museums and art galleries' };
// Shopping includes markets and independent shops, rather than restricting it to malls.
const categoryType: Partial<Record<DiscoveryCategory, string>> = { attractions: 'tourist_attraction', museums: 'museum', restaurants: 'restaurant', cafes: 'cafe', parks: 'park', nightlife: 'bar' };
const browserKey = import.meta.env?.VITE_GOOGLE_MAPS_API_KEY?.trim();
const restCardFields = cardFields.map(field => `places.${field === 'googleMapsURI' ? 'googleMapsUri' : field}`);
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
  // Shopping has no single inclusive provider type: keep its intent even for a street or district query.
  if (category === 'shopping' && !/\b(?:shopping|shops?|stores?|markets?|malls?|boutiques?|retail)\b/i.test(clean)) clean = `${clean} shopping`;
  const request: google.maps.places.SearchByTextRequest = {
    textQuery: bounds ? clean : placeSearchQuery(clean, destination), fields: [...cardFields], maxResultCount: 10, language: 'en',
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
function rememberItineraryPhoto(googleId: string, photo: DiscoveryPhoto | undefined): void {
  itineraryPhotoCache.delete(googleId);
  while (itineraryPhotoCache.size >= CACHE_LIMIT) itineraryPhotoCache.delete(itineraryPhotoCache.keys().next().value!);
  itineraryPhotoCache.set(googleId, { at: Date.now(), photo, promise: Promise.resolve(photo) });
}
/** A recent Discover/detail response can supply a thumbnail without a second Place request. */
export function getCachedItineraryPhoto(googleId: string): DiscoveryPhoto | undefined {
  const entry = itineraryPhotoCache.get(googleId);
  return entry && Date.now() - entry.at < CACHE_MS ? entry.photo : undefined;
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
  const photos = (value.photos ?? []).slice(0, details ? 6 : 1).map(photoDescriptor);
  if (place.googlePlaceId) rememberItineraryPhoto(place.googlePlaceId, photos[0]);
  return { place, info: {
    rating: Number.isFinite(value.rating) && value.rating! >= 0 && value.rating! <= 5 ? value.rating! : undefined,
    ratingCount: Number.isInteger(value.userRatingCount) && value.userRatingCount! >= 0 ? value.userRatingCount! : undefined,
    primaryType: value.primaryTypeDisplayName?.slice(0, 100),
    primaryTypeCode: value.primaryType?.slice(0,100),
    businessStatus: value.businessStatus ?? undefined,
    utcOffsetMinutes: Number.isFinite(value.utcOffsetMinutes) ? value.utcOffsetMinutes! : undefined,
    fetchedAt: Date.now(), photos,
    currentHours: openingSchedule(value.currentOpeningHours), regularHours: openingSchedule(value.regularOpeningHours),
  } };
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function restHours(value: unknown): google.maps.places.OpeningHours | undefined {
  const hours = object(value);
  if (!hours || !Array.isArray(hours.periods)) return undefined;
  const point = (value: unknown): OpeningPoint | undefined => {
    const raw = object(value);
    if (!raw) return undefined;
    // Protobuf JSON may omit zero-valued fields, including midnight and Sunday.
    const day = raw.day ?? 0, hour = raw.hour ?? 0, minute = raw.minute ?? 0;
    if (![day, hour, minute].every(Number.isInteger) || typeof day !== 'number' || typeof hour !== 'number' || typeof minute !== 'number' || day < 0 || day > 6 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
    return { day, hour, minute };
  };
  const periods = hours.periods.flatMap(value => {
    const period = object(value), open = point(period?.open);
    if (!open) return [];
    const close = period?.close === undefined ? undefined : point(period.close);
    if (period?.close !== undefined && !close) return [];
    return [{ open, ...(close ? { close } : {}) }];
  });
  return { periods, weekdayDescriptions: array(hours.weekdayDescriptions).filter((value): value is string => typeof value === 'string') } as google.maps.places.OpeningHours;
}
function restPhoto(value: unknown): google.maps.places.Photo | undefined {
  const photo = object(value), name = string(photo?.name);
  // Only a Google photo resource name may become a media URL; never trust a response URL.
  if (!photo || !name || !/^places\/[A-Za-z0-9_-]{1,512}\/photos\/[A-Za-z0-9_-]{1,4096}$/.test(name)) return undefined;
  return {
    widthPx: Math.max(0, number(photo.widthPx) ?? 0), heightPx: Math.max(0, number(photo.heightPx) ?? 0),
    authorAttributions: array(photo.authorAttributions).flatMap(value => {
      const author = object(value), displayName = string(author?.displayName);
      return displayName ? [{ displayName, uri: safeURL(string(author?.uri)) }] : [];
    }),
    getURI({ maxWidth }: { maxWidth?: number }) {
      const parameters = new URLSearchParams({ key: browserKey!, maxWidthPx: String(maxWidth ?? 400) });
      return `https://places.googleapis.com/v1/${name}/media?${parameters}`;
    },
  } as google.maps.places.Photo;
}
/** REST and SDK cards share one normalizer and stable place IDs. No detail lookup is needed. */
async function normalizeRest(value: unknown): Promise<DiscoveryResult | null> {
  const raw = object(value);
  if (!raw) return null;
  const id = string(raw.id), displayName = string(object(raw.displayName)?.text);
  const location = object(raw.location), lat = number(location?.latitude), lng = number(location?.longitude);
  if (!id || !displayName || lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const adapted = {
    id, displayName, location: { lat: () => lat, lng: () => lng },
    formattedAddress: string(raw.formattedAddress), googleMapsURI: safeURL(string(raw.googleMapsUri)),
    types: array(raw.types).filter((value): value is string => typeof value === 'string'),
    attributions: array(raw.attributions).flatMap(value => {
      const attribution = object(value), provider = string(attribution?.provider);
      return provider ? [{ provider, providerURI: safeURL(string(attribution?.providerUri)) }] : [];
    }),
    primaryType: string(raw.primaryType), primaryTypeDisplayName: string(object(raw.primaryTypeDisplayName)?.text),
    businessStatus: string(raw.businessStatus), rating: number(raw.rating), userRatingCount: number(raw.userRatingCount), utcOffsetMinutes: number(raw.utcOffsetMinutes),
    currentOpeningHours: restHours(raw.currentOpeningHours),
    photos: array(raw.photos).map(restPhoto).filter((photo): photo is google.maps.places.Photo => photo !== undefined),
  } as unknown as google.maps.places.Place;
  return normalize(adapted);
}
function usablePageToken(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 8_192 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
/** Places (New) REST exposes pagination that the JavaScript searchByText API omits. */
export function searchDiscoveryPage(query: string, destination: string, category: DiscoveryCategory = 'all', bounds?: SearchBounds, pageToken?: string): Promise<DiscoverySearchPage> {
  let request: google.maps.places.SearchByTextRequest;
  try { request = discoverySearchRequest(query, destination, category, bounds); }
  catch (error) { return Promise.reject(error); }
  if (pageToken !== undefined && !usablePageToken(pageToken)) return Promise.reject(new Error('Please search again to browse more places.'));
  if (!browserKey) return Promise.reject(new Error('Google Maps is not configured. Add the browser API key and rebuild.'));
  const body = {
    textQuery: request.textQuery, languageCode: 'en', pageSize: 10,
    ...(request.includedType ? { includedType: request.includedType, strictTypeFiltering: true } : {}),
    ...(bounds ? { locationRestriction: { rectangle: {
      low: { latitude: bounds.south, longitude: bounds.west }, high: { latitude: bounds.north, longitude: bounds.east },
    } } } : {}),
    ...(pageToken ? { pageToken } : {}),
  };
  const key = JSON.stringify([body, category]);
  return cached(searchCache, key, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': browserKey, 'X-Goog-FieldMask': [...restCardFields, 'nextPageToken'].join(',') },
        body: JSON.stringify(body),
      });
      const payload = object(await response.json());
      if (!response.ok) throw { code: string(object(payload?.error)?.status) ?? (response.status === 403 ? 'PERMISSION_DENIED' : response.status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE') };
      if (!payload || (payload.places !== undefined && !Array.isArray(payload.places))) throw new Error('invalid response');
      const normalized = await Promise.all(array(payload.places).slice(0, 10).map(normalizeRest));
      const seen = new Set<string>();
      const results = normalized.filter((result): result is DiscoveryResult => {
        if (!result || seen.has(result.place.id) || (bounds && !withinSearchBounds(result.place, bounds)) || (category === 'indoor' && !indoorDiscoveryResult(result))) return false;
        seen.add(result.place.id); return true;
      });
      const nextPageToken = usablePageToken(payload.nextPageToken);
      return { results, ...(nextPageToken && nextPageToken !== pageToken ? { nextPageToken } : {}) };
    } catch (error) { throw new Error(mapsErrorMessage(error)); }
    finally { clearTimeout(timer); }
  });
}
/** Compatibility for callers that only need the first page. */
export async function searchDiscovery(query: string, destination: string, category: DiscoveryCategory = 'all', bounds?: SearchBounds): Promise<DiscoveryResult[]> {
  return (await searchDiscoveryPage(query, destination, category, bounds)).results;
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

/** Called only for visible itinerary cards. The photo field includes its author credits. */
export function fetchItineraryPhoto(googleId: string): Promise<DiscoveryPhoto | undefined> {
  if (typeof googleId !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(googleId)) return Promise.reject(new Error('This saved place has an invalid Google Maps ID.'));
  return cached(itineraryPhotoCache, googleId, async () => {
    try {
      const detail = detailCache.get(googleId);
      if (detail && Date.now() - detail.at < CACHE_MS) {
        const photo = (await detail.promise).info.photos[0];
        rememberItineraryPhoto(googleId, photo);
        return photo;
      }
      const maps = await loadGoogleMaps();
      const { Place: GooglePlace } = await maps.importLibrary('places') as google.maps.PlacesLibrary;
      const value = new GooglePlace({ id: googleId });
      await timeout(value.fetchFields({ fields: ['photos'] }));
      const photo = value.photos?.[0] ? photoDescriptor(value.photos[0]) : undefined;
      rememberItineraryPhoto(googleId, photo);
      return photo;
    } catch (error) { throw new Error(mapsErrorMessage(error)); }
  });
}

/** Itinerary checks request only hours, never photos, reviews or ratings. */
export function fetchVisitOpeningInfo(googleId: string): Promise<OpeningInfo> {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(googleId)) return Promise.reject(new Error('This saved place has an invalid Google Maps ID.'));
  const detail = detailCache.get(googleId);
  if (detail && Date.now() - detail.at < CACHE_MS) return detail.promise.then(result => result.info);
  return cached(visitHoursCache, googleId, async () => {
    try {
      const maps = await loadGoogleMaps();
      const { Place: GooglePlace } = await maps.importLibrary('places') as google.maps.PlacesLibrary;
      const value = new GooglePlace({ id: googleId });
      await timeout(value.fetchFields({ fields: ['businessStatus', 'utcOffsetMinutes', 'currentOpeningHours', 'regularOpeningHours'] }));
      return {
        businessStatus: value.businessStatus ?? undefined,
        utcOffsetMinutes: Number.isFinite(value.utcOffsetMinutes) ? value.utcOffsetMinutes! : undefined,
        fetchedAt: Date.now(), currentHours: openingSchedule(value.currentOpeningHours), regularHours: openingSchedule(value.regularOpeningHours),
      };
    } catch (error) { throw new Error(mapsErrorMessage(error)); }
  });
}
