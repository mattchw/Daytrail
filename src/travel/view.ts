/** Session-only navigation memory contains IDs, never itinerary or account details. */
export const TRAVEL_VIEW_KEY = 'daytrail.travel.view.v1';
export interface TravelView {ownerId: string | null; scope: 'guest' | 'account'; tripId: string; dayId: string; savedAt: number}
export function parseTravelView(raw: string | null, ownerId: string | null, now = Date.now()): TravelView | null {
  try {
    const v = JSON.parse(raw || 'null');
    if (!v || v.ownerId !== ownerId || !['guest', 'account'].includes(v.scope) || (v.scope === 'account' && !ownerId)
      || typeof v.tripId !== 'string' || !v.tripId || v.tripId.length > 200
      || typeof v.dayId !== 'string' || !v.dayId || v.dayId.length > 200
      || typeof v.savedAt !== 'number' || !Number.isFinite(v.savedAt) || v.savedAt > now || now - v.savedAt > 7 * 86400_000) return null;
    return {ownerId: v.ownerId, scope: v.scope, tripId: v.tripId, dayId: v.dayId, savedAt: v.savedAt};
  } catch {return null;}
}
