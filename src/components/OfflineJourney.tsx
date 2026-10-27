import {MapPin,WifiOff} from 'lucide-react';
import {getPlaces,type Trip} from '../model';
export default function OfflineJourney({trip,dayIndex,onOffline}:{trip:Trip;dayIndex:number;onOffline:()=>void}) {
  const day=trip.days[dayIndex],places=getPlaces(trip),ids=[day.startPlaceId??'hotel',...day.items.map(item=>item.placeId),day.endPlaceId??'hotel'];
  return <section className="offline-journey" aria-label="Saved journey order"><WifiOff size={25}/><h3>Your day is still here</h3><p>Street maps and new route estimates need a connection. This is your saved stop order, not navigation directions.</p><ol>{ids.map((id,index)=>{const place=places[id];return <li key={index}><strong>{place?.offlineDetails?.name||place?.userLabel||place?.name||'Saved place'}</strong><span>{index===0?'Start':index===ids.length-1?'Finish':`Stop ${index}`}{place?.offlineDetails?.address?` · ${place.offlineDetails.address}`:''}</span></li>;})}</ol><button className="button" onClick={onOffline}><MapPin size={16}/>What’s saved offline</button></section>;
}
