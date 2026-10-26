import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPlace, findSamplePlace } from './googleMaps';
import { getPlaces, PLACES, type Place, type Trip } from './model';

interface HydrationTarget {
  key: string;
  place: Place;
  source: 'google' | 'sample';
}

type PlaceCache = Record<string, Place | null>;
const googleKey = (id: string) => `google:${id}`;
const sampleKey = (id: string, destination: string) => `sample:${JSON.stringify([id, destination])}`;
const HYDRATION_ERROR = 'Some places could not load. Check your connection and retry.';

/** Provider details live in this mounted session only, never inside the saved trip. */
export function usePlaceData(trip: Trip, dayIndex: number, enabled = true): {
  places: Record<string, Place>;
  register: (place: Place) => void;
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const base = useMemo(() => getPlaces(trip), [trip.customPlaces]);
  const [resolved, setResolved] = useState<PlaceCache>({});
  const resolvedRef = useRef<PlaceCache>({});
  const [registered, setRegistered] = useState<Record<string, Place>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const remember = useCallback((key: string, place: Place | null) => {
    const next = { ...resolvedRef.current, [key]: place };
    resolvedRef.current = next;
    setResolved(next);
  }, []);

  const register = useCallback((place: Place) => {
    setRegistered(current => ({ ...current, [place.id]: {
      ...place,
      ...(place.userLabel ? { name: place.userLabel } : {}),
      ...(place.userNotes !== undefined ? { blurb: place.userNotes } : {}),
    } }));
    if (place.googlePlaceId) remember(googleKey(place.googlePlaceId), place);
  }, [remember]);

  const targets: HydrationTarget[] = [];
  if (enabled) {
    const visibleIds = new Set(['hotel', ...(trip.days[dayIndex]?.items.map(item => item.placeId) ?? []), ...trip.ideas]);
    const targetKeys = new Set<string>();
    for (const id of visibleIds) {
      const place = base[id];
      if (!place) continue;
      let target: HydrationTarget | undefined;
      if (place.googlePlaceId) target = { key: googleKey(place.googlePlaceId), place, source: 'google' };
      else if (!Object.hasOwn(trip.customPlaces, id) && Object.hasOwn(PLACES, id)
        && (place.lat === undefined || place.lng === undefined)) {
        target = { key: sampleKey(id, trip.destination), place: PLACES[id], source: 'sample' };
      }
      if (target && !targetKeys.has(target.key)) { targetKeys.add(target.key); targets.push(target); }
    }
  }
  // Reordering, changing visit notes and receiving hydration results must not restart requests.
  const signature = JSON.stringify(targets.map(target => target.key).sort());

  useEffect(() => {
    let active = true;
    const pending = targets.filter(target => !Object.hasOwn(resolvedRef.current, target.key));
    setError(null);
    if (!enabled || pending.length === 0) { setLoading(false); return; }
    setLoading(true);
    void Promise.allSettled(pending.map(async target => {
      const place = target.source === 'google'
        ? await fetchPlace(target.place.googlePlaceId!)
        : await findSamplePlace(target.place, trip.destination);
      // A response from a previous trip/day may be reused by the service cache later,
      // but must not update the active view or its loading/error state.
      if (active) remember(target.key, place);
    })).then(results => {
      if (!active) return;
      setLoading(false);
      if (results.some(result => result.status === 'rejected')) setError(HYDRATION_ERROR);
    });
    return () => { active = false; };
    // The signature captures every request input; base metadata is merged below each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled, retryCount, remember]);

  const places = useMemo(() => {
    // Extra registered results support previews before the user adds them to a trip.
    // Existing trip IDs always win over unrelated results from previous searches.
    const merged: Record<string, Place> = { ...registered, ...base };
    for (const [id, place] of Object.entries(base)) {
      const fromGoogle = Boolean(place.googlePlaceId);
      const key = place.googlePlaceId ? googleKey(place.googlePlaceId)
        : !Object.hasOwn(trip.customPlaces, id) && Object.hasOwn(PLACES, id) ? sampleKey(id, trip.destination) : undefined;
      const provider = key ? resolved[key] : undefined;
      if (!provider) {
        // User labels and notes remain useful while current provider details are loading.
        merged[id] = {
          ...place,
          ...(place.userLabel ? { name: place.userLabel } : {}),
          ...(place.userNotes !== undefined ? { blurb: place.userNotes } : {}),
        };
        continue;
      }
      merged[id] = {
        ...place,
        ...provider,
        id,
        cat: id === 'hotel' ? 'custom' : place.cat,
        typical: place.typical,
        x: place.x,
        y: place.y,
        ...(fromGoogle ? {
          name: place.userLabel || provider.name,
          blurb: place.userNotes ?? provider.blurb,
        } : { name: place.name, blurb: place.blurb }),
      };
    }
    return merged;
  }, [base, registered, resolved, trip.customPlaces, trip.destination]);

  const retry = useCallback(() => setRetryCount(count => count + 1), []);
  return { places, register, loading: enabled && loading, error: enabled ? error : null, retry };
}
