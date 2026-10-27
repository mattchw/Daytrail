import {isTrip, type Day, type Place, type Trip} from './model';

export const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
export const MAX_BACKUP_TRIPS = 100;
const FORMAT = 'daytrail-workspace';

export interface TripBackup {
  format: typeof FORMAT;
  version: 2;
  exportedAt: string;
  activeId: string | null;
  trips: Trip[];
}

export interface TripBackupMerge {
  trips: Trip[];
  addedTrips: Trip[];
  skippedCount: number;
  /** Imported equivalent of the backup's active trip, when available. */
  activeId: string | null;
}

function invalid(message = 'This file is not a valid Daytrail trip backup.'): never {
  throw new Error(message);
}

/** Inspect before using nested data. An iterative walk also bounds malicious depth. */
function checkJsonTree(value: unknown): void {
  const queue: {value: unknown; depth: number}[] = [{value, depth: 0}];
  let visited = 0;
  while (queue.length) {
    const entry = queue.pop()!;
    if (++visited > 250_000 || entry.depth > 24) invalid('This backup contains too much nested data.');
    if (entry.value === null || typeof entry.value === 'string' || typeof entry.value === 'boolean') continue;
    if (typeof entry.value === 'number') {
      if (!Number.isFinite(entry.value)) invalid();
      continue;
    }
    if (typeof entry.value !== 'object') invalid();
    if (Array.isArray(entry.value)) {
      if (entry.value.length + queue.length + visited > 250_000) invalid('This backup contains too much nested data.');
      for (const child of entry.value) queue.push({value: child, depth: entry.depth + 1});
      continue;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(entry.value))) invalid();
    const keys = Object.keys(entry.value);
    if (keys.length + queue.length + visited > 250_000) invalid('This backup contains too much nested data.');
    for (const key of keys) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') invalid('This backup contains an unsafe field.');
      const child = (entry.value as Record<string, unknown>)[key];
      queue.push({value: child, depth: entry.depth + 1});
    }
  }
}

/** Explicit allowlist: never serialize arbitrary fields attached to a trip or place. */
function canonicalPlace(id: string, source: Place): Place {
  const google = !!source.googlePlaceId;
  const place: Place = {
    id,
    name: google ? (id === 'hotel' ? 'Your stay' : 'Saved place') : source.name,
    cat: source.cat,
    x: google ? 50 : source.x,
    y: google ? 50 : source.y,
    area: google ? '' : source.area,
    // This is Daytrail's editable visit-length hint, retained by persistableTrip too.
    typical: source.typical,
    blurb: google ? '' : source.blurb,
  };
  if (google) place.googlePlaceId = source.googlePlaceId;
  else {
    if (source.noTransit !== undefined) place.noTransit = source.noTransit;
    if (source.lat !== undefined && source.lng !== undefined) {
      place.lat = source.lat;
      place.lng = source.lng;
    }
  }
  if (source.userLabel !== undefined) place.userLabel = source.userLabel;
  if (source.userNotes !== undefined) place.userNotes = source.userNotes;
  if (source.offlineDetails !== undefined) place.offlineDetails = {name:source.offlineDetails.name,...(source.offlineDetails.address!==undefined?{address:source.offlineDetails.address}:{}),...(source.offlineDetails.localAddress!==undefined?{localAddress:source.offlineDetails.localAddress}:{}),...(source.offlineDetails.hours!==undefined?{hours:source.offlineDetails.hours}:{})};
  if (source.lastEntryMinutes !== undefined) place.lastEntryMinutes = { ...source.lastEntryMinutes };
  return place;
}

function canonicalDay(source: Day): Day {
  const day: Day = {
    id: source.id, label: source.label, date: source.date, title: source.title,
    endMode: source.endMode,
    items: source.items.map(item => ({
      aid: item.aid, placeId: item.placeId, duration: item.duration,
      fixed: item.fixed, mode: item.mode, note: item.note,
      ...(item.freeTime !== undefined ? {freeTime:{id:item.freeTime.id,kind:item.freeTime.kind,duration:item.freeTime.duration,untilBooking:item.freeTime.untilBooking}} : {}),
      ...(item.meal !== undefined ? {meal:item.meal} : {}),
      ...(item.walkingMeters !== undefined ? {walkingMeters:item.walkingMeters} : {}),
      ...(item.exposure !== undefined ? {exposure:item.exposure} : {}),
      ...(item.flightId !== undefined ? {flightId:item.flightId} : {}),
      ...(item.departureForFlightId !== undefined ? {departureForFlightId:item.departureForFlightId} : {}),
    })),
  };
  if (source.pace !== undefined) day.pace = source.pace;
  if (source.startTime !== undefined) day.startTime = source.startTime;
  if (source.finishBy !== undefined) day.finishBy = source.finishBy;
  if (source.startPlaceId !== undefined) day.startPlaceId = source.startPlaceId;
  if (source.endPlaceId !== undefined) day.endPlaceId = source.endPlaceId;
  if (source.timezone !== undefined) day.timezone = source.timezone;
  if (source.startStayId !== undefined) day.startStayId = source.startStayId;
  if (source.endStayId !== undefined) day.endStayId = source.endStayId;
  if (source.endFlightId !== undefined) day.endFlightId = source.endFlightId;
  return day;
}

function pickDefined<T extends object, K extends keyof T>(value:T, keys:K[]):Pick<T,K> {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key,value[key]])) as Pick<T,K>;
}
function canonicalMoment(value:NonNullable<Trip['flights']>[number]['departure']) {
  return {date:value.date,time:value.time,timezone:value.timezone,...(value.offsetMinutes !== undefined ? {offsetMinutes:value.offsetMinutes}: {})};
}

export function canonicalTrip(source: Trip): Trip {
  return {
    id: source.id, name: source.name, destination: source.destination,
    ...(source.pace !== undefined ? {pace:source.pace} : {}),
    startDate: source.startDate, timezone: source.timezone,
    days: source.days.map(canonicalDay), ideas: [...source.ideas],
    ...(source.flights !== undefined ? {flights: source.flights.map(flight => ({
      id:flight.id, fromPlaceId:flight.fromPlaceId, toPlaceId:flight.toPlaceId,
      departure:canonicalMoment(flight.departure), arrival:canonicalMoment(flight.arrival),
      ...pickDefined(flight, ['airline','flightNumber','departureTerminal','arrivalTerminal','departureGate','arrivalGate','bookingReference','privateNotes','airportBufferMinutes','arrivalBufferMinutes','groupId']),
    }))} : {}),
    ...(source.stays !== undefined ? {stays: source.stays.map(stay => ({
      id:stay.id,placeId:stay.placeId,checkInDate:stay.checkInDate,checkOutDate:stay.checkOutDate,timezone:stay.timezone,
      ...pickDefined(stay,['checkInTime','checkOutTime','bookingReference','contact','bookingUrl','privateNotes']),
    }))} : {}),
    customPlaces: Object.fromEntries(Object.keys(source.customPlaces).sort().map(id => [id, canonicalPlace(id, source.customPlaces[id])])),
  };
}

/** Explicit public projection. Personal backups continue to use canonicalTrip. */
export function publicTrip(source:Trip):Trip {
  const trip=canonicalTrip(source);
  for (const flight of trip.flights || []) {
    delete flight.bookingReference; delete flight.privateNotes;
    delete flight.departureGate; delete flight.arrivalGate;
  }
  for (const stay of trip.stays || []) {
    delete stay.bookingReference; delete stay.contact; delete stay.bookingUrl; delete stay.privateNotes;
  }
  return trip;
}

function checkTrips(trips: unknown): asserts trips is Trip[] {
  if (!Array.isArray(trips) || trips.length > MAX_BACKUP_TRIPS || !trips.every(isTrip)
    || new Set(trips.map(trip => trip.id)).size !== trips.length) {
    invalid(`A backup must contain up to ${MAX_BACKUP_TRIPS} valid trips with unique IDs.`);
  }
}

function checkEnvelope(value: unknown): TripBackup {
  checkJsonTree(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (input.format !== FORMAT) invalid('Choose a Daytrail JSON backup. HTML itineraries and snapshot links cannot be restored here.');
  if (input.version !== 1 && input.version !== 2) invalid('This backup uses a version that this Daytrail app does not support.');
  if (typeof input.exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.exportedAt)
    || !Number.isFinite(Date.parse(input.exportedAt)) || new Date(input.exportedAt).toISOString() !== input.exportedAt) invalid();
  checkTrips(input.trips);
  if ((input.activeId !== null && typeof input.activeId !== 'string')
    || (input.activeId !== null && !input.trips.some(trip => trip.id === input.activeId))
    || (input.trips.length > 0 && input.activeId === null)) invalid('The selected trip in this backup is missing.');
  return {format: FORMAT, version: 2, exportedAt: input.exportedAt, activeId: input.activeId as string | null, trips: input.trips.map(canonicalTrip)};
}

function checkSize(text: string): void {
  if (text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) {
    invalid('This backup is too large. Choose a Daytrail backup smaller than 4 MB.');
  }
}

export function createTripBackup(trips: Trip[], activeId = trips[0]?.id ?? '', exportedAt = new Date().toISOString()): TripBackup {
  // Trusted live state can contain optional undefined fields. Only inspect/serialize the allowlist.
  checkTrips(trips);
  const backup = checkEnvelope({format: FORMAT, version: 2, exportedAt, activeId: activeId || null, trips: trips.map(canonicalTrip)});
  checkSize(JSON.stringify(backup));
  return backup;
}

export function serializeTripBackup(trips: Trip[], activeId?: string, exportedAt?: string): string {
  const text = JSON.stringify(createTripBackup(trips, activeId, exportedAt), null, 2);
  checkSize(text);
  return text;
}

export function parseTripBackup(text: string): TripBackup {
  if (typeof text !== 'string') invalid();
  checkSize(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { invalid('This file could not be read. Choose a complete Daytrail JSON backup.'); }
  return checkEnvelope(parsed);
}

function contentOf(trip: Trip): string {
  const canonical = canonicalTrip(trip);
  canonical.id = 'content';
  return JSON.stringify(canonical);
}

async function importId(trip: Trip): Promise<string> {
  if (!globalThis.crypto?.subtle) invalid('Backup import needs a secure browser connection. Open Daytrail using HTTPS or localhost.');
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalTrip(trip)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'import-' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

/** Pure additive merge. The caller must durably save its result before changing the UI. */
export async function mergeTripBackup(existingTrips: Trip[], backup: TripBackup): Promise<TripBackupMerge> {
  checkTrips(existingTrips);
  const incoming = checkEnvelope(backup);
  checkSize(JSON.stringify(incoming));
  const trips = [...existingTrips], addedTrips: Trip[] = [];
  const ids = new Set(trips.map(trip => trip.id));
  const contents = new Map(trips.map(trip => [contentOf(trip), trip.id]));
  let skippedCount = 0, activeId: string | null = null;
  for (const source of incoming.trips) {
    const content = contentOf(source), id = await importId(source);
    // A stable imported ID also recognizes a prior import that has since been edited.
    const duplicateId = ids.has(id) ? id : contents.get(content);
    if (duplicateId) {
      skippedCount += 1;
      if (source.id === incoming.activeId) activeId = duplicateId;
      continue;
    }
    if (trips.length >= MAX_BACKUP_TRIPS) invalid(`Import would exceed ${MAX_BACKUP_TRIPS} trips. No trips have been changed.`);
    const added = canonicalTrip(source);
    added.id = id;
    trips.push(added); addedTrips.push(added); ids.add(id); contents.set(content, id);
    if (source.id === incoming.activeId) activeId = id;
  }
  return {trips, addedTrips, skippedCount, activeId};
}
