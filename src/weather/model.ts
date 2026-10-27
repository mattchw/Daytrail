import {bookingDayDate, dayTimezone, instantAtDayMinutes, localDateAt, type Activity, type Place, type Trip, type schedule} from '../model';
import {SAMPLE_VISIT_TRAITS} from '../pacing/traits';

export type Exposure = 'indoor' | 'outdoor' | 'mixed' | 'unknown';
export interface WeatherLocation {key:string;lat:number;lng:number;label:string;timezone:string}
export interface WeatherHour {time:number;temperature:number|null;rainProbability:number|null;code:number|null}
export interface WeatherForecast {version:1;source:'Open-Meteo';sourceURL:string;checkedAt:number;hours:WeatherHour[]}
export interface WeatherVisit {id:string;placeId:string;name:string;startMs:number|null;endMs:number|null;exposure:Exposure;location:WeatherLocation|null;approx?:boolean}
export interface VisitWeatherRisk {activityId:string;placeId:string;name:string;status:'rain'|'clear'|'unknown';probability:number|null;startMs:number|null;endMs:number|null;exposure:Exposure;reason?:string}
export const WEATHER_FRESH_MS=3*60*60_000;
export const WEATHER_MAX_AGE_MS=24*60*60_000;
export const WEATHER_HORIZON_DAYS=10;
export function visitExposure(activity:Pick<Activity,'placeId'> & {exposure?:Exposure},place?:Place):Exposure{return activity.exposure??(!place?.googlePlaceId?SAMPLE_VISIT_TRAITS[activity.placeId]?.exposure:undefined)??'unknown';}
/** Weather is approximate to a forecast area, never the precise venue address. */
export function weatherLocation(place:Place|undefined,timezone:string):WeatherLocation|null{
  if(!place||!Number.isFinite(place.lat)||!Number.isFinite(place.lng)||Math.abs(place.lat!)>90||Math.abs(place.lng!)>180)return null;
  const lat=Math.round(place.lat!*10)/10,lng=Math.round(place.lng!*10)/10;
  return {key:`${lat},${lng}:${timezone}`,lat,lng,label:place.userLabel||place.name,timezone};
}
export function weatherWindow(date:string,timezone:string,now=Date.now()):'available'|'past'|'too-early'{
  const days=Math.round((Date.parse(`${date}T12:00:00Z`)-Date.parse(`${localDateAt(now,timezone)}T12:00:00Z`))/86_400_000);
  return days<0?'past':days>=WEATHER_HORIZON_DAYS?'too-early':'available';
}
export function weatherVisits(trip:Trip,dayIndex:number,places:Record<string,Place>,planned:ReturnType<typeof schedule>):WeatherVisit[]{
  const day=trip.days[dayIndex],date=bookingDayDate(trip,dayIndex),zone=dayTimezone(trip,day);
  let placeZone=zone;
  return planned.rows.map(row=>{
    if(row.flight)placeZone=row.flight.arrival.timezone;
    const start=instantAtDayMinutes(date,Math.max(row.arrive,row.start),zone),end=instantAtDayMinutes(date,row.physicalEnd,zone);
    return {id:row.it.aid,placeId:row.it.placeId,name:places[row.it.placeId]?.name??row.pl.name,startMs:start,endMs:end,approx:row.approx,exposure:row.flight?'unknown':visitExposure(row.it,places[row.it.placeId]),location:weatherLocation(places[row.it.placeId],placeZone)};
  });
}
/** Forecast coverage is mandatory: missing, expired and partial hours never count as dry. */
export function assessVisitWeather(visit:WeatherVisit,forecast:WeatherForecast|undefined,now=Date.now()):VisitWeatherRisk{
  const base={activityId:visit.id,placeId:visit.placeId,name:visit.name,probability:null,startMs:null,endMs:null,exposure:visit.exposure};
  if(!forecast||!Number.isFinite(forecast.checkedAt)||now-forecast.checkedAt>WEATHER_FRESH_MS||forecast.checkedAt>now+60_000)return {...base,status:'unknown',reason:forecast?'Forecast needs a refresh.':'Forecast unavailable.'};
  if(visit.approx||visit.startMs===null||visit.endMs===null||!Number.isFinite(visit.startMs)||!Number.isFinite(visit.endMs)||visit.endMs<=visit.startMs)return {...base,status:'unknown',reason:'Visit time to confirm.'};
  if(!visit.location||weatherWindow(localDateAt(visit.startMs,visit.location.timezone),visit.location.timezone,now)!=='available')return {...base,status:'unknown',reason:'Outside the forecast window.'};
  if(visit.exposure==='unknown')return {...base,status:'unknown',reason:'Indoor or outdoor setting not confirmed.'};
  const hours=forecast.hours.filter(hour=>hour.time<visit.endMs!&&hour.time+3_600_000>visit.startMs!);
  const covered=hours.length&&hours[0].time<=visit.startMs&&hours.at(-1)!.time+3_600_000>=visit.endMs&&hours.every((hour,i)=>hour.rainProbability!==null&&(!i||hour.time-hours[i-1].time===3_600_000));
  if(!covered)return {...base,status:'unknown',reason:'Hourly forecast is incomplete for this visit.'};
  const rainy=hours.filter(hour=>hour.rainProbability!>=50),probability=Math.max(...hours.map(hour=>hour.rainProbability!));
  if(visit.exposure==='indoor'||!rainy.length)return {...base,status:'clear',probability};
  return {...base,status:'rain',probability,startMs:Math.max(visit.startMs,rainy[0].time),endMs:Math.min(visit.endMs,rainy.at(-1)!.time+3_600_000)};
}
export function weatherDescription(code:number|null):string{
  if(code===null)return 'Forecast';if(code===0)return 'Clear';if(code<=2)return 'Partly cloudy';if(code===3)return 'Cloudy';if(code<=48)return 'Fog';if(code>=95)return 'Thunderstorms possible';if(code>=71&&code<=77||code>=85&&code<=86)return 'Snow possible';return 'Rain possible';
}
export function summarizeWeather(forecast:WeatherForecast,date:string,timezone:string){
  const hours=forecast.hours.filter(hour=>localDateAt(hour.time,timezone)===date),temps=hours.flatMap(hour=>hour.temperature===null?[]:[hour.temperature]),rain=hours.flatMap(hour=>hour.rainProbability===null?[]:[hour.rainProbability]);
  if(!hours.length)return null;
  const noon=hours.find(hour=>new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:timezone}).format(hour.time)==='12')??hours[Math.floor(hours.length/2)];
  return {low:temps.length?Math.round(Math.min(...temps)):null,high:temps.length?Math.round(Math.max(...temps)):null,probability:rain.length?Math.max(...rain):null,label:weatherDescription(noon.code)};
}
/** Only narrow venue types are indoor suggestions. Unknown venues are excluded. */
export function indoorIdea(place:Place,primaryType?:string,override?:Exposure):boolean{
  const setting=override??(!place.googlePlaceId?SAMPLE_VISIT_TRAITS[place.id]?.exposure:undefined);
  if(setting)return setting==='indoor';
  return /^(museum|art_gallery|library|movie_theater|cinema)$/i.test((primaryType??'').trim().replaceAll(' ','_'));
}
