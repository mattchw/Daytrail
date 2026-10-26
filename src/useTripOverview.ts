import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Journey, Place, Trip } from './model';
import type { OpeningInfo } from './openingHours';
import { fetchVisitOpeningInfo } from './discoveryData';
import { unavailableJourney } from './googleMaps';
import { calculateDayRoutes, pendingLegs, routeInputSignature, tripDayDate, type DayRouteInput } from './useLiveRoutes';
import { createOverviewTaskPool, summarizeOverviewDay, type DayOverviewSummary, type OverviewDayData } from './overviewData';

export type { DayOverviewSummary } from './overviewData';

interface Cached<T> { at: number; value: T }
const routeCache = new Map<string, Cached<Record<string, Journey>>>();
const hoursCache = new Map<string, Cached<OpeningInfo>>();
const CACHE_MS = 5 * 60_000;
const CACHE_LIMIT = 200;
const enqueueDay = createOverviewTaskPool(2);
function readCache<T>(cache: Map<string, Cached<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < CACHE_MS) return entry.value;
  if (entry) cache.delete(key);
  return undefined;
}
function writeCache<T>(cache: Map<string, Cached<T>>, key: string, value: T) {
  cache.delete(key);
  while (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
}
const routeError = (legs: Record<string, Journey>) => {
  const count = Object.values(legs).filter(leg => leg.status === 'unavailable' || leg.min === null).length;
  return count ? `${count} ${count === 1 ? 'journey needs' : 'journeys need'} confirmation.` : null;
};
const googleIds = (input: DayRouteInput) => [...new Set(input.day.items.flatMap(item => input.places[item.placeId]?.googlePlaceId ?? []))];
function initialData(signature: string, input: DayRouteInput): OverviewDayData {
  const cachedLegs = readCache(routeCache, signature);
  const ids = googleIds(input);
  const hours = Object.fromEntries(ids.flatMap(id => {
    const info = readCache(hoursCache, id);
    return info ? [[id, info]] : [];
  }));
  return {
    legs: cachedLegs ?? pendingLegs(input),
    routeLoading: !cachedLegs && input.day.items.length > 0,
    hoursLoading: ids.some(id => !hours[id]),
    hours,
    error: cachedLegs ? routeError(cachedLegs) : null,
  };
}
interface OverviewState { key: string; byDay: Record<string, OverviewDayData> }

/** Two days at a time; provider routes and hours remain in this session only. */
export function useTripOverview(trip: Trip, places: Record<string, Place>, enabled = true): {
  days: Record<string, DayOverviewSummary>;
  loading: boolean;
  completedDays: number;
  totalDays: number;
  retry: (dayId?: string) => void;
} {
  const signaturesKey = JSON.stringify(trip.days.map((_, index) => routeInputSignature(trip, index, places)));
  const entries = useMemo(() => (JSON.parse(signaturesKey) as string[]).map(signature => ({
    signature, input: JSON.parse(signature) as DayRouteInput,
  })), [signaturesKey]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<OverviewState>({ key: '', byDay: {} });
  const key = JSON.stringify([trip.id, enabled, signaturesKey, attempt]);
  const retry = useCallback((dayId?: string) => {
    // Good service-level journeys remain reusable; unavailable requests are not
    // cached there, so Retry can recover without paying for every known leg.
    for (const { signature, input } of entries) {
      if (dayId && input.day.id !== dayId) continue;
      routeCache.delete(signature);
      for (const id of googleIds(input)) hoursCache.delete(id);
    }
    setAttempt(value => value + 1);
  }, [entries]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const current = () => active;
    const initial = Object.fromEntries(entries.map(({ signature, input }) => [input.day.id, initialData(signature, input)]));
    setState({ key, byDay: initial });
    const publish = (dayId: string, data: OverviewDayData) => {
      if (active) setState(previous => previous.key === key
        ? { key, byDay: { ...previous.byDay, [dayId]: { ...data, legs: { ...data.legs }, hours: { ...data.hours } } } }
        : previous);
    };
    // Allow quick move/undo operations to settle before initiating billed calls.
    const timer = window.setTimeout(() => {
      for (const { signature, input } of entries) {
        if (!input.day.items.length) continue;
        void enqueueDay(async () => {
          const data = initialData(signature, input);
          if (!active) return;
          if (data.routeLoading) {
            try {
              const legs = await calculateDayRoutes(input, (id, leg) => {
                if (!active) return;
                data.legs[id] = leg;
                publish(input.day.id, data);
              }, current);
              if (!active) return;
              data.legs = legs;
              // Failed results are retryable; completed successful plans also
              // make switching views and undoing a move immediate.
              if (!routeError(legs)) writeCache(routeCache, signature, legs);
              data.error = routeError(legs);
            } catch {
              if (!active) return;
              data.legs = Object.fromEntries(Object.entries(data.legs).map(([id, leg]) => [id,
                leg.status === 'loading' ? unavailableJourney(leg.mode, 'Route unavailable. Please retry.') : leg]));
              data.error = 'Some journeys could not load. Please retry.';
            }
            data.routeLoading = false;
            publish(input.day.id, data);
          }
          let hoursFailed = false;
          // Sequential within each of the two day workers bounds requests and
          // shares the discovery/active-day service's in-flight hours cache.
          for (const id of googleIds(input)) {
            if (!active) return;
            if (data.hours[id]) continue;
            try {
              const info = readCache(hoursCache, id) ?? await fetchVisitOpeningInfo(id);
              if (!active) return;
              writeCache(hoursCache, id, info);
              data.hours[id] = info;
              publish(input.day.id, data);
            } catch { hoursFailed = true; }
          }
          if (!active) return;
          data.hoursLoading = false;
          if (hoursFailed) data.error = [data.error, 'Some opening hours could not load.'].filter(Boolean).join(' ');
          publish(input.day.id, data);
        }, current).catch(() => {
          if (!active) return;
          const fallback = initialData(signature, input);
          fallback.legs = Object.fromEntries(Object.entries(fallback.legs).map(([id, leg]) => [id,
            leg.status === 'loading' ? unavailableJourney(leg.mode, 'Route unavailable. Please retry.') : leg]));
          publish(input.day.id, { ...fallback, routeLoading: false, hoursLoading: false, error: 'This day could not be checked. Please retry.' });
        });
      }
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [entries, enabled, key]);

  const days = Object.fromEntries(trip.days.map((day, index) => {
    const { signature, input } = entries[index];
    const data = state.key === key && state.byDay[day.id] ? state.byDay[day.id] : initialData(signature, input);
    return [day.id, summarizeOverviewDay(day, tripDayDate(trip.startDate, index), places, data)];
  }));
  const completedDays = Object.values(days).filter(day => !day.routeLoading && !day.hoursLoading).length;
  return { days, loading: enabled && completedDays < trip.days.length, completedDays, totalDays: trip.days.length, retry };
}
