import {PLACES,type Place,type Trip} from './model';
import {retainSampleVisitTraits} from './pacing/traits';

/** User-confirmed cutoffs are trip data; provider hours stay in memory. */
export function setPlaceLastEntry(trip:Trip,place:Place,weekday:number,minutes:number|null,newId:string) {
  if(!Number.isInteger(weekday)||weekday<0||weekday>6||minutes!==null&&(!Number.isInteger(minutes)||minutes<0||minutes>1439))throw Error('Choose a valid last-entry time.');
  const oldId=place.id;
  if(!trip.customPlaces[oldId]&&!PLACES[oldId])throw Error('This place is no longer in your trip.');
  const id=oldId!=='hotel'&&Object.hasOwn(PLACES,oldId)?newId:oldId;
  if(id!==oldId&&(!id.startsWith('custom-')||Object.hasOwn(trip.customPlaces,id)||Object.hasOwn(PLACES,id)))throw Error('Could not save this place. Try again.');
  const current=trip.customPlaces[oldId]??place;
  const cutoff={...current.lastEntryMinutes};
  if(minutes===null)delete cutoff[weekday];else cutoff[weekday]=minutes;
  trip.customPlaces[id]={...current,id};
  if(Object.keys(cutoff).length)trip.customPlaces[id].lastEntryMinutes=cutoff;
  else delete trip.customPlaces[id].lastEntryMinutes;
  if(id!==oldId){
    for(const day of trip.days){if(day.startPlaceId===oldId)day.startPlaceId=id;if(day.endPlaceId===oldId)day.endPlaceId=id;for(const item of day.items)if(item.placeId===oldId){retainSampleVisitTraits(item,current);item.placeId=id;}}
    for(const flight of trip.flights??[]){if(flight.fromPlaceId===oldId)flight.fromPlaceId=id;if(flight.toPlaceId===oldId)flight.toPlaceId=id;}
    for(const stay of trip.stays??[])if(stay.placeId===oldId)stay.placeId=id;
    trip.ideas=[...new Set(trip.ideas.map(value=>value===oldId?id:value))];
  }
}
