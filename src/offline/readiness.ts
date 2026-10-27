import {getPlaces,persistableTrip,type Trip} from '../model';
const sorted=(value:unknown):unknown=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sorted(item)])):value;
export function offlineTripDocument(trip:Trip){return JSON.stringify(sorted(persistableTrip(trip)));}
export async function offlineFingerprint(trip:Trip):Promise<string>{const bytes=new TextEncoder().encode(offlineTripDocument(trip));const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');}
/** Only independently authored fields count as available provider-place details. */
export function offlineTripGaps(trip:Trip):string[]{
  const places=getPlaces(persistableTrip(trip));
  const ids=new Set([...trip.ideas,...trip.days.flatMap(day=>[day.startPlaceId??'hotel',day.endPlaceId??'hotel',...day.items.map(item=>item.placeId)]),...(trip.stays||[]).map(stay=>stay.placeId),...(trip.flights||[]).flatMap(flight=>[flight.fromPlaceId,flight.toPlaceId])]);
  const selected=[...ids].map(id=>places[id]).filter(Boolean);
  const missingNames=selected.filter(place=>place.googlePlaceId&&!place.offlineDetails?.name&&!place.userLabel).length;
  const missingAddresses=selected.filter(place=>!place.offlineDetails?.address&&!place.offlineDetails?.localAddress&&!(Number.isFinite(place.lat)&&Number.isFinite(place.lng))).length;
  const missingHours=selected.filter(place=>['attr','food'].includes(place.cat)&&!place.offlineDetails?.hours).length;
  const missing=[];
  if(missingNames)missing.push(`${missingNames} saved ${missingNames===1?'place needs':'places need'} a name you have entered for offline use.`);
  if(missingAddresses)missing.push(`${missingAddresses} saved ${missingAddresses===1?'place has':'places have'} no exact location or address you have entered for offline use.`);
  if(missingHours)missing.push(`${missingHours} saved ${missingHours===1?'place has':'places have'} no opening hours you have entered for offline use.`);
  return missing;
}
