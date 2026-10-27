import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchPlace, findSamplePlace } from './googleMaps';
import { flightsForDay, getPlaces, PLACES, staysForDay, type Place, type Trip } from './model';
import {createPlaceSession} from './placeHydration';
import {useConnectivity} from './offline/connectivity';

interface HydrationTarget {
  key: string;
  place: Place;
  source: 'google' | 'sample';
}

const googleKey = (id: string) => `google:${id}`;
const sampleKey = (id: string, destination: string) => `sample:${JSON.stringify([id, destination])}`;
const HYDRATION_ERROR = 'Some places could not load. Check your connection and retry.';

/** Provider details live in this mounted session only, never inside the saved trip. */
export function usePlaceData(trip: Trip, dayIndex: number | 'all', enabled = true, isolationKey = 'device'): {
  places: Record<string, Place>;
  register: (place: Place) => void;
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const online = useConnectivity();
  const base = useMemo(() => getPlaces(trip), [trip.customPlaces]);
  const scope = JSON.stringify([isolationKey, trip.id]);
  // A fresh instance masks private previews immediately, including when an
  // account returns after another account. Late callbacks retain only the old
  // instance; they cannot populate the new account's view before cleanup runs.
  const session = useMemo(() => {
    const current = createPlaceSession(); current.select(scope); return current;
  }, [scope]);
  const [revision, setRevision] = useState(0);
  const [activity, setActivity] = useState({scope, loading: false, error: null as string | null});
  const [retryCount, setRetryCount] = useState(0);
  const {resolved, registered} = session.read(scope);

  const remember = useCallback((key: string, place: Place | null) => {
    if (session.remember(scope, key, place)) setRevision(value => value + 1);
  }, [scope, session]);

  const register = useCallback((place: Place) => {
    if (session.register(scope, place)) setRevision(value => value + 1);
  }, [scope, session]);

  const targets: HydrationTarget[] = [];
  if (enabled && online) {
    const visibleDays = dayIndex === 'all' ? trip.days : trip.days.slice(dayIndex, dayIndex + 1);
    const flights = dayIndex === 'all' ? trip.flights ?? [] : flightsForDay(trip, dayIndex).map(entry => entry.flight);
    const stays = dayIndex === 'all' ? trip.stays ?? [] : staysForDay(trip, dayIndex).map(entry => entry.stay);
    const visibleIds = new Set(['hotel', ...visibleDays.flatMap(day => [day.startPlaceId ?? 'hotel', day.endPlaceId ?? 'hotel', ...day.items.map(item => item.placeId)]),
      ...flights.flatMap(flight => [flight.fromPlaceId, flight.toPlaceId]), ...stays.map(stay => stay.placeId), ...trip.ideas]);
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
    const pending = targets.filter(target => !Object.hasOwn(session.read(scope).resolved, target.key));
    setActivity({scope, loading: enabled && online && pending.length > 0, error: null});
    if (!enabled || !online || pending.length === 0) return;
    let cursor = 0;
    let failed = false;
    // A whole-trip view can contain many places. Keep provider requests bounded,
    // and stop starting work when the user changes trips or closes the view.
    const hydrate = async () => {
      while (active && session.isCurrent(scope) && cursor < pending.length) {
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
      if (!active || !session.isCurrent(scope)) return;
      setActivity({scope, loading: false, error: failed ? HYDRATION_ERROR : null});
    });
    return () => { active = false; };
    // The signature captures every request input; base metadata is merged below each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled, online, retryCount, remember, scope, session]);

  const places = useMemo(() => {
    // Extra registered results support previews before the user adds them to a trip.
    // Existing trip IDs always win over unrelated results from previous searches.
    const merged: Record<string, Place> = { ...registered, ...base };
    for (const [id, place] of Object.entries(base)) {
      if (!online) { merged[id] = {...place, name: place.offlineDetails?.name || place.userLabel || place.name, area: place.offlineDetails?.address || place.offlineDetails?.localAddress || place.area}; continue; }
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
  }, [base, registered, resolved, trip.customPlaces, trip.destination, revision, online]);

  const retry = useCallback(() => setRetryCount(count => count + 1), []);
  return { places, register, loading: enabled && activity.scope === scope && activity.loading,
    error: enabled && activity.scope === scope ? activity.error : null, retry };
}
