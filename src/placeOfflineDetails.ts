import {PLACES,type Place,type Trip} from './model';
import {retainSampleVisitTraits} from './pacing/traits';

/** Only independently authored details are retained; Google responses are not copied here. */
export function setPlaceOfflineDetails(trip:Trip,placeId:string,details:Place['offlineDetails'],newId:string):void {
  const current=trip.customPlaces[placeId]??PLACES[placeId];
  if(!current)throw Error('This place is no longer in the trip.');
  const id=placeId!=='hotel'&&Object.hasOwn(PLACES,placeId)?newId:placeId;
  if(id!==placeId&&(!newId.startsWith('custom-')||Object.hasOwn(trip.customPlaces,newId)||Object.hasOwn(PLACES,newId)))throw Error('This place changed. Try again.');
  if(details&&(!details.name.trim()||details.name.length>160||[details.address,details.localAddress].some(value=>value!==undefined&&value.length>500)||(details.hours?.length??0)>1000))throw Error('Enter a name and keep the details within the indicated limits.');
  trip.customPlaces[id]={...current,id};
  if(details)trip.customPlaces[id].offlineDetails={...details,name:details.name.trim()};else delete trip.customPlaces[id].offlineDetails;
  if(id===placeId)return;
  for(const day of trip.days){if(day.startPlaceId===placeId)day.startPlaceId=id;if(day.endPlaceId===placeId)day.endPlaceId=id;for(const item of day.items)if(item.placeId===placeId){retainSampleVisitTraits(item,current);item.placeId=id;}}
  for(const flight of trip.flights??[]){if(flight.fromPlaceId===placeId)flight.fromPlaceId=id;if(flight.toPlaceId===placeId)flight.toPlaceId=id;}
  for(const stay of trip.stays??[])if(stay.placeId===placeId)stay.placeId=id;
  trip.ideas=[...new Set(trip.ideas.map(value=>value===placeId?id:value))];
}
