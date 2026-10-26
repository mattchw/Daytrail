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
export function usePlaceData(trip: Trip, dayIndex: number | 'all', enabled = true): {
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
    const visibleDays = dayIndex === 'all' ? trip.days : trip.days.slice(dayIndex, dayIndex + 1);
    const visibleIds = new Set(['hotel', ...visibleDays.flatMap(day => [day.startPlaceId ?? 'hotel', ...day.items.map(item => item.placeId)]), ...trip.ideas]);
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
    let cursor = 0;
    let failed = false;
    // A whole-trip view can contain many places. Keep provider requests bounded,
    // and stop starting work when the user changes trips or closes the view.
    const hydrate = async () => {
      while (active && cursor < pending.length) {
        const target = pending[cursor++];
        try {
          const place = target.source === 'google'
            ? await fetchPlace(target.place.googlePlaceId!)
            : await findSamplePlace(target.place, trip.destination);
          // Old responses may populate the service cache, never the active view.
          if (active) remember(target.key, place);
        } catch { failed = true; }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, hydrate)).then(() => {
      if (!active) return;
      setLoading(false);
      if (failed) setError(HYDRATION_ERROR);
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
