import { loadGoogleMaps, mapsErrorMessage } from './googleMaps';

export type DestinationView = {
  center: { lat: number; lng: number };
  bounds?: { north: number; south: number; east: number; west: number };
  attributions?: { provider: string; providerURI?: string }[];
};

const CACHE_MS = 10 * 60_000;
const CACHE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 20_000;
const geographicType = /^(?:locality|postal_town|administrative_area_level_\d+|country|continent|political|sublocality(?:_level_\d+)?|neighborhood|colloquial_area|natural_feature|island|archipelago)$/;
const coordinate = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

function safeAttributions(place: google.maps.places.Place): DestinationView['attributions'] {
  if (!Array.isArray(place.attributions)) return undefined;
  const unique = new Map<string, { provider: string; providerURI?: string }>();
  for (const attribution of place.attributions.slice(0, 100)) {
    if (!attribution || typeof attribution.provider !== 'string' || !attribution.provider.trim()) continue;
    const credit: { provider: string; providerURI?: string } = { provider: attribution.provider.trim().slice(0, 300) };
    if (typeof attribution.providerURI === 'string' && attribution.providerURI.length <= 2048) {
      try {
        const url = new URL(attribution.providerURI);
        if (url.protocol === 'https:' && !url.username && !url.password) credit.providerURI = url.href;
      } catch { /* Keep the provider name when its URL is invalid. */ }
    }
    unique.set(JSON.stringify(credit), credit);
  }
  return unique.size ? [...unique.values()] : undefined;
}

function readView(place: google.maps.places.Place): DestinationView | null {
  try {
    const lat = place.location?.lat();
    const lng = place.location?.lng();
    if (!coordinate(lat, -90, 90) || !coordinate(lng, -180, 180)) return null;
    const view: DestinationView = { center: { lat, lng } };
    if (place.viewport != null) {
      const bounds = place.viewport.toJSON();
      if (!bounds || !coordinate(bounds.north, -90, 90) || !coordinate(bounds.south, -90, 90)
        || !coordinate(bounds.east, -180, 180) || !coordinate(bounds.west, -180, 180)
        || bounds.south >= bounds.north || bounds.east === bounds.west) return null;
      // west > east is a valid viewport crossing the antimeridian.
      view.bounds = { north: bounds.north, south: bounds.south, east: bounds.east, west: bounds.west };
    }
    const attributions = safeAttributions(place);
    if (attributions) view.attributions = attributions;
    return view;
  } catch { return null; }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), REQUEST_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

/** Resolve a destination without GPS, an itinerary location bias, or persisted provider data. */
export function createDestinationResolver(load = loadGoogleMaps, now = Date.now): (destination: string) => Promise<DestinationView | null> {
  const cache = new Map<string, { at: number | null; promise: Promise<DestinationView | null> }>();
  return (destination: string) => {
    const query = typeof destination === 'string' ? destination.trim() : '';
    if (!query) return Promise.resolve(null);
    const prior = cache.get(query);
    if (prior && (prior.at === null || (now() - prior.at >= 0 && now() - prior.at < CACHE_MS))) return prior.promise;
    if (prior) cache.delete(query);
    while (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);

    const work = async (): Promise<DestinationView | null> => {
      const maps = await load();
      const { Place } = await maps.importLibrary('places') as google.maps.PlacesLibrary;
      const response = await Place.searchByText({
        textQuery: query,
        fields: ['location', 'viewport', 'types', 'attributions'],
        maxResultCount: 8,
        language: 'en',
      });
      if (!Array.isArray(response?.places)) return null;
      let fallback: DestinationView | null = null;
      for (const place of response.places) {
        const view = readView(place);
        if (!view) continue;
        if (Array.isArray(place.types) && place.types.some(type => typeof type === 'string' && geographicType.test(type))) return view;
        fallback ??= view;
      }
      return fallback;
    };
    const promise = withTimeout(work()).catch(error => { throw new Error(mapsErrorMessage(error, 'places')); });
    const entry = { at: null as number | null, promise };
    cache.set(query, entry);
    void promise.then(view => {
      if (cache.get(query) !== entry) return;
      if (view) entry.at = now();
      else cache.delete(query);
    }, () => { if (cache.get(query) === entry) cache.delete(query); });
    return promise;
  };
}

export const resolveDestinationView = createDestinationResolver();
