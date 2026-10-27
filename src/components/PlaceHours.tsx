import {useEffect,useState} from 'react';
import {Clock3} from 'lucide-react';
import type {Place} from '../model';
import {fetchVisitOpeningInfo} from '../discoveryData';
import {getWeekdayHoursLabel,type OpeningInfo} from '../openingHours';
import {withPlaceAdmission} from '../placeHours';

/** Provider hours remain in the service cache, separate from saved trip data. */
export default function PlaceHours({place,date,info,className=''}:{place:Place;date:string;info?:OpeningInfo;className?:string}) {
  const [loaded,setLoaded]=useState<{id:string;info:OpeningInfo}|null>(null);
  useEffect(()=>{
    if(info||!place.googlePlaceId)return;
    let active=true;
    void fetchVisitOpeningInfo(place.googlePlaceId).then(value=>{if(active)setLoaded({id:place.googlePlaceId!,info:value});}).catch(()=>{});
    return()=>{active=false;};
  },[place.googlePlaceId,info]);
  const hours=withPlaceAdmission(info??(loaded?.id===place.googlePlaceId?loaded?.info:undefined),place);
  return <p className={`place-weekday-hours ${className}`}><Clock3 size={13} aria-hidden="true"/><span>{getWeekdayHoursLabel(hours,date)}</span></p>;
}
