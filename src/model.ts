/** Pure trip data and planning logic. Legacy x/y coordinates are illustrative only. */
import type { AccommodationBooking, FlightMoment, FlightSegment, FlightTiming, ResolvedFlightMoment } from './bookings/types';
export type { AccommodationBooking, FlightMoment, FlightSegment, FlightTiming, ResolvedFlightMoment } from './bookings/types';
export type GroundMode = 'walk' | 'transit' | 'drive';
export type Mode = GroundMode | 'flight';
export type Category = 'attr' | 'food' | 'custom';
export type Pace = 'relaxed' | 'moderate' | 'active';
export type MealIntent = 'meal' | 'snack' | 'none';
export type Exposure = 'indoor' | 'outdoor' | 'mixed' | 'unknown';

export interface Place {
  id: string;
  name: string;
  cat: Category;
  x: number;
  y: number;
  area: string;
  typical: string;
  blurb: string;
  noTransit?: boolean;
  lat?: number;
  lng?: number;
  googlePlaceId?: string;
  googleMapsURI?: string;
  attributions?: { provider: string; providerURI?: string }[];
  /** User-entered content survives linking a custom place to Google. */
  userLabel?: string;
  userNotes?: string;
  /** Traveller-confirmed last admission, by local weekday (Sunday = 0). */
  lastEntryMinutes?: Partial<Record<number, number>>;
  /** Independently authored offline reference, never copied provider content. */
  offlineDetails?: {name:string;address?:string;localAddress?:string;hours?:string};
}

export interface Journey {
  min: number | null;
  km: string;
  /** Numeric provider route data; display text is never used for distance sums. */
  distanceMeters?: number;
  /** Walking-only distance, including verified transit walking steps when available. */
  walkingMeters?: number;
  mode: Mode;
  status?: 'ready' | 'loading' | 'unavailable';
  reason?: string;
  path?: { lat: number; lng: number }[];
  warning?: string;
  /** Flight times are scheduled booking data, never a Google route estimate. */
  flight?: { id: string; departureMs: number; arrivalMs: number; departureGoalMs: number; arrivalReadyMs: number };
}

export type FreeTimeKind = 'explore' | 'rest' | 'shopping' | 'nothing';
export interface FreeTime { id: string; kind: FreeTimeKind; duration: number; untilBooking: boolean }
export interface ScheduledFreeTime extends FreeTime {
  start: number; end: number; requestedDuration: number;
  bookingId?: string; bookingName?: string; approx: boolean; warning?: string;
}
export interface Activity {
  aid: string;
  /** Stays beside this visit when reordered; never creates a location or route. */
  freeTime?: FreeTime;
  placeId: string;
  duration: number;
  fixed: number | null;
  mode: Mode;
  note: string;
  meal?: MealIntent;
  /** Traveller-entered estimate of walking during this visit, excluding its inbound route. */
  walkingMeters?: number;
  exposure?: Exposure;
  flightId?: string;
  /** A ground-side airport stop explicitly connected to a flight's check-in goal. */
  departureForFlightId?: string;
}

export interface Day {
  pace?: Pace;
  id: string;
  label: string;
  date: string;
  title: string;
  endMode: Mode;
  /** Trip-local departure time in minutes. Older plans start at 09:00. */
  startTime?: number;
  /** A preferred arrival time at the end point, never a cutoff for visits or journeys. */
  finishBy?: number | null;
  /** A different departure point for this day; defaults to the hotel. */
  startPlaceId?: string;
  /** This day's final destination, such as an airport; defaults to the hotel. */
  endPlaceId?: string;
  timezone?: string;
  startStayId?: string;
  endStayId?: string;
  endFlightId?: string;
  items: Activity[];
}

export interface Trip {
  pace?: Pace;
  id: string;
  name: string;
  destination: string;
  startDate: string;
  timezone: string;
  days: Day[];
  ideas: string[];
  customPlaces: Record<string, Place>;
  flights?: FlightSegment[];
  stays?: AccommodationBooking[];
}

export const MAX_TRIP_DAYS = 30;

export const CATEGORIES: Record<Category, { label: string; ink: string; tint: string }> = {
  attr: { label: 'Sight', ink: '#2C5A8C', tint: '#E3EBF5' },
  food: { label: 'Food & drink', ink: '#A24E17', tint: '#F8E7DA' },
  custom: { label: 'Custom', ink: '#6A4A93', tint: '#EDE6F5' },
};

const placeData: Record<string, Omit<Place, 'id'>> = {
  hotel: { name: 'Hotel', cat: 'custom', x: 50, y: 72, area: 'Kyoto Station', typical: '', blurb: 'Your sample base near Kyoto Station. Days start and finish here unless you choose another place.' },
  fushimi: { name: 'Fushimi Inari Taisha', cat: 'attr', x: 60, y: 92, area: 'Fushimi', typical: '2–3 h', blurb: 'Follow the vermilion torii gates into the wooded hillside. Leave a little room to explore.' },
  kiyomizu: { name: 'Kiyomizu-dera', cat: 'attr', x: 66, y: 61, area: 'Higashiyama', typical: '1–2 h', blurb: 'A hillside temple with a wooden stage overlooking the city. Pair it with the lanes below.' },
  sannenzaka: { name: 'Sannenzaka & Ninenzaka', cat: 'attr', x: 63, y: 56, area: 'Higashiyama', typical: '1 h', blurb: 'Stone-paved lanes, small shops and teahouses below Kiyomizu-dera.' },
  nishiki: { name: 'Nishiki Market', cat: 'food', x: 46, y: 47, area: 'Downtown', typical: '1–1.5 h', blurb: 'Browse the covered market and leave time for a leisurely grazing lunch.' },
  gion: { name: 'Gion & Hanamikoji', cat: 'attr', x: 60, y: 51, area: 'Gion', typical: '1 h', blurb: 'Explore the historic streets and wooden machiya townhouses of Gion.' },
  pontocho: { name: 'Dinner in Pontochō', cat: 'food', x: 54, y: 45, area: 'Pontochō', typical: '1.5 h', blurb: 'An evening meal along the narrow restaurant-lined alley. This is a sample dinner reservation.' },
  bamboo: { name: 'Arashiyama Bamboo Grove', cat: 'attr', x: 7, y: 40, area: 'Arashiyama', typical: '45 min–1 h', blurb: 'A walk beneath tall bamboo on the western edge of Kyoto.' },
  tenryuji: { name: 'Tenryū-ji', cat: 'attr', x: 10, y: 45, area: 'Arashiyama', typical: '1–1.5 h', blurb: 'A Zen temple with a landscape garden framed by the surrounding hills.' },
  arashilunch: { name: 'Lunch in Arashiyama', cat: 'food', x: 14, y: 48, area: 'Arashiyama', typical: '1 h', blurb: 'Save a break for tofu or noodles near the station. Choose a restaurant as your plans take shape.' },
  kinkakuji: { name: 'Kinkaku-ji', cat: 'attr', x: 31, y: 16, area: 'Kita', typical: '1 h', blurb: 'A gold-leaf pavilion reflected in a pond, surrounded by landscaped grounds.' },
  tea: { name: 'Tea ceremony', cat: 'custom', x: 41, y: 37, area: 'Central Kyoto · sample location', typical: '1.5 h', blurb: 'A sample booked experience. Transit estimates are unavailable for this custom location.', noTransit: true },
  heian: { name: 'Heian Shrine', cat: 'attr', x: 65, y: 38, area: 'Okazaki', typical: '45 min', blurb: 'A shrine with a large torii and gardens, close to the museums of Okazaki.' },
  ginkakuji: { name: 'Ginkaku-ji', cat: 'attr', x: 75, y: 27, area: 'Sakyō', typical: '1 h', blurb: 'The Silver Pavilion, with sand gardens and moss-covered paths.' },
  nanzenji: { name: 'Nanzen-ji', cat: 'attr', x: 70, y: 44, area: 'Okazaki', typical: '1 h', blurb: 'A spacious temple complex with a distinctive brick aqueduct.' },
  philosopher: { name: 'Philosopher’s Path', cat: 'attr', x: 73, y: 34, area: 'Sakyō', typical: '45 min', blurb: 'A canal-side stroll linking the northern Higashiyama neighbourhoods.' },
  nijo: { name: 'Nijō Castle', cat: 'attr', x: 38, y: 43, area: 'Nakagyō', typical: '1.5 h', blurb: 'Explore the palace rooms, ornamental gates and gardens of this historic castle.' },
  railway: { name: 'Kyoto Railway Museum', cat: 'attr', x: 41, y: 73, area: 'Shimogyō', typical: '2 h', blurb: 'Steam engines and modern trains in the Kyoto Station area.' },
  tofukuji: { name: 'Tōfuku-ji', cat: 'attr', x: 59, y: 81, area: 'Higashiyama', typical: '1 h', blurb: 'A Zen temple with gardens, covered walkways and wooded grounds.' },
  sanjusangendo: { name: 'Sanjūsangen-dō', cat: 'attr', x: 60, y: 66, area: 'Higashiyama', typical: '45 min', blurb: 'A long temple hall housing rows of Kannon statues.' },
  yasaka: { name: 'Yasaka Shrine', cat: 'attr', x: 63, y: 50, area: 'Gion', typical: '30 min', blurb: 'A landmark shrine at the eastern end of Shijō-dōri, close to Gion.' },
  palace: { name: 'Kyoto Imperial Palace', cat: 'attr', x: 51, y: 25, area: 'Kamigyō', typical: '1 h', blurb: 'A former imperial residence set within a large central park.' },
  ramen: { name: 'Kyoto Ramen Kōji', cat: 'food', x: 51, y: 75, area: 'Kyoto Station', typical: '45 min', blurb: 'A collection of ramen counters inside the station building.' },
  demachi: { name: 'Demachi Masugata Shopping Street', cat: 'food', x: 55, y: 18, area: 'Kamigyō', typical: '45 min', blurb: 'A covered neighbourhood shopping street with snacks and sweets.' },
};

export const PLACES: Record<string, Place> = Object.fromEntries(
  Object.entries(placeData).map(([id, place]) => [id, { id, ...place }]),
);

export function seedTrip(): Trip {
  return {
    id: 'kyoto-spring', name: 'Kyoto in spring', destination: 'Kyoto, Japan',
    startDate: '2027-05-14', timezone: 'Asia/Tokyo',
    ideas: ['nijo', 'railway', 'tofukuji'], customPlaces: {},
    days: [
      { id: 'd1', label: 'Day 1', date: 'Fri 14', title: 'Fushimi & Higashiyama', endMode: 'transit', items: [
        { aid: 'a1', placeId: 'fushimi', duration: 120, fixed: null, mode: 'transit', note: 'Start early and leave time to wander along the upper trail.' },
        { aid: 'a2', placeId: 'kiyomizu', duration: 90, fixed: null, mode: 'transit', note: 'Take in the city views from the wooden stage.' },
        { aid: 'a3', placeId: 'sannenzaka', duration: 60, fixed: null, mode: 'walk', note: '' },
        { aid: 'a4', placeId: 'nishiki', duration: 75, fixed: null, mode: 'walk', note: 'Graze for lunch. Leave room for something sweet.' },
        { aid: 'a5', placeId: 'gion', duration: 60, fixed: null, mode: 'walk', note: '' },
        { aid: 'a6', placeId: 'pontocho', duration: 90, fixed: 1110, mode: 'walk', note: 'Sample booking · table for 2 at 18:30.' },
      ] },
      { id: 'd2', label: 'Day 2', date: 'Sat 15', title: 'Arashiyama & Kinkaku-ji', endMode: 'drive', items: [
        { aid: 'b1', placeId: 'bamboo', duration: 60, fixed: null, mode: 'transit', note: '' },
        { aid: 'b2', placeId: 'tenryuji', duration: 75, fixed: null, mode: 'walk', note: '' },
        { aid: 'b3', placeId: 'arashilunch', duration: 60, fixed: null, mode: 'walk', note: '' },
        { aid: 'b4', placeId: 'kinkakuji', duration: 60, fixed: null, mode: 'transit', note: '' },
        { aid: 'b5', placeId: 'tea', duration: 90, fixed: 900, mode: 'transit', note: 'Sample booking at 15:00. Confirm the address and journey before travelling.' },
      ] },
      { id: 'd3', label: 'Day 3', date: 'Sun 16', title: 'Northern Higashiyama', endMode: 'drive', items: [
        { aid: 'c1', placeId: 'heian', duration: 45, fixed: null, mode: 'drive', note: '' },
        { aid: 'c2', placeId: 'ginkakuji', duration: 60, fixed: null, mode: 'walk', note: '' },
        { aid: 'c3', placeId: 'nanzenji', duration: 60, fixed: null, mode: 'walk', note: '' },
        { aid: 'c4', placeId: 'philosopher', duration: 45, fixed: null, mode: 'walk', note: '' },
      ] },
    ],
  };
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: unknown): value is string => typeof value === 'string'
  && datePattern.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

/** Work in UTC so adding days is independent of local daylight-saving changes. */
function dateAt(startDate: string, index: number): Date | null {
  if (!validDate(startDate) || !Number.isInteger(index) || index < 0) return null;
  const date = new Date(`${startDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + index);
  if (!Number.isFinite(date.getTime()) || !validDate(date.toISOString().slice(0, 10))) return null;
  return date;
}

function emptyDay(index: number, date: Date, id = `day-${index + 1}`): Day {
  return {
    id, label: `Day ${index + 1}`,
    date: `${date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${date.getUTCDate()}`,
    title: 'A day to discover', endMode: 'walk', startTime: 540, finishBy: null,
    startPlaceId: 'hotel', endPlaceId: 'hotel', items: [],
  };
}

let nextTrip = 0;
export function createTrip(name: string, destination: string, startDate: string, dayCount: number): Trip {
  if (!name.trim() || !destination.trim() || name.length > 160 || destination.length > 160) {
    throw new Error('Give your trip a name and a destination (up to 160 characters each).');
  }
  if (!validDate(startDate)) throw new Error('Choose a valid start date.');
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > MAX_TRIP_DAYS) throw new Error(`Choose between 1 and ${MAX_TRIP_DAYS} days.`);
  if (!dateAt(startDate, dayCount - 1)) throw new Error('The trip end date must be a valid calendar date.');
  return {
    id: `trip-${Date.now().toString(36)}-${++nextTrip}`,
    name: name.trim(), destination: destination.trim(), startDate,
    timezone: /kyoto/i.test(destination) ? 'Asia/Tokyo' : 'UTC',
    days: Array.from({ length: dayCount }, (_, index) => emptyDay(index, dateAt(startDate, index)!)),
    ideas: [],
    customPlaces: {
      hotel: { id: 'hotel', name: 'Your stay', cat: 'custom', x: 50, y: 72, area: destination.trim(), typical: '', blurb: 'Choose your hotel or another base. Days start and finish here unless you choose another place.' },
    },
  };
}

/** Extend a trip without changing any existing days, places or reservations. */
export function appendTripDays(trip: Trip, count: number): Trip {
  if (!Number.isInteger(count) || count < 1) throw new Error('Choose a whole number of days to add.');
  if (!isTrip(trip)) throw new Error('Cannot add days to an invalid trip.');
  if (trip.days.length + count > MAX_TRIP_DAYS) throw new Error(`A trip can have up to ${MAX_TRIP_DAYS} days.`);
  if (!dateAt(trip.startDate, trip.days.length + count - 1)) throw new Error('The trip end date must be a valid calendar date.');
  const usedIds = new Set(trip.days.map(day => day.id));
  const added = Array.from({ length: count }, (_, offset) => {
    const index = trip.days.length + offset;
    const baseId = `day-${index + 1}`;
    let id = baseId;
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    usedIds.add(id);
    return emptyDay(index, dateAt(trip.startDate, index)!, id);
  });
  return { ...trip, days: [...trip.days, ...added] };
}

export function getPlaces(trip: Trip): Record<string, Place> {
  return { ...PLACES, ...trip.customPlaces };
}

export function dayStartTime(day: Day): number { return day.startTime ?? 540; }

export function dayStartPlace(day: Day, places: Record<string, Place>): Place {
  const place = places[day.startPlaceId ?? 'hotel'];
  if (!place) throw new Error('Choose a valid starting point for this day.');
  return place;
}

export function dayEndPlace(day: Day, places: Record<string, Place>): Place {
  const place = places[day.endPlaceId ?? 'hotel'];
  if (!place) throw new Error('Choose a valid end point for this day.');
  return place;
}

/** Empty arrival/departure days can still contain a direct transfer. */
export function hasEndJourney(day: Day): boolean {
  return day.endMode === 'flight' || day.items.length > 0 || (day.startPlaceId ?? 'hotel') !== (day.endPlaceId ?? 'hotel');
}

/** Keep provider IDs and user planning data; fetch Google place details again per session. */
export function persistableTrip(trip: Trip): Trip {
  return {
    ...trip,
    days: trip.days.map(day => ({ ...day, items: day.items.map(item => ({ ...item })) })),
    ideas: [...trip.ideas],
    customPlaces: Object.fromEntries(Object.entries(trip.customPlaces).map(([id, place]) => [
      id,
      place.googlePlaceId ? {
        id,
        name: id === 'hotel' ? 'Your stay' : 'Saved place',
        cat: place.cat,
        x: 50,
        y: 50,
        area: '',
        typical: place.typical,
        blurb: '',
        googlePlaceId: place.googlePlaceId,
        ...(place.userLabel !== undefined ? { userLabel: place.userLabel } : {}),
        ...(place.userNotes !== undefined ? { userNotes: place.userNotes } : {}),
        ...(place.lastEntryMinutes !== undefined ? { lastEntryMinutes: { ...place.lastEntryMinutes } } : {}),
        ...(place.offlineDetails !== undefined ? {offlineDetails:{name:place.offlineDetails.name,...(place.offlineDetails.address!==undefined?{address:place.offlineDetails.address}:{}),...(place.offlineDetails.localAddress!==undefined?{localAddress:place.offlineDetails.localAddress}:{}),...(place.offlineDetails.hours!==undefined?{hours:place.offlineDetails.hours}:{})}} : {}),
      } : { ...place },
    ])),
  };
}

export function formatTime(min: number): string {
  if (!Number.isFinite(min)) return '—';
  const rounded = Math.max(0, Math.round(min));
  const days = Math.floor(rounded / 1440);
  const hour = Math.floor(rounded / 60) % 24;
  return `${String(hour).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}${days ? ` +${days}d` : ''}`;
}

export function formatDuration(min: number): string {
  if (!Number.isFinite(min)) return '—';
  const rounded = Math.max(0, Math.round(min));
  const hours = Math.floor(rounded / 60);
  return hours ? `${hours} h${rounded % 60 ? ` ${rounded % 60} min` : ''}` : `${rounded} min`;
}

/** Illustrative straight-line estimates only; these are not live directions. */
export function travel(a: Place, b: Place, mode: Mode): Journey {
  if (mode === 'flight') return { min: null, km: '—', mode, status: 'unavailable', reason: 'Link a flight booking to confirm this journey.' };
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  const min = distance < 0.5 ? 0
    : mode === 'walk' ? Math.max(2, Math.round(distance * 1.45))
      : mode === 'drive' ? Math.round(4 + distance * 0.4)
        : a.noTransit || b.noTransit ? null : Math.round(6 + distance * 0.55);
  return { min, km: (distance * 0.12).toFixed(1), mode };
}

export interface ScheduleRow {
  it: Activity;
  pl: Place;
  leg: Journey;
  /** Earliest arrival when approx is true. */
  arrive: number;
  /** Booked start and end stay visible even when arrival is late. */
  start: number;
  end: number;
  /** Earliest feasible end, carried into the following journey. */
  physicalEnd: number;
  wait: number;
  late: number;
  approx: boolean;
  flight?: FlightSegment;
  freeTime?: ScheduledFreeTime;
  /** Place-local hours window, converted after crossing zones by flight. */
  visitWindow?: { date: string; start: number; end: number; approx: boolean };
}

export function scheduleVisitWindow(row: ScheduleRow, date: string): { date: string; start: number; end: number; approx: boolean } {
  return row.visitWindow ?? { date, start: Math.max(row.start, row.arrive), end: row.physicalEnd, approx: row.approx };
}

export interface ScheduleContext { trip: Trip; dayIndex: number }
export interface ScheduleResult {
  rows: ScheduleRow[];
  endLeg: Journey;
  travel: number;
  unknown: number;
  late: number;
  wait: number;
  finish: number;
  finishApprox: boolean;
}
/** Core pass used by opening-hours and free-time solvers. Visit ends remain visit-only. */
export function scheduleRaw(day: Day, places: Record<string, Place>, legs?: Record<string, Journey>, context?: ScheduleContext,
  freeDurations: Record<string, number> = {}): ScheduleResult {
  const destination = dayEndPlace(day, places);
  const incomingIssue = context ? incomingFlightStartIssue(context.trip, context.dayIndex) : null;
  const journey = (key: string, from: Place, to: Place, mode: Mode, flightId?: string): Journey => {
    if (mode === 'flight') return context ? flightJourney(context.trip.flights?.find(flight => flight.id === flightId), from.id, to.id)
      : { min: null, km: '—', mode, status: 'unavailable', reason: 'Flight booking context is needed to calculate this schedule.' };
    if (incomingIssue) return { min: null, km: '—', mode, status: 'unavailable', reason: incomingIssue };
    if (legs === undefined) return travel(from, to, mode);
    const leg = Object.hasOwn(legs, key) ? legs[key] : undefined;
    if (!leg || leg.mode !== mode) return { min: null, km: '—', mode, status: 'loading', reason: 'Calculating this journey.' };
    // Loading, unavailable or invalid values must never enter the itinerary as known minutes.
    if (leg.status === 'loading' || leg.status === 'unavailable') return { ...leg, min: null };
    if (leg.min !== null && (!Number.isFinite(leg.min) || leg.min < 0)) {
      return { min: null, km: '—', mode, status: 'unavailable', reason: 'A travel estimate is unavailable.' };
    }
    return leg;
  };
  let time = dayStartTime(day);
  let previous = dayStartPlace(day, places);
  let travelMinutes = 0;
  let unknown = 0;
  let late = 0;
  let wait = 0;
  let uncertain = Boolean(incomingIssue);
  const scheduleDate = context ? bookingDayDate(context.trip, context.dayIndex) : '';
  const scheduleZone = context ? dayTimezone(context.trip, day) : '';
  let placeZone = scheduleZone;
  let physicalInstant = context ? instantAtDayMinutes(scheduleDate, time, scheduleZone) : null;
  let previousArrivalInstant = physicalInstant;
  let previousArrivalMinutes = time;
  const addFreeTime = (row: ScheduleRow): ScheduleRow => {
    const free = row.it.freeTime;
    if (!free) return row;
    const duration = freeDurations[free.id] ?? free.duration;
    const start = row.physicalEnd;
    if (physicalInstant !== null) physicalInstant += duration * 60000;
    const end = physicalInstant !== null && context ? dayMinutesAt(physicalInstant, scheduleDate, scheduleZone) : start + duration;
    row.freeTime = { ...free, requestedDuration: free.duration, start, end, duration, approx: row.approx };
    time = end;
    return row;
  };
  const rows = day.items.map((it): ScheduleRow => {
    const pl = places[it.placeId];
    if (!pl) throw new Error(`Unknown place: ${it.placeId}`);
    const leg = journey(it.aid, previous, pl, it.mode, it.flightId);
    if (leg.min === null) { unknown += 1; uncertain = true; }
    else travelMinutes += leg.min;
    if (leg.flight && context) {
      const date = bookingDayDate(context.trip, context.dayIndex), timezone = dayTimezone(context.trip, day);
      const departure = dayMinutesAt(leg.flight.departureMs, date, timezone);
      const arrival = dayMinutesAt(leg.flight.arrivalMs, date, timezone);
      const ready = dayMinutesAt(leg.flight.arrivalReadyMs, date, timezone);
      const airportGoal = dayMinutesAt(leg.flight.departureGoalMs, date, timezone);
      const arrivalDelay = previousArrivalInstant !== null ? (previousArrivalInstant - leg.flight.departureGoalMs) / 60000 : previousArrivalMinutes - airportGoal;
      const departureDelay = physicalInstant !== null ? (physicalInstant - leg.flight.departureMs) / 60000 : time - departure;
      const rowLate = Math.max(0, departureDelay, arrivalDelay), rowWait = uncertain ? 0 : Math.max(0, -departureDelay);
      if (rowLate > 0) leg.warning = 'This plan misses the flight’s airport arrival goal or departure. Review the transfer and airport buffer.';
      if (rowLate > 0) uncertain = true;
      const row: ScheduleRow = { it, pl, leg, arrive: arrival, start: arrival, end: ready + it.duration,
        physicalEnd: ready + it.duration, wait: rowWait, late: rowLate, approx: uncertain,
        flight: context.trip.flights?.find(flight => flight.id === it.flightId) };
      physicalInstant = leg.flight.arrivalReadyMs + it.duration * 60000;
      previousArrivalInstant = leg.flight.arrivalReadyMs;
      previousArrivalMinutes = ready;
      placeZone = row.flight?.arrival.timezone ?? scheduleZone;
      time = row.physicalEnd; previous = pl; late += rowLate; wait += rowWait;
      return addFreeTime(row);
    }
    let arrive = time + (leg.min ?? 0);
    let start = it.fixed ?? arrive;
    let rowLate = it.fixed === null ? 0 : Math.max(0, arrive - it.fixed);
    // An unknown journey has no upper bound; spare time does not prove arrival on time.
    let rowWait = it.fixed === null || uncertain ? 0 : Math.max(0, it.fixed - arrive);
    const anchorFlight = context?.trip.flights?.find(flight => flight.id === it.departureForFlightId);
    const duration = anchorFlight ? anchorFlight.airportBufferMinutes ?? 120 : it.duration;
    let physicalEnd = Math.max(arrive, start) + duration;
    let bookedEnd = start + duration;
    let visitWindow: ScheduleRow['visitWindow'];
    if (context && physicalInstant !== null && leg.min !== null) {
      const arrivalInstant = physicalInstant + leg.min * 60000;
      previousArrivalInstant = arrivalInstant;
      const startInstant = it.fixed === null ? arrivalInstant : instantAtDayMinutes(scheduleDate, it.fixed, scheduleZone);
      if (startInstant !== null) {
        const visitStart = Math.max(arrivalInstant, startInstant);
        physicalInstant = visitStart + duration * 60000;
        arrive = dayMinutesAt(arrivalInstant, scheduleDate, scheduleZone);
        start = dayMinutesAt(startInstant, scheduleDate, scheduleZone);
        physicalEnd = dayMinutesAt(physicalInstant, scheduleDate, scheduleZone);
        bookedEnd = dayMinutesAt(startInstant + duration * 60000, scheduleDate, scheduleZone);
        rowLate = it.fixed === null ? 0 : Math.max(0, (arrivalInstant - startInstant) / 60000);
        rowWait = it.fixed === null || uncertain ? 0 : Math.max(0, (startInstant - arrivalInstant) / 60000);
        const visitDate = localDateAt(visitStart, placeZone);
        visitWindow = { date: visitDate, start: dayMinutesAt(visitStart, visitDate, placeZone),
          end: dayMinutesAt(physicalInstant, visitDate, placeZone), approx: uncertain };
      } else { physicalInstant = null; uncertain = true; }
    } else { physicalInstant = null; previousArrivalInstant = null; }
    previousArrivalMinutes = arrive;
    const row: ScheduleRow = {
      it, pl, leg, arrive, start, end: bookedEnd, physicalEnd,
      wait: rowWait, late: rowLate, approx: uncertain, ...(visitWindow ? { visitWindow } : {}),
    };
    time = physicalEnd;
    previous = pl;
    late += rowLate;
    wait += rowWait;
    return addFreeTime(row);
  });
  const endLeg: Journey = hasEndJourney(day)
    ? journey('return', previous, destination, day.endMode, day.endFlightId)
    : { min: 0, km: '0.0', mode: day.endMode, status: 'ready' };
  if (endLeg.min === null) { unknown += 1; uncertain = true; }
  else travelMinutes += endLeg.min;
  let finish = time + (endLeg.min ?? 0);
  if (context && physicalInstant !== null && endLeg.min !== null) finish = dayMinutesAt(physicalInstant + endLeg.min * 60000, scheduleDate, scheduleZone);
  if (endLeg.flight && context) {
    const date = bookingDayDate(context.trip, context.dayIndex), timezone = dayTimezone(context.trip, day);
    const departure = dayMinutesAt(endLeg.flight.departureMs, date, timezone);
    const goal = dayMinutesAt(endLeg.flight.departureGoalMs, date, timezone);
    const arrivalDelay = previousArrivalInstant !== null ? (previousArrivalInstant - endLeg.flight.departureGoalMs) / 60000 : previousArrivalMinutes - goal;
    const departureDelay = physicalInstant !== null ? (physicalInstant - endLeg.flight.departureMs) / 60000 : time - departure;
    const missed = Math.max(0, departureDelay, arrivalDelay);
    if (missed > 0) endLeg.warning = 'This plan misses the flight’s airport arrival goal or departure. Review the transfer and airport buffer.';
    late += missed; wait += uncertain ? 0 : Math.max(0, -departureDelay);
    if (missed) uncertain = true;
    finish = dayMinutesAt(endLeg.flight.arrivalReadyMs, date, timezone);
  }
  return { rows, endLeg, travel: travelMinutes, unknown, late, wait, finish, finishApprox: uncertain };
}

/** Locate an actual booking, excluding opening-hour waits used during calculation. */
export function nextFreeTimeBooking(day: Day, afterIndex: number): { index: number; id: string } | null {
  const index = day.items.findIndex((item, i) => i > afterIndex && (item.fixed !== null || item.mode === 'flight' || Boolean(item.departureForFlightId)));
  return index >= 0 ? { index, id: day.items[index].aid }
    : day.endMode === 'flight' && day.endFlightId ? { index: day.items.length, id: day.endFlightId } : null;
}
/** Fill spare time only when known journeys prove the next booking stays reachable.
 * Re-run the full clock for each candidate so opening waits, zones and flights agree.
 */
export function resolveFreeTimeSchedule<T extends ScheduleResult>(day: Day, calculate: (durations: Record<string, number>) => T,
  safe: (before: T, after: T, from: number, through: number) => boolean = () => true): T {
  const durations: Record<string, number> = {};
  day.items.forEach(item => { if (item.freeTime) durations[item.freeTime.id] = item.freeTime.untilBooking ? 0 : item.freeTime.duration; });
  let result = calculate(durations);
  const annotations = new Map<string, Pick<ScheduledFreeTime, 'bookingId' | 'bookingName' | 'warning' | 'approx'>>();
  day.items.forEach((item, index) => {
    const free = item.freeTime;
    if (!free?.untilBooking) return;
    const target = nextFreeTimeBooking(day, index), row = result.rows[index];
    if (!target) {
      durations[free.id] = free.duration;
      annotations.set(free.id, { approx: row.approx, warning: 'No upcoming booking. Using your chosen length.' });
      result = calculate(durations); return;
    }
    const booking = result.rows[target.index];
    const metadata = { bookingId: target.id, bookingName: booking?.pl.name ?? 'your flight' };
    const affected = result.rows.slice(index, target.index + 1);
    if (affected.some(value => value.approx || value.leg.min === null)
      || target.index === day.items.length && (result.endLeg.min === null || result.finishApprox)) {
      durations[free.id] = free.duration;
      annotations.set(free.id, { ...metadata, approx: true, warning: 'Confirm travel times to know how much free time fits.' });
      result = calculate(durations); return;
    }
    const baseline = result;
    const allowed = (candidate: T) => candidate.rows.slice(index + 1, target.index + 1).every((value, offset) =>
      !value.approx && value.late <= baseline.rows[index + 1 + offset].late)
      && (target.index < day.items.length || !candidate.finishApprox && candidate.late <= baseline.late)
      && safe(baseline, candidate, index, target.index);
    // A missed booking cannot become spare time simply because extra minutes do not
    // increase a pre-existing warning (for example an already missed flight).
    const alreadyLate = affected.slice(1).some(value => value.late > 0);
    let low = 0, high = alreadyLate ? 0 : 720;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = calculate({ ...durations, [free.id]: mid });
      if (allowed(candidate)) low = mid; else high = mid - 1;
    }
    durations[free.id] = low;
    annotations.set(free.id, { ...metadata, approx: false,
      ...(low < 10 ? { warning: low === 0 ? 'No free time remains before this booking.' : 'Less than 10 minutes of free time remain.' } : {}) });
    result = calculate(durations);
  });
  return { ...result, rows: result.rows.map(row => row.freeTime ? { ...row, freeTime: { ...row.freeTime, ...annotations.get(row.freeTime.id) } } : row) };
}
export function schedule(day: Day, places: Record<string, Place>, legs?: Record<string, Journey>, context?: ScheduleContext): ScheduleResult {
  if (!day.items.some(item => item.freeTime?.untilBooking)) return scheduleRaw(day, places, legs, context);
  return resolveFreeTimeSchedule(day, durations => scheduleRaw(day, places, legs, context, durations));
}

/** Enumerates at most 8! alternatives; bookings split the day into uncrossable runs. */
export function proposeOrder(day: Day, places: Record<string, Place>, legs?: Record<string, Journey>): {
  items: Activity[]; before: number; after: number; saved: number;
} | null {
  // Incoming legs only describe the current order. Reordering real places needs new route
  // requests; the sample straight-line estimator cannot establish an improvement.
  if (dayHasFlight(day) || legs !== undefined || [dayStartPlace(day, places), dayEndPlace(day, places), ...day.items.map(item => places[item.placeId])]
    .some(place => place && (place.googlePlaceId !== undefined || place.lat !== undefined || place.lng !== undefined))) return null;
  const flexibleCount = day.items.filter(item => item.fixed === null).length;
  if (day.endMode === 'transit' || day.items.some(item => item.mode === 'transit')
    || flexibleCount < 2 || flexibleCount > 8) return null;
  const baseline = schedule(day, places);
  const baselineById = new Map(baseline.rows.map(row => [row.it.aid, row]));
  const runs: number[][] = [];
  let current: number[] = [];
  day.items.forEach((item, index) => {
    if (item.fixed === null) current.push(index);
    else { if (current.length > 1) runs.push(current); current = []; }
  });
  if (current.length > 1) runs.push(current);
  if (!runs.length) return null;
  let bestItems: Activity[] | null = null;
  let bestTravel = baseline.travel;
  const candidate = day.items.map(item => ({ ...item }));

  function inspect() {
    const result = schedule({ ...day, items: candidate }, places);
    if (result.travel >= bestTravel || result.unknown > baseline.unknown || result.finish > baseline.finish) return;
    if (result.rows.some(row => {
      const old = baselineById.get(row.it.aid)!;
      return row.late > old.late || (row.approx && !old.approx);
    })) return;
    bestTravel = result.travel;
    bestItems = candidate.map(item => ({ ...item }));
  }

  function visitRun(runIndex: number) {
    if (runIndex === runs.length) { inspect(); return; }
    const slots = runs[runIndex];
    const remaining = slots.map(index => day.items[index]);
    function permute(offset: number) {
      if (offset === slots.length) { visitRun(runIndex + 1); return; }
      for (let index = offset; index < remaining.length; index += 1) {
        [remaining[offset], remaining[index]] = [remaining[index], remaining[offset]];
        // Transport is a choice for this journey slot, not a property of a place.
        candidate[slots[offset]] = { ...remaining[offset], mode: day.items[slots[offset]].mode };
        permute(offset + 1);
        [remaining[offset], remaining[index]] = [remaining[index], remaining[offset]];
      }
    }
    permute(0);
  }
  visitRun(0);
  if (!bestItems || baseline.travel - bestTravel < 2) return null;
  return { items: bestItems, before: baseline.travel, after: bestTravel, saved: baseline.travel - bestTravel };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isText = (value: unknown, max: number, nonempty = false): value is string => typeof value === 'string'
  && value.length <= max && (!nonempty || value.trim().length > 0);
const isId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const isMode = (value: unknown): value is Mode => value === 'walk' || value === 'drive' || value === 'transit' || value === 'flight';
const isInteger = (value: unknown, min: number, max: number): value is number => typeof value === 'number'
  && Number.isInteger(value) && value >= min && value <= max;
const isCoordinate = (value: unknown, min: number, max: number): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= min && value <= max;
const isHttpsURL = (value: unknown): value is string => {
  if (!isText(value, 2048, true) || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
};
const isGooglePlaceId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9_-]{1,512}$/.test(value);

/** Validate untrusted saved/exported JSON before using any nested fields. */
export function isTrip(value: unknown): value is Trip {
  if (!isRecord(value) || !isId(value.id) || !isText(value.name, 160, true)
    || !isText(value.destination, 160, true) || !validDate(value.startDate)
    || !isText(value.timezone, 100, true) || !Array.isArray(value.days)
    || value.days.length < 1 || value.days.length > MAX_TRIP_DAYS || !Array.isArray(value.ideas)
    || value.ideas.length > 500 || !isRecord(value.customPlaces)) return false;
  if (value.pace !== undefined && !['relaxed','moderate','active'].includes(String(value.pace))) return false;
  if (!dateAt(value.startDate, value.days.length - 1)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch { return false; }
  const entries = Object.entries(value.customPlaces);
  if (entries.length > 500) return false;
  for (const [id, place] of entries) {
    if (!isId(id) || !isRecord(place) || place.id !== id || !isText(place.name, 160, true)
      || !['attr', 'food', 'custom'].includes(String(place.cat))
      || typeof place.x !== 'number' || !Number.isFinite(place.x) || place.x < 0 || place.x > 100
      || typeof place.y !== 'number' || !Number.isFinite(place.y) || place.y < 0 || place.y > 100
      || !isText(place.area, 300) || !isText(place.typical, 100) || !isText(place.blurb, 4000)
      || (place.noTransit !== undefined && typeof place.noTransit !== 'boolean')) return false;
    if ((place.lat !== undefined || place.lng !== undefined)
      && (!isCoordinate(place.lat, -90, 90) || !isCoordinate(place.lng, -180, 180))) return false;
    if ((place.googlePlaceId !== undefined && !isGooglePlaceId(place.googlePlaceId))
      || (place.googleMapsURI !== undefined && !isHttpsURL(place.googleMapsURI))
      || (place.userLabel !== undefined && !isText(place.userLabel, 160))
      || (place.userNotes !== undefined && !isText(place.userNotes, 4000))) return false;
    if (place.offlineDetails !== undefined && (!isRecord(place.offlineDetails)
      || Object.keys(place.offlineDetails).some(key=>!['name','address','localAddress','hours'].includes(key))
      || !isText(place.offlineDetails.name,200,true)
      || (place.offlineDetails.address !== undefined && !isText(place.offlineDetails.address,500))
      || (place.offlineDetails.localAddress !== undefined && !isText(place.offlineDetails.localAddress,500))
      || (place.offlineDetails.hours !== undefined && !isText(place.offlineDetails.hours,1000)))) return false;
    if (place.lastEntryMinutes !== undefined && (!isRecord(place.lastEntryMinutes)
      || Object.entries(place.lastEntryMinutes).some(([day, minute]) => !/^[0-6]$/.test(day)
        || !Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 1439))) return false;
    if (place.attributions !== undefined && (!Array.isArray(place.attributions)
      || place.attributions.length > 100
      || place.attributions.some(attribution => !isRecord(attribution)
        || !isText(attribution.provider, 300, true)
        || (attribution.providerURI !== undefined && !isHttpsURL(attribution.providerURI))))) return false;
    // The starting point can be customised; sample place IDs cannot be overwritten on import.
    if (id !== 'hotel' && Object.hasOwn(PLACES, id)) return false;
  }
  const knownPlace = (id: unknown) => isId(id) && (Object.hasOwn(PLACES, id) || Object.hasOwn(value.customPlaces as object, id));
  if (value.flights !== undefined && (!Array.isArray(value.flights) || value.flights.length > 100
    || value.flights.some(flight => !isFlight(flight) || !knownPlace(flight.fromPlaceId) || !knownPlace(flight.toPlaceId))
    || new Set(value.flights.map(flight => flight.id)).size !== value.flights.length)) return false;
  if (value.stays !== undefined && (!Array.isArray(value.stays) || value.stays.length > 100
    || value.stays.some(stay => !isStay(stay) || !knownPlace(stay.placeId))
    || new Set(value.stays.map(stay => stay.id)).size !== value.stays.length)) return false;
  const flights = new Map((value.flights as FlightSegment[] | undefined)?.map(flight => [flight.id, flight]) ?? []);
  const stays = new Map((value.stays as AccommodationBooking[] | undefined)?.map(stay => [stay.id, stay]) ?? []);
  const linkedFlights = new Set<string>();
  const validFlightLink = (id: unknown, from: unknown, to: unknown) => {
    if (!isId(id) || linkedFlights.has(id)) return false;
    const flight = flights.get(id);
    if (!flight || flight.fromPlaceId !== from || flight.toPlaceId !== to) return false;
    linkedFlights.add(id); return true;
  };
  if (value.ideas.some(id => !knownPlace(id) || id === 'hotel') || new Set(value.ideas).size !== value.ideas.length) return false;
  const dayIds = new Set<string>();
  const activityIds = new Set<string>();
  const freeTimeIds = new Set<string>();
  for (const day of value.days) {
    if (!isRecord(day) || !isId(day.id) || dayIds.has(day.id) || !isText(day.label, 80, true)
      || !isText(day.date, 80, true) || !isText(day.title, 160) || !isMode(day.endMode)
      || !Array.isArray(day.items) || day.items.length > 100) return false;
    if (day.pace !== undefined && !['relaxed','moderate','active'].includes(String(day.pace))) return false;
    if ((day.startTime !== undefined && !isInteger(day.startTime, 0, 1439))
      || (day.timezone !== undefined && !isTimezone(day.timezone))
      || (day.startPlaceId !== undefined && !knownPlace(day.startPlaceId))
      || (day.endPlaceId !== undefined && !knownPlace(day.endPlaceId))
      || (day.finishBy !== undefined && day.finishBy !== null
        && (!isInteger(day.finishBy, 0, 1439) || day.finishBy <= (day.startTime ?? 540)))) return false;
    if (day.startStayId !== undefined && (!isId(day.startStayId) || stays.get(day.startStayId)?.placeId !== (day.startPlaceId ?? 'hotel'))) return false;
    if (day.endStayId !== undefined && (!isId(day.endStayId) || stays.get(day.endStayId)?.placeId !== (day.endPlaceId ?? 'hotel'))) return false;
    dayIds.add(day.id);
    let previousId: unknown = day.startPlaceId ?? 'hotel';
    for (const item of day.items) {
      if (!isRecord(item) || !isId(item.aid) || activityIds.has(item.aid)
        || !knownPlace(item.placeId) || item.placeId === 'hotel'
        || !isInteger(item.duration, item.mode === 'flight' ? 0 : 5, 1440)
        || (item.fixed !== null && !isInteger(item.fixed, 0, 1439))
        || !isMode(item.mode) || !isText(item.note, 8000)) return false;
      if ((item.meal !== undefined && !['meal','snack','none'].includes(String(item.meal)))
        || (item.walkingMeters !== undefined && !isInteger(item.walkingMeters,0,100000))
        || (item.exposure !== undefined && !['indoor','outdoor','mixed','unknown'].includes(String(item.exposure)))) return false;
      if (item.freeTime !== undefined) {
        const free = item.freeTime;
        if (!isRecord(free) || !exactKeys(free, ['id','kind','duration','untilBooking'])
          || !isId(free.id) || freeTimeIds.has(free.id)
          || !['explore','rest','shopping','nothing'].includes(String(free.kind))
          || !isInteger(free.duration, 15, 720) || free.duration % 15 !== 0 || typeof free.untilBooking !== 'boolean') return false;
        freeTimeIds.add(free.id);
      }
      activityIds.add(item.aid);
      if (item.mode === 'flight' ? !validFlightLink(item.flightId, previousId, item.placeId) : item.flightId !== undefined) return false;
      if (item.departureForFlightId !== undefined && (item.mode === 'flight' || !isId(item.departureForFlightId)
        || flights.get(item.departureForFlightId)?.fromPlaceId !== item.placeId)) return false;
      previousId = item.placeId;
    }
    if (day.endMode === 'flight' ? !validFlightLink(day.endFlightId, previousId, day.endPlaceId ?? 'hotel') : day.endFlightId !== undefined) return false;
  }
  return true;
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function isTimezone(value: unknown): value is string {
  if (!isText(value, 100, true)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
export function isFlightMoment(value: unknown): value is FlightMoment {
  return isRecord(value) && exactKeys(value, ['date', 'time', 'timezone', 'offsetMinutes'])
    && validDate(value.date) && (value.time === null || (typeof value.time === 'string' && TIME_PATTERN.test(value.time)))
    && isTimezone(value.timezone) && (value.offsetMinutes === undefined || isInteger(value.offsetMinutes, -840, 840));
}
export function isFlight(value: unknown): value is FlightSegment {
  if (!isRecord(value) || !exactKeys(value, ['id','fromPlaceId','toPlaceId','departure','arrival','airline','flightNumber','departureTerminal','arrivalTerminal','departureGate','arrivalGate','bookingReference','privateNotes','airportBufferMinutes','arrivalBufferMinutes','groupId'])
    || !isId(value.id) || !isId(value.fromPlaceId) || !isId(value.toPlaceId) || value.fromPlaceId === value.toPlaceId
    || !isFlightMoment(value.departure) || !isFlightMoment(value.arrival)) return false;
  const limits: Record<string, number> = { airline: 160, flightNumber: 40, departureTerminal: 80, arrivalTerminal: 80, departureGate: 40, arrivalGate: 40, bookingReference: 160, privateNotes: 8000 };
  return Object.entries(limits).every(([key, limit]) => value[key] === undefined || isText(value[key], limit))
    && ['airportBufferMinutes', 'arrivalBufferMinutes'].every(key => value[key] === undefined || isInteger(value[key], 0, 1440))
    && (value.groupId === undefined || isId(value.groupId));
}
export function isStay(value: unknown): value is AccommodationBooking {
  if (!isRecord(value) || !exactKeys(value, ['id','placeId','checkInDate','checkOutDate','timezone','checkInTime','checkOutTime','bookingReference','contact','bookingUrl','privateNotes'])
    || !isId(value.id) || !isId(value.placeId) || !validDate(value.checkInDate) || !validDate(value.checkOutDate)
    || !isTimezone(value.timezone)) return false;
  const nights = (Date.parse(`${value.checkOutDate}T12:00:00Z`) - Date.parse(`${value.checkInDate}T12:00:00Z`)) / 86400000;
  return nights > 0 && nights <= 365
    && ['checkInTime','checkOutTime'].every(key => value[key] === undefined || (typeof value[key] === 'string' && TIME_PATTERN.test(value[key])))
    && (value.bookingReference === undefined || isText(value.bookingReference, 160))
    && (value.contact === undefined || isText(value.contact, 500))
    && (value.privateNotes === undefined || isText(value.privateNotes, 8000))
    && (value.bookingUrl === undefined || isHttpsURL(value.bookingUrl));
}

const bookingFormatters = new Map<string, Intl.DateTimeFormat>();
function wallParts(timestamp: number, timezone: string): Record<string, string> {
  let formatter = bookingFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (bookingFormatters.size >= 100) bookingFormatters.delete(bookingFormatters.keys().next().value!);
    bookingFormatters.set(timezone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
}
function wallTimestamp(timestamp: number, timezone: string): number {
  const p = wallParts(timestamp, timezone);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
}
export function localDateAt(timestamp: number, timezone: string): string {
  const p = wallParts(timestamp, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}
/** Resolve a wall clock by testing actual zone offsets; never guess during DST gaps/repeats. */
export function resolveFlightMoment(moment: FlightMoment): ResolvedFlightMoment {
  if (!isFlightMoment(moment)) return { status: 'invalid', timestamp: null, candidates: [], reason: 'Choose a valid date, local time and time zone.' };
  if (moment.time === null) return { status: 'incomplete', timestamp: null, candidates: [], reason: 'Time to confirm.' };
  const target = Date.parse(`${moment.date}T${moment.time}:00Z`);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = target + hours * 3600000;
    offsets.add((wallTimestamp(sample, moment.timezone) - sample) / 60000);
  }
  const candidates = [...offsets].flatMap(offsetMinutes => {
    const timestamp = target - offsetMinutes * 60000;
    return wallTimestamp(timestamp, moment.timezone) === target ? [{ timestamp, offsetMinutes }] : [];
  }).sort((a, b) => a.timestamp - b.timestamp);
  if (!candidates.length) return { status: 'invalid', timestamp: null, candidates, reason: 'This local time does not exist because the clocks change. Check the booking time.' };
  if (moment.offsetMinutes !== undefined) {
    const selected = candidates.find(candidate => candidate.offsetMinutes === moment.offsetMinutes);
    return selected ? { status: 'ready', timestamp: selected.timestamp, candidates }
      : { status: 'invalid', timestamp: null, candidates, reason: 'The selected UTC offset does not match this local time.' };
  }
  if (candidates.length > 1) return { status: 'ambiguous', timestamp: null, candidates, reason: 'The clocks repeat this time. Choose the UTC offset shown on your booking.' };
  return { status: 'ready', timestamp: candidates[0].timestamp, candidates };
}
export function flightTiming(flight: FlightSegment): FlightTiming {
  const departure = resolveFlightMoment(flight.departure), arrival = resolveFlightMoment(flight.arrival);
  const issues = [departure.reason ? `Departure: ${departure.reason}` : '', arrival.reason ? `Arrival: ${arrival.reason}` : ''].filter(Boolean);
  let status: FlightTiming['status'] = departure.status === 'invalid' || arrival.status === 'invalid' ? 'invalid'
    : departure.status === 'ambiguous' || arrival.status === 'ambiguous' ? 'ambiguous'
      : departure.status === 'incomplete' || arrival.status === 'incomplete' ? 'incomplete' : 'ready';
  let durationMinutes = departure.timestamp !== null && arrival.timestamp !== null ? (arrival.timestamp - departure.timestamp) / 60000 : null;
  if (durationMinutes !== null && (durationMinutes <= 0 || durationMinutes > 4320)) {
    status = 'invalid'; issues.push('Arrival must be after departure, with a flight duration no longer than 72 hours.'); durationMinutes = null;
  }
  return { status, departureMs: departure.timestamp, arrivalMs: arrival.timestamp, durationMinutes,
    departureGoalMs: departure.timestamp === null ? null : departure.timestamp - (flight.airportBufferMinutes ?? 120) * 60000,
    arrivalReadyMs: arrival.timestamp === null ? null : arrival.timestamp + (flight.arrivalBufferMinutes ?? 60) * 60000, issues };
}
export function bookingDayDate(trip: Trip, dayIndex: number): string { return dateAt(trip.startDate, dayIndex)?.toISOString().slice(0, 10) ?? ''; }
export function dayTimezone(trip: Trip, day: Day): string { return day.timezone ?? trip.timezone; }
export function dayHasFlight(day: Day): boolean { return day.endMode === 'flight' || Boolean(day.endFlightId) || day.items.some(item => item.mode === 'flight' || Boolean(item.flightId)); }
export function flightsForDay(trip: Trip, dayIndex: number): { flight: FlightSegment; departure: boolean; arrival: boolean; continuation?: boolean }[] {
  const date = bookingDayDate(trip, dayIndex);
  return (trip.flights ?? []).flatMap(flight => {
    const departure = flight.departure.date === date, arrival = flight.arrival.date === date;
    const ready = flightTiming(flight).arrivalReadyMs;
    const readyDate = ready === null ? null : localDateAt(ready, flight.arrival.timezone);
    const continuation = readyDate === date && readyDate !== flight.arrival.date;
    return departure || arrival || continuation ? [{ flight, departure, arrival, ...(continuation ? { continuation: true } : {}) }] : [];
  });
}
export function staysForDay(trip: Trip, dayIndex: number): { stay: AccommodationBooking; checkIn: boolean; checkOut: boolean; overnight: boolean }[] {
  const date = bookingDayDate(trip, dayIndex);
  return (trip.stays ?? []).flatMap(stay => date >= stay.checkInDate && date <= stay.checkOutDate
    ? [{ stay, checkIn: date === stay.checkInDate, checkOut: date === stay.checkOutDate, overnight: date < stay.checkOutDate }] : []);
}
export interface AccommodationSuggestion { dayId: string; dayIndex: number; startStayId?: string; endStayId?: string; startPlaceId?: string; endPlaceId?: string; warnings: string[] }
export function accommodationSuggestions(trip: Trip): AccommodationSuggestion[] {
  return trip.days.map((day, dayIndex) => {
    const date = bookingDayDate(trip, dayIndex), warnings: string[] = [];
    const start = (trip.stays ?? []).filter(stay => stay.checkInDate < date && stay.checkOutDate >= date);
    const end = (trip.stays ?? []).filter(stay => stay.checkInDate <= date && stay.checkOutDate > date);
    if (start.length > 1 || end.length > 1) warnings.push('Overlapping stays: choose which accommodation to use.');
    if (!end.length && dayIndex < trip.days.length - 1) warnings.push('No accommodation booked for this night.');
    const canStart = !day.startPlaceId || day.startPlaceId === 'hotel' || Boolean(day.startStayId);
    const canEnd = (!day.endPlaceId || day.endPlaceId === 'hotel' || Boolean(day.endStayId)) && day.endMode !== 'flight';
    if (!canStart && start.length === 1 && day.startPlaceId !== start[0].placeId) warnings.push('Your chosen starting point will be kept.');
    if (!canEnd && end.length === 1 && day.endPlaceId !== end[0].placeId) warnings.push('Your chosen end point will be kept.');
    return { dayId: day.id, dayIndex, warnings,
      ...(canStart && start.length === 1 ? { startStayId: start[0].id, startPlaceId: start[0].placeId } : {}),
      ...(canEnd && end.length === 1 ? { endStayId: end[0].id, endPlaceId: end[0].placeId } : {}) };
  });
}
/** Only explicitly accepted suggestions become endpoints. Existing manual overrides survive. */
export function applyAccommodationSuggestions(trip: Trip, dayIds?: string[]): Trip {
  const suggestions = new Map(accommodationSuggestions(trip).map(suggestion => [suggestion.dayId, suggestion]));
  return { ...trip, days: trip.days.map(day => {
    const suggestion = suggestions.get(day.id);
    if (!suggestion || (dayIds && !dayIds.includes(day.id))) return day;
    return { ...day,
      ...(suggestion.startStayId ? { startStayId: suggestion.startStayId, startPlaceId: suggestion.startPlaceId } : {}),
      ...(suggestion.endStayId ? { endStayId: suggestion.endStayId, endPlaceId: suggestion.endPlaceId } : {}) };
  }) };
}
export function flightJourney(flight: FlightSegment | undefined, fromPlaceId: string, toPlaceId: string): Journey {
  const unavailable = (reason: string): Journey => ({ min: null, km: '—', mode: 'flight', status: 'unavailable', reason });
  if (!flight) return unavailable('Link a flight booking to confirm this journey.');
  if (flight.fromPlaceId !== fromPlaceId || flight.toPlaceId !== toPlaceId) return unavailable('The linked flight airports do not match this journey. Review the flight link.');
  const timing = flightTiming(flight);
  if (timing.status !== 'ready') return unavailable(timing.issues.join(' ') || 'Confirm this flight’s dates and times.');
  return { min: timing.durationMinutes, km: '—', mode: 'flight', status: 'ready', warning: 'Scheduled flight; not live status.',
    flight: { id: flight.id, departureMs: timing.departureMs!, arrivalMs: timing.arrivalMs!, departureGoalMs: timing.departureGoalMs!, arrivalReadyMs: timing.arrivalReadyMs! } };
}
/** A clock position relative to a selected date in the displayed day's time zone. */
export function dayMinutesAt(timestamp: number, date: string, timezone: string): number {
  return (wallTimestamp(timestamp, timezone) - Date.parse(`${date}T00:00:00Z`)) / 60000;
}
export function instantAtDayMinutes(date: string, minutes: number, timezone: string): number | null {
  if (!validDate(date) || !Number.isFinite(minutes)) return null;
  const nominal = new Date(Date.parse(`${date}T00:00:00Z`) + Math.round(minutes) * 60000);
  return resolveFlightMoment({ date: nominal.toISOString().slice(0, 10), time: nominal.toISOString().slice(11, 16), timezone }).timestamp;
}

/** A previous day's explicit onward plan can finish after midnight at the next day's base. */
function priorDayContinuesIncomingFlight(trip: Trip, dayIndex: number, flight: FlightSegment, start: number): boolean {
  const prior = trip.days[dayIndex - 1], current = trip.days[dayIndex];
  if (!prior || prior.endMode === 'flight' || prior.endFlightId
    || (prior.endPlaceId ?? 'hotel') !== (current.startPlaceId ?? 'hotel')) return false;
  const position = prior.items.findIndex(item => item.mode === 'flight' && item.flightId === flight.id);
  if (position < 0) return false;
  const date = bookingDayDate(trip, dayIndex - 1), zone = dayTimezone(trip, prior), places = getPlaces(trip);
  const from = position === 0 ? prior.startPlaceId ?? 'hotel' : prior.items[position - 1].placeId;
  const landing = prior.items[position], initial = flightTiming(flight);
  if (flight.departure.date !== date || flight.fromPlaceId !== from || flight.toPlaceId !== landing.placeId
    || !Object.hasOwn(places, from) || !Object.hasOwn(places, landing.placeId)
    || initial.status !== 'ready' || initial.arrivalReadyMs === null
    || !Number.isFinite(landing.duration) || landing.duration < 0) return false;
  let earliestFinish = initial.arrivalReadyMs + (landing.duration + (landing.freeTime && !landing.freeTime.untilBooking ? landing.freeTime.duration : 0)) * 60000;
  let earliestArrival = initial.arrivalReadyMs;
  let previousPlaceId = landing.placeId, hasGroundContinuation = false;
  const usedFlights = new Set([flight.id]);
  for (const item of prior.items.slice(position + 1)) {
    if (!Object.hasOwn(places, item.placeId) || !Number.isFinite(item.duration) || item.duration < 0) return false;
    if (item.mode === 'flight') {
      const onward = trip.flights?.find(value => value.id === item.flightId);
      if (!onward || usedFlights.has(onward.id) || onward.departure.date !== date
        || onward.fromPlaceId !== previousPlaceId || onward.toPlaceId !== item.placeId) return false;
      const timing = flightTiming(onward);
      if (timing.status !== 'ready' || timing.departureGoalMs === null || timing.departureMs === null || timing.arrivalReadyMs === null
        || earliestArrival > timing.departureGoalMs || earliestFinish > timing.departureMs) return false;
      earliestFinish = timing.arrivalReadyMs + item.duration * 60000;
      earliestArrival = timing.arrivalReadyMs;
      usedFlights.add(onward.id);
    } else {
      if (item.flightId) return false;
      hasGroundContinuation ||= previousPlaceId !== item.placeId;
      const fixed = item.fixed === null ? null : instantAtDayMinutes(date, item.fixed, zone);
      if (item.fixed !== null && fixed === null) return false;
      const anchor = item.departureForFlightId ? trip.flights?.find(value => value.id === item.departureForFlightId) : undefined;
      if (item.departureForFlightId && (!anchor || anchor.fromPlaceId !== item.placeId)) return false;
      earliestArrival = earliestFinish;
      earliestFinish = Math.max(earliestFinish, fixed ?? -Infinity) + (anchor ? anchor.airportBufferMinutes ?? 120 : item.duration) * 60000;
    }
    if (item.freeTime && !item.freeTime.untilBooking) earliestFinish += item.freeTime.duration * 60000;
    previousPlaceId = item.placeId;
  }
  const endPlaceId = prior.endPlaceId ?? 'hotel';
  if (!Object.hasOwn(places, endPlaceId)) return false;
  hasGroundContinuation ||= previousPlaceId !== endPlaceId;
  // Ground estimates live outside the saved trip. This recognises the planned
  // continuation, not a measured hotel-arrival time; the previous day's route
  // warnings remain responsible for missing or delayed transfers.
  return hasGroundContinuation && start > earliestFinish;
}

/** Arrival-day ground plans need an airport start or an explicit prior-day onward plan. */
export function incomingFlightStartIssue(trip: Trip, dayIndex: number): string | null {
  const day = trip.days[dayIndex];
  if (!day) return null;
  const date = bookingDayDate(trip, dayIndex);
  const linked = new Set(trip.days.flatMap(value => [value.endFlightId, ...value.items.map(item => item.flightId)]).filter(Boolean));
  const incoming = (trip.flights ?? []).filter(flight => {
    if (!linked.has(flight.id)) return false;
    if (flight.arrival.date === date && flight.departure.date !== date) return true;
    const ready = flightTiming(flight).arrivalReadyMs;
    return ready !== null && flight.arrival.date !== date && localDateAt(ready, flight.arrival.timezone) === date;
  });
  if (!incoming.length) return null;
  const timed = incoming.map(flight => ({ flight, timing: flightTiming(flight) }));
  if (timed.some(entry => entry.timing.status !== 'ready')) return 'Confirm the incoming flight’s arrival time before calculating this day’s ground journeys.';
  const latest = timed.sort((a, b) => b.timing.arrivalMs! - a.timing.arrivalMs!)[0];
  const start = instantAtDayMinutes(date, dayStartTime(day), dayTimezone(trip, day));
  if (start !== null && priorDayContinuesIncomingFlight(trip, dayIndex, latest.flight, start)) return null;
  if ((day.startPlaceId ?? 'hotel') !== latest.flight.toPlaceId || start === null || start < latest.timing.arrivalReadyMs!) {
    return 'Start this day at the arrival airport after landing and your arrival buffer. Ground journey times need this confirmation.';
  }
  return null;
}
