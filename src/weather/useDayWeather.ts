import {useEffect,useMemo,useState} from 'react';
import {bookingDayDate,dayTimezone,type Place,type Trip,type schedule} from '../model';
import {assessVisitWeather,summarizeWeather,weatherLocation,weatherVisits,weatherWindow,WEATHER_FRESH_MS,type WeatherForecast,type WeatherLocation,type WeatherVisit,type VisitWeatherRisk} from './model';
import {getWeatherForecast,readWeatherCache} from './client';

export type WeatherStatus='loading'|'ready'|'stale'|'offline'|'unavailable'|'too-early'|'past'|'no-location';
export interface DayWeatherResult {
  status:WeatherStatus;date:string;timezone:string;forecast:WeatherForecast|undefined;
  forecasts:Record<string,WeatherForecast>;locations:WeatherLocation[];visits:WeatherVisit[];
  risks:VisitWeatherRisk[];rainVisits:VisitWeatherRisk[];summary:ReturnType<typeof summarizeWeather>;
  signature:string;partial:boolean;retry:()=>void;
}
export interface DayWeatherOptions {trip:Trip;dayIndex:number;places:Record<string,Place>;schedule:ReturnType<typeof schedule>;visits?:WeatherVisit[];enabled?:boolean;date?:string;now?:number}
export function useDayWeather({trip,dayIndex,places,schedule:planned,visits:override,enabled=true,date:overrideDate,now:providedNow}:DayWeatherOptions):DayWeatherResult{
  const day=trip.days[dayIndex],timezone=dayTimezone(trip,day),date=overrideDate??bookingDayDate(trip,dayIndex);
  const [clock,setClock]=useState(Date.now),[revision,setRevision]=useState(0),[online,setOnline]=useState(()=>typeof navigator==='undefined'||navigator.onLine);
  const now=providedNow??clock,window=weatherWindow(date,timezone,now);
  const visits=override??weatherVisits(trip,dayIndex,places,planned);
  const locations=[...new Map(visits.flatMap(visit=>visit.location?[[visit.location.key,visit.location] as const]:[])).values()];
  if(!locations.length){const base=weatherLocation(places[day.startPlaceId??'hotel'],timezone);if(base)locations.push(base);}
  const locationKey=locations.map(location=>location.key).sort().join('|'),requestKey=`${date}:${window}:${locationKey}`;
  const [snapshot,setSnapshot]=useState<{key:string;forecasts:Record<string,WeatherForecast>;loading:boolean;failed:boolean}>({key:'',forecasts:{},loading:false,failed:false});
  useEffect(()=>{
    const refresh=()=>{setClock(Date.now());setOnline(navigator.onLine);if(document.visibilityState==='visible')setRevision(value=>value+1);};
    globalThis.window.addEventListener('online',refresh);globalThis.window.addEventListener('offline',refresh);document.addEventListener('visibilitychange',refresh);
    const timer=globalThis.window.setInterval(()=>setClock(Date.now()),60_000);
    return()=>{globalThis.window.clearInterval(timer);globalThis.window.removeEventListener('online',refresh);globalThis.window.removeEventListener('offline',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[]);
  // Stable forecast areas prevent a live countdown or a changed stop order making new requests.
  useEffect(()=>{
    if(!enabled||window!=='available'||!locations.length)return;
    let active=true;const cached:Record<string,WeatherForecast>={};for(const location of locations){const forecast=readWeatherCache(location);if(forecast)cached[location.key]=forecast;}
    setSnapshot({key:requestKey,forecasts:cached,loading:online,failed:!online});
    if(!online)return;
    void (async()=>{
      let cursor=0,failed=false;const forecasts={...cached};
      await Promise.all(Array.from({length:Math.min(3,locations.length)},async()=>{while(cursor<locations.length){const location=locations[cursor++];try{forecasts[location.key]=await getWeatherForecast(location);}catch{failed=true;}}}));
      if(active)setSnapshot({key:requestKey,forecasts,loading:false,failed});
    })();return()=>{active=false;};
  },[enabled,requestKey,online,revision]);
  const forecasts=snapshot.key===requestKey?snapshot.forecasts:{};
  const forecast=locations.map(location=>forecasts[location.key]).find(Boolean);
  const stale=Object.values(forecasts).some(value=>now-value.checkedAt>WEATHER_FRESH_MS);
  const partial=locations.some(location=>!forecasts[location.key])||visits.some(visit=>!visit.location);
  const status:WeatherStatus=window!=='available'?window:!locations.length?'no-location':!online?'offline':snapshot.key!==requestKey||snapshot.loading&&!forecast?'loading':!forecast?'unavailable':stale?'stale':'ready';
  const risks=visits.map(visit=>assessVisitWeather(visit,visit.location?forecasts[visit.location.key]:undefined,now)),rainVisits=risks.filter(risk=>risk.status==='rain');
  const first=locations.find(location=>forecasts[location.key]);
  const summary=forecast&&first?summarizeWeather(forecast,date,first.timezone):null;
  const signature=useMemo(()=>JSON.stringify([date,visits.map(visit=>[visit.id,visit.startMs,visit.endMs,visit.exposure,visit.location?.key]),Object.entries(forecasts).map(([key,value])=>[key,value.checkedAt])]),[date,JSON.stringify(visits),JSON.stringify(forecasts)]);
  return {status,date,timezone,forecast,forecasts,locations,visits,risks,rainVisits,summary,signature,partial,retry:()=>setRevision(value=>value+1)};
}
