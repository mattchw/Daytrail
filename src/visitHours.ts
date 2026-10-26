import { getOpeningSummary, type OpeningInfo, type OpeningPoint, type OpeningSchedule } from './openingHours';

export interface VisitHoursCheck {
  status: 'fits' | 'closed' | 'short' | 'unknown';
  label: string;
  detail: string;
  source: 'current' | 'regular' | 'unavailable';
  /** Continuous open minutes available from the planned arrival. */
  availableMinutes?: number;
  /** An earlier time on the arrival day at which the whole visit fits. */
  suggestedStart?: number;
}
export interface VisitHoursOptions { date: string; start: number; end: number; approx?: boolean }
const DAY = 1_440, WEEK = 7 * DAY, DAY_MS = 86_400_000;
const unknown = (detail = 'Opening hours are unavailable. Check with the place before visiting.'): VisitHoursCheck => ({ status: 'unknown', label: 'Hours to confirm', detail, source: 'unavailable' });
const validPoint = (p: OpeningPoint) => Number.isInteger(p.day) && p.day >= 0 && p.day < 7 && Number.isInteger(p.hour) && p.hour >= 0 && p.hour < 24 && Number.isInteger(p.minute) && p.minute >= 0 && p.minute < 60;
const minute = (p: OpeningPoint) => p.day * DAY + p.hour * 60 + p.minute;
const clock = (n: number) => `${Math.floor((n % DAY) / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
type Span = [number, number];
function merge(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}
/** Clip a provider week to one calendar day, preserving overnight carry-over. */
function spansForDay(schedule: OpeningSchedule, day: number): Span[] | null {
  if (!schedule.periods.length) return schedule.weekdayDescriptions.length === 7 && schedule.weekdayDescriptions.every(line => /\bclosed\b/i.test(line)) ? [] : null;
  const spans: Span[] = [];
  for (const period of schedule.periods) {
    if (!validPoint(period.open)) return null;
    if (!period.close) {
      if (minute(period.open) === 0) return [[0, DAY]];
      return null;
    }
    if (!validPoint(period.close)) return null;
    const start = minute(period.open);
    let end = minute(period.close);
    if (start === end) return null;
    if (end < start) end += WEEK;
    for (const shift of [-WEEK, 0, WEEK]) {
      const left = Math.max(day * DAY, start + shift), right = Math.min((day + 1) * DAY, end + shift);
      if (left < right) spans.push([left - day * DAY, right - day * DAY]);
    }
  }
  return merge(spans);
}

/** Compare the physical visit window against place-local hours, never device time. */
export function checkVisitHours(info: OpeningInfo | undefined, options: VisitHoursOptions): VisitHoursCheck {
  if (!info) return unknown();
  if (info.businessStatus === 'CLOSED_PERMANENTLY') return { ...unknown(), status: 'closed', label: 'Permanently closed', detail: 'Google lists this place as permanently closed. Choose another stop.' };
  if (info.businessStatus === 'CLOSED_TEMPORARILY') return { ...unknown(), status: 'closed', label: 'Temporarily closed', detail: 'Google currently lists this place as temporarily closed. Confirm whether it will reopen for your trip.' };
  const { date, start, end, approx } = options;
  const base = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!base || !Number.isFinite(base.getTime()) || base.toISOString().slice(0, 10) !== date || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end - start > WEEK || end > 31 * DAY) return unknown('The visit time needs confirmation before opening hours can be checked.');
  const firstDay = Math.floor(start / DAY), lastDay = Math.floor((end - 1) / DAY);
  let source: VisitHoursCheck['source'] = 'current';
  let firstDayLabel = '', firstDayClosed = false;
  const spans: Span[] = [];
  for (let dayOffset = firstDay; dayOffset <= lastDay; dayOffset++) {
    const localDate = new Date(base.getTime() + dayOffset * DAY_MS);
    const summary = getOpeningSummary(info, { date: localDate.toISOString().slice(0, 10) });
    const schedule = summary.source === 'current' ? info.currentHours : summary.source === 'regular' ? info.regularHours : undefined;
    const daily = schedule ? spansForDay(schedule, localDate.getUTCDay()) : null;
    if (daily === null) return unknown('Opening hours for the full visit are unavailable. Confirm the hours before visiting.');
    if (summary.source === 'regular') source = 'regular';
    if (dayOffset === firstDay) { firstDayLabel = summary.dayLabel; firstDayClosed = daily.length === 0; }
    spans.push(...daily.map(([left, right]): Span => [left + dayOffset * DAY, right + dayOffset * DAY]));
  }
  const allSpans = merge(spans);
  const note = source === 'regular' ? 'Based on regular weekly hours; holiday hours may differ. Confirm before visiting.' : 'Based on Google hours for this date; last-minute changes are possible.';
  const prefix = source === 'regular' ? 'Usually ' : '';
  if (approx) {
    if (firstDayClosed) return { status: 'closed', label: `${prefix}${prefix ? 'closed' : 'Closed'} on ${firstDayLabel}`, detail: `This day is listed as closed, regardless of the arrival time. ${note}`, source, availableMinutes: 0 };
    return { status: 'unknown', label: 'Arrival time to confirm', detail: `A journey time is missing, so the visit cannot yet be checked against opening hours. ${note}`, source };
  }
  const duration = end - start;
  const activeSpan = allSpans.find(([left, right]) => start >= left && start < right);
  const suggestedStart = allSpans.reduce<number | undefined>((best, [left, right]) => {
    const candidate = Math.min(start - 1, right - duration);
    return candidate >= left && candidate >= firstDay * DAY && (best === undefined || candidate > best) ? candidate : best;
  }, undefined);
  if (activeSpan && end <= activeSpan[1]) return { status: 'fits', label: source === 'regular' ? 'Fits regular hours' : 'Fits opening hours', detail: note, source, availableMinutes: activeSpan[1] - start };
  if (activeSpan) {
    const availableMinutes = activeSpan[1] - start;
    return { status: 'short', label: `${availableMinutes} min before ${source === 'regular' ? 'regular ' : ''}closing`, detail: `Your ${duration}-minute visit extends past ${clock(activeSpan[1])}${activeSpan[1] >= (firstDay + 1) * DAY ? ' the next day' : ''}. ${note}`, source, availableMinutes, ...(suggestedStart !== undefined ? { suggestedStart } : {}) };
  }
  return { status: 'closed', label: `${prefix}${prefix ? 'closed' : 'Closed'} at arrival`, detail: `${firstDayClosed ? `${firstDayLabel} is listed as closed.` : `The place is closed at your planned ${clock(start)} arrival.`} ${note}`, source, availableMinutes: 0, ...(suggestedStart !== undefined ? { suggestedStart } : {}) };
}
