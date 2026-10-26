/** Pure trip data and planning logic. Legacy x/y coordinates are illustrative only. */
export type Mode = 'walk' | 'transit' | 'drive';
export type Category = 'attr' | 'food' | 'custom';

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
}

export interface Journey {
  min: number | null;
  km: string;
  mode: Mode;
  status?: 'ready' | 'loading' | 'unavailable';
  reason?: string;
  path?: { lat: number; lng: number }[];
  warning?: string;
}

export interface Activity {
  aid: string;
  placeId: string;
  duration: number;
  fixed: number | null;
  mode: Mode;
  note: string;
}

export interface Day {
  id: string;
  label: string;
  date: string;
  title: string;
  endMode: Mode;
  /** Trip-local departure time in minutes. Older plans start at 09:00. */
  startTime?: number;
  /** A preferred return time, never a cutoff for visits or journeys. */
  finishBy?: number | null;
  /** A different departure point for this day; the return remains the hotel. */
  startPlaceId?: string;
  items: Activity[];
}

export interface Trip {
  id: string;
  name: string;
  destination: string;
  startDate: string;
  timezone: string;
  days: Day[];
  ideas: string[];
  customPlaces: Record<string, Place>;
}

export const MAX_TRIP_DAYS = 30;

export const CATEGORIES: Record<Category, { label: string; ink: string; tint: string }> = {
  attr: { label: 'Sight', ink: '#2C5A8C', tint: '#E3EBF5' },
  food: { label: 'Food & drink', ink: '#A24E17', tint: '#F8E7DA' },
  custom: { label: 'Custom', ink: '#6A4A93', tint: '#EDE6F5' },
};

const placeData: Record<string, Omit<Place, 'id'>> = {
  hotel: { name: 'Hotel', cat: 'custom', x: 50, y: 72, area: 'Kyoto Station', typical: '', blurb: 'Your sample base near Kyoto Station. Each day starts and finishes here.' },
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
    startPlaceId: 'hotel', items: [],
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
      hotel: { id: 'hotel', name: 'Your stay', cat: 'custom', x: 50, y: 72, area: destination.trim(), typical: '', blurb: 'Choose your hotel or another starting location. Each day starts and finishes here.' },
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
}

export function schedule(day: Day, places: Record<string, Place>, legs?: Record<string, Journey>): {
  rows: ScheduleRow[];
  endLeg: Journey;
  travel: number;
  unknown: number;
  late: number;
  wait: number;
  finish: number;
  finishApprox: boolean;
} {
  const hotel = places.hotel;
  if (!hotel) throw new Error('A trip needs a return location.');
  const journey = (key: string, from: Place, to: Place, mode: Mode): Journey => {
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
  let uncertain = false;
  const rows = day.items.map((it): ScheduleRow => {
    const pl = places[it.placeId];
    if (!pl) throw new Error(`Unknown place: ${it.placeId}`);
    const leg = journey(it.aid, previous, pl, it.mode);
    if (leg.min === null) { unknown += 1; uncertain = true; }
    else travelMinutes += leg.min;
    const arrive = time + (leg.min ?? 0);
    const start = it.fixed ?? arrive;
    const rowLate = it.fixed === null ? 0 : Math.max(0, arrive - it.fixed);
    // An unknown journey has no upper bound; spare time does not prove arrival on time.
    const rowWait = it.fixed === null || uncertain ? 0 : Math.max(0, it.fixed - arrive);
    const physicalEnd = Math.max(arrive, start) + it.duration;
    const row: ScheduleRow = {
      it, pl, leg, arrive, start, end: start + it.duration, physicalEnd,
      wait: rowWait, late: rowLate, approx: uncertain,
    };
    time = physicalEnd;
    previous = pl;
    late += rowLate;
    wait += rowWait;
    return row;
  });
  const endLeg: Journey = day.items.length === 0
    ? { min: 0, km: '0.0', mode: day.endMode, status: 'ready' }
    : journey('return', previous, hotel, day.endMode);
  if (endLeg.min === null) { unknown += 1; uncertain = true; }
  else travelMinutes += endLeg.min;
  return { rows, endLeg, travel: travelMinutes, unknown, late, wait, finish: time + (endLeg.min ?? 0), finishApprox: uncertain };
}

/** Enumerates at most 8! alternatives; bookings split the day into uncrossable runs. */
export function proposeOrder(day: Day, places: Record<string, Place>, legs?: Record<string, Journey>): {
  items: Activity[]; before: number; after: number; saved: number;
} | null {
  // Incoming legs only describe the current order. Reordering real places needs new route
  // requests; the sample straight-line estimator cannot establish an improvement.
  if (legs !== undefined || [dayStartPlace(day, places), places.hotel, ...day.items.map(item => places[item.placeId])]
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
const isMode = (value: unknown): value is Mode => value === 'walk' || value === 'drive' || value === 'transit';
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
    if (place.attributions !== undefined && (!Array.isArray(place.attributions)
      || place.attributions.length > 100
      || place.attributions.some(attribution => !isRecord(attribution)
        || !isText(attribution.provider, 300, true)
        || (attribution.providerURI !== undefined && !isHttpsURL(attribution.providerURI))))) return false;
    // The starting point can be customised; sample place IDs cannot be overwritten on import.
    if (id !== 'hotel' && Object.hasOwn(PLACES, id)) return false;
  }
  const knownPlace = (id: unknown) => isId(id) && (Object.hasOwn(PLACES, id) || Object.hasOwn(value.customPlaces as object, id));
  if (value.ideas.some(id => !knownPlace(id) || id === 'hotel') || new Set(value.ideas).size !== value.ideas.length) return false;
  const dayIds = new Set<string>();
  const activityIds = new Set<string>();
  for (const day of value.days) {
    if (!isRecord(day) || !isId(day.id) || dayIds.has(day.id) || !isText(day.label, 80, true)
      || !isText(day.date, 80, true) || !isText(day.title, 160) || !isMode(day.endMode)
      || !Array.isArray(day.items) || day.items.length > 100) return false;
    if ((day.startTime !== undefined && !isInteger(day.startTime, 0, 1439))
      || (day.startPlaceId !== undefined && !knownPlace(day.startPlaceId))
      || (day.finishBy !== undefined && day.finishBy !== null
        && (!isInteger(day.finishBy, 0, 1439) || day.finishBy <= (day.startTime ?? 540)))) return false;
    dayIds.add(day.id);
    for (const item of day.items) {
      if (!isRecord(item) || !isId(item.aid) || activityIds.has(item.aid)
        || !knownPlace(item.placeId) || item.placeId === 'hotel'
        || !isInteger(item.duration, 5, 1440)
        || (item.fixed !== null && !isInteger(item.fixed, 0, 1439))
        || !isMode(item.mode) || !isText(item.note, 8000)) return false;
      activityIds.add(item.aid);
    }
  }
  return true;
}
