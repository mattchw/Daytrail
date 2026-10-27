import { useCallback, useEffect, useState } from 'react';
import type { Place, Trip } from './model';
import type { OpeningInfo } from './openingHours';
import {withPlaceAdmission} from './placeHours';
import { fetchVisitOpeningInfo } from './discoveryData';
import {useConnectivity} from './offline/connectivity';

interface HoursState {
  key: string;
  infoByPlaceId: Record<string, OpeningInfo>;
  loading: boolean;
  errors: Record<string, string>;
}
/** Active-day hours stay in memory; timing edits and reorders do not fetch again. */
export function useVisitHours(trip: Trip, dayIndex: number, places: Record<string, Place>, enabled = true) {
  const online = useConnectivity();
  enabled = enabled && online;
  const day = trip.days[dayIndex];
  const entries = [...new Set(day?.items.filter(item => item.mode !== 'flight' && !item.departureForFlightId).map(item => item.placeId) ?? [])]
    .sort().flatMap(id => places[id]?.googlePlaceId ? [[id, places[id].googlePlaceId!] as [string, string]] : []);
  const entriesKey = JSON.stringify(entries);
  const key = JSON.stringify([trip.id, day?.id, enabled, entriesKey]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<HoursState>({ key: '', infoByPlaceId: {}, loading: false, errors: {} });
  const retry = useCallback((_placeId?: string) => setAttempt(value => value + 1), []);
  useEffect(() => {
    let active = true;
    const targets = JSON.parse(entriesKey) as [string, string][];
    setState(previous => ({ key, infoByPlaceId: previous.key === key ? previous.infoByPlaceId : {}, loading: enabled && targets.length > 0, errors: {} }));
    if (!enabled || !targets.length) return () => { active = false; };
    let remaining = targets.length;
    for (const [placeId, googleId] of targets) {
      void fetchVisitOpeningInfo(googleId).then(info => {
        if (active) setState(previous => ({ ...previous, infoByPlaceId: { ...previous.infoByPlaceId, [placeId]: info } }));
      }).catch(() => {
        if (active) setState(previous => ({ ...previous, errors: { ...previous.errors, [placeId]: 'Opening hours could not load. You can still plan this visit.' } }));
      }).finally(() => {
        remaining--;
        if (active && remaining === 0) setState(previous => ({ ...previous, loading: false }));
      });
    }
    return () => { active = false; };
  }, [key, entriesKey, enabled, attempt]);
  // Switching trips/days must not display another day's status during effect setup.
  const visible = state.key === key ? state : {key,infoByPlaceId:{},loading:enabled&&entries.length>0,errors:{}};
  const infoByPlaceId:Record<string,OpeningInfo>={...visible.infoByPlaceId};
  for(const item of day?.items??[]){const info=withPlaceAdmission(infoByPlaceId[item.placeId],places[item.placeId]);if(info)infoByPlaceId[item.placeId]=info;}
  return {...visible,infoByPlaceId,retry};
}
