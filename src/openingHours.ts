/** Plain, transient opening data. Never saved inside a trip. */
export interface OpeningPoint { day: number; hour: number; minute: number }
export interface OpeningPeriod { open: OpeningPoint; close?: OpeningPoint }
export interface OpeningSchedule { periods: OpeningPeriod[]; weekdayDescriptions: string[] }
export interface OpeningInfo {
  currentHours?: OpeningSchedule;
  regularHours?: OpeningSchedule;
  businessStatus?: string;
  utcOffsetMinutes?: number;
  fetchedAt: number;
}
export interface OpeningSummary {
  status: 'open' | 'closed' | 'unknown';
  label: string;
  detail: string;
  source: 'current' | 'regular' | 'unavailable';
  dayLabel: string;
  hours: string[];
}
const DAY = 1_440;
const WEEK = 7 * DAY;
const DAY_MS = 86_400_000;
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function pointValid(point: OpeningPoint): boolean {
  return Number.isInteger(point.day) && point.day >= 0 && point.day <= 6 &&
    Number.isInteger(point.hour) && point.hour >= 0 && point.hour <= 23 &&
    Number.isInteger(point.minute) && point.minute >= 0 && point.minute <= 59;
}
const minute = (point: OpeningPoint) => point.day * DAY + point.hour * 60 + point.minute;
const clock = (value: number) => `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
function intervals(schedule: OpeningSchedule): [number, number][] | null {
  if (!schedule.periods.length) {
    // An empty/malformed response is not evidence that a place is closed all week.
    return schedule.weekdayDescriptions.length === 7 && schedule.weekdayDescriptions.every(line => /\bclosed\b/i.test(line)) ? [] : null;
  }
  const result: [number, number][] = [];
  for (const period of schedule.periods) {
    if (!pointValid(period.open)) return null;
    if (!period.close) {
      if (period.open.day === 0 && period.open.hour === 0 && period.open.minute === 0) return [[0, WEEK]];
      return null; // An incomplete period is not evidence of 24-hour opening.
    }
    if (!pointValid(period.close)) return null;
    const start = minute(period.open);
    let end = minute(period.close);
    if (end === start) return null;
    if (end < start) end += WEEK;
    result.push([start, end]);
  }
  return result;
}
function dayHours(schedule: OpeningSchedule, day: number): string[] | null {
  const spans = intervals(schedule);
  if (!spans) return null;
  const start = day * DAY;
  const end = start + DAY;
  const segments: [number, number][] = [];
  for (const [from, to] of spans) for (const shift of [-WEEK, 0, WEEK]) {
    const left = Math.max(start, from + shift), right = Math.min(end, to + shift);
    if (left < right) segments.push([left - start, right - start]);
  }
  segments.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const segment of segments) {
    const prior = merged.at(-1);
    if (prior && segment[0] <= prior[1]) prior[1] = Math.max(prior[1], segment[1]);
    else merged.push([...segment]);
  }
  if (!merged.length) return ['Closed'];
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === DAY) return ['Open 24 hours'];
  return merged.map(([from, to]) => `${clock(from)}–${clock(to)}`);
}
function isOpen(schedule: OpeningSchedule, day: number, time: number): boolean | null {
  const spans = intervals(schedule);
  if (!spans) return null;
  const at = day * DAY + time;
  return spans.some(([from, to]) => [-WEEK, 0, WEEK].some(shift => at >= from + shift && at < to + shift));
}
function parseDate(value?: string): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
const dateString = (date: Date) => date.toISOString().slice(0, 10);

/** Current status uses the place's UTC offset; future dates never claim "open now". */
export function getOpeningSummary(info: OpeningInfo, options: { date?: string; now?: Date } = {}): OpeningSummary {
  const now = options.now ?? new Date();
  const offset = info.utcOffsetMinutes;
  const knownOffset = Number.isFinite(offset) && Math.abs(offset!) <= 14 * 60;
  const localNow = knownOffset ? new Date(now.getTime() + offset! * 60_000) : null;
  const fetchedLocal = knownOffset ? new Date(info.fetchedAt + offset! * 60_000) : null;
  const today = localNow && Number.isFinite(localNow.getTime()) ? dateString(localNow) : undefined;
  const requestedDate = options.date ?? today;
  const target = parseDate(requestedDate);
  const dayLabel = target ? weekdays[target.getUTCDay()] : 'Local time';
  const base: OpeningSummary = { status: 'unknown', label: 'Hours unavailable', detail: 'Check opening hours on Google Maps before visiting.', source: 'unavailable', dayLabel, hours: [] };
  if (info.businessStatus === 'CLOSED_PERMANENTLY') return { ...base, status: 'closed', label: 'Permanently closed', detail: 'Google lists this place as permanently closed.' };
  if (info.businessStatus === 'CLOSED_TEMPORARILY') return { ...base, status: 'closed', label: 'Temporarily closed', detail: 'Google lists this place as temporarily closed. Check before planning a visit.' };
  if (!target) return { ...base, label: info.currentHours || info.regularHours ? 'Opening hours available' : base.label, detail: knownOffset ? base.detail : 'Local opening status is unavailable. See the weekly schedule below.' };
  const fetchedDate = fetchedLocal && Number.isFinite(fetchedLocal.getTime()) ? parseDate(dateString(fetchedLocal)) : null;
  const daysSinceFetched = fetchedDate ? (target.getTime() - fetchedDate.getTime()) / DAY_MS : -1;
  const useCurrent = Boolean(info.currentHours && daysSinceFetched >= 0 && daysSinceFetched < 7);
  const schedule = useCurrent ? info.currentHours : info.regularHours;
  if (!schedule) return base;
  const source = useCurrent ? 'current' : 'regular';
  const hours = dayHours(schedule, target.getUTCDay());
  const isToday = requestedDate === today;
  const regularNote = 'Regular weekly hours; holiday hours may differ. Confirm before visiting.';
  const currentNote = 'Hours supplied by Google for this date. Check for last-minute changes.';
  if (isToday && !options.date && localNow) {
    const open = isOpen(schedule, localNow.getUTCDay(), localNow.getUTCHours() * 60 + localNow.getUTCMinutes());
    return {
      status: open === null ? 'unknown' : open ? 'open' : 'closed',
      label: open === null ? 'Hours unavailable' : `${useCurrent ? '' : 'Usually '}${open ? (useCurrent ? 'Open now' : 'open now') : (useCurrent ? 'Closed now' : 'closed now')}`,
      detail: hours ? `${hours.join(' · ')}${useCurrent ? '' : ' · Regular hours; holidays may differ.'}` : base.detail,
      source, dayLabel: 'Today', hours: hours ?? [],
    };
  }
  return {
    status: 'unknown',
    label: `${useCurrent ? '' : 'Regular '}${dayLabel} hours`,
    detail: useCurrent ? currentNote : regularNote, source, dayLabel, hours: hours ?? [],
  };
}
