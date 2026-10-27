import { schedule, scheduleVisitWindow, type Day, type Journey, type Place, type ScheduleContext } from './model';
import type { OpeningInfo } from './openingHours';
import { checkVisitHours, type VisitHoursCheck } from './visitHours';
import { scheduleWithOpeningHours, type HoursByPlace } from './hoursPlanning';
import { withPlaceAdmission } from './placeHours';

export interface OverviewDayData {
  legs: Record<string, Journey>;
  routeLoading: boolean;
  hoursLoading: boolean;
  /** Keyed by Google ID so aliases never require duplicate hours requests. */
  hours: Record<string, OpeningInfo>;
  error: string | null;
}

export interface DayOverviewSummary {
  sc: ReturnType<typeof schedule>;
  status: 'loading' | 'ready' | 'incomplete';
  routeLoading: boolean;
  hoursLoading: boolean;
  visitIssueCount: number;
  /** Red opening/last-entry conflicts, separate from amber shortened visits. */
  hoursConflictCount: number;
  hoursCheckedCount: number;
  hoursUnknownCount: number;
  hoursRegularCount: number;
  visitChecks: Record<string, VisitHoursCheck>;
  error: string | null;
}

export function overviewHoursByPlace(day: Day, places: Record<string, Place>, hours: Record<string, OpeningInfo>): HoursByPlace {
  return Object.fromEntries(day.items.map(item => {
    const place = places[item.placeId];
    return [item.placeId, withPlaceAdmission(place?.googlePlaceId ? hours[place.googlePlaceId] : undefined, place)];
  }));
}

/** Presentation always uses today's trip state and explicit provider journeys. */
export function summarizeOverviewDay(day: Day, date: string, places: Record<string, Place>, data: OverviewDayData, context?: ScheduleContext): DayOverviewSummary {
  // Supplying even an empty legs object is intentional: the model's illustrative
  // sample-distance fallback must never appear as a real whole-trip estimate.
  const hours = overviewHoursByPlace(day, places, data.hours);
  const sc = scheduleWithOpeningHours(day, places, data.legs, {date, hours, context});
  const visitChecks = Object.fromEntries(sc.rows.filter(row => row.it.mode !== 'flight' && !row.it.departureForFlightId).map(row => [row.it.aid, checkVisitHours(
    hours[row.it.placeId],
    {...scheduleVisitWindow(row, date), allowWait: row.it.fixed === null},
  )]));
  const checks = Object.values(visitChecks);
  const hoursUnknownCount = checks.filter(check => check.status === 'unknown').length;
  const loading = data.routeLoading || data.hoursLoading;
  return {
    sc,
    status: loading ? 'loading' : sc.unknown || hoursUnknownCount || data.error ? 'incomplete' : 'ready',
    routeLoading: data.routeLoading,
    hoursLoading: data.hoursLoading,
    visitIssueCount: checks.filter(check => check.status === 'closed' || check.status === 'short').length,
    hoursConflictCount: checks.filter(check => check.status === 'closed').length,
    hoursCheckedCount: checks.length - hoursUnknownCount,
    hoursUnknownCount,
    hoursRegularCount: checks.filter(check => check.source === 'regular').length,
    visitChecks,
    error: data.error,
  };
}

/** A shared queue also bounds old in-flight work during rapid edits or retries. */
export function createOverviewTaskPool(limit = 2) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('A task pool needs at least one worker.');
  const queue: { work: () => Promise<void>; current: () => boolean; resolve: () => void; reject: (error: unknown) => void }[] = [];
  let running = 0;
  const drain = () => {
    while (running < limit && queue.length) {
      const task = queue.shift()!;
      if (!task.current()) { task.resolve(); continue; }
      running++;
      void Promise.resolve().then(task.work).then(task.resolve, task.reject).finally(() => {
        running--;
        drain();
      });
    }
  };
  return (work: () => Promise<void>, current: () => boolean = () => true): Promise<void> => new Promise((resolve, reject) => {
    queue.push({ work, current, resolve, reject });
    drain();
  });
}
