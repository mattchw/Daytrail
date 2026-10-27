import type {Place} from './model';

export type PlaceCache = Record<string, Place | null>;
interface PlaceSessionSnapshot {
  scope: string;
  resolved: PlaceCache;
  registered: Record<string, Place>;
}
const empty = (scope: string): PlaceSessionSnapshot => ({scope, resolved: {}, registered: {}});

/** Only provider fields belong in a reusable hydration result. */
export function providerOnlyPlace(place: Place): Place {
  return {
    id: place.id, name: place.name, cat: place.cat, x: place.x, y: place.y,
    area: place.area, typical: place.typical, blurb: place.blurb,
    ...(place.noTransit !== undefined ? {noTransit: place.noTransit} : {}),
    ...(place.lat !== undefined ? {lat: place.lat} : {}),
    ...(place.lng !== undefined ? {lng: place.lng} : {}),
    ...(place.googlePlaceId !== undefined ? {googlePlaceId: place.googlePlaceId} : {}),
    ...(place.googleMapsURI !== undefined ? {googleMapsURI: place.googleMapsURI} : {}),
    ...(place.attributions !== undefined ? {attributions: place.attributions.map(item => ({
      provider: item.provider, ...(item.providerURI !== undefined ? {providerURI: item.providerURI} : {}),
    }))} : {}),
  };
}

/** Account/scope/trip changes drop private previews before the next render. */
export function createPlaceSession() {
  let current = empty('');
  return {
    select(scope: string) {
      if (current.scope !== scope) current = empty(scope);
      return current;
    },
    read(scope: string) { return current.scope === scope ? current : empty(scope); },
    isCurrent(scope: string) { return current.scope === scope; },
    remember(scope: string, key: string, provider: Place | null) {
      if (current.scope !== scope) return false;
      current = {...current, resolved: {...current.resolved, [key]: provider && providerOnlyPlace(provider)}};
      return true;
    },
    register(scope: string, place: Place) {
      if (current.scope !== scope) return false;
      // A preview may contain private annotations. It never seeds provider data:
      // even its name/blurb may already have been replaced with a user's text.
      const copy = structuredClone(place);
      current = {...current, registered: {...current.registered, [copy.id]: {
        ...copy,
        ...(copy.userLabel ? {name: copy.userLabel} : {}),
        ...(copy.userNotes !== undefined ? {blurb: copy.userNotes} : {}),
      }}};
      return true;
    },
  };
}
