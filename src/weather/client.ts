import {WEATHER_FRESH_MS,WEATHER_MAX_AGE_MS,type WeatherForecast,type WeatherLocation} from './model';
const memory=new Map<string,WeatherForecast>(),pending=new Map<string,Promise<WeatherForecast>>();
const CACHE_PREFIX='daytrail:weather:v1:';
// Keys describe coarse forecast areas only: no trip IDs, provider place IDs or personal data.
export function weatherCacheKey(location:WeatherLocation){return `${CACHE_PREFIX}${location.key}`;}
export function parseForecast(value:unknown,checkedAt=Date.now()):WeatherForecast{
  if(!value||typeof value!=='object')throw new Error('Forecast unavailable.');
  const hourly=(value as {hourly?:Record<string,unknown>}).hourly;
  if(!hourly||!Array.isArray(hourly.time)||hourly.time.length<1||hourly.time.length>500)throw new Error('Forecast unavailable.');
  const temperatures=hourly.temperature_2m,probabilities=hourly.precipitation_probability,codes=hourly.weather_code;
  const numeric=(values:unknown,index:number,min:number,max:number)=>Array.isArray(values)&&typeof values[index]==='number'&&Number.isFinite(values[index])&&values[index]>=min&&values[index]<=max?values[index]:null;
  const hours=hourly.time.map((time,index)=>({time:typeof time==='number'?time*1000:NaN,temperature:numeric(temperatures,index,-100,70),rainProbability:numeric(probabilities,index,0,100),code:numeric(codes,index,0,99)}));
  if(hours.some((hour,index)=>!Number.isFinite(hour.time)||!Number.isFinite(new Date(hour.time).getTime())||(index>0&&hour.time<=hours[index-1].time)))throw new Error('Forecast unavailable.');
  return {version:1,source:'Open-Meteo',sourceURL:'https://open-meteo.com/',checkedAt,hours};
}
function validCached(value:unknown,now:number):value is WeatherForecast{
  if(!value||typeof value!=='object')return false;
  const item=value as WeatherForecast;
  const number=(value:unknown,min:number,max:number)=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
  return item.version===1&&item.source==='Open-Meteo'&&Number.isFinite(item.checkedAt)&&item.checkedAt<=now+60_000&&now-item.checkedAt<=WEATHER_MAX_AGE_MS&&Array.isArray(item.hours)&&item.hours.length>0&&item.hours.length<=500&&item.hours.every((hour,i)=>hour&&Number.isFinite(hour.time)&&Number.isFinite(new Date(hour.time).getTime())&&(!i||hour.time>item.hours[i-1].time)&&number(hour.temperature,-100,70)&&number(hour.rainProbability,0,100)&&number(hour.code,0,99));
}
export function readWeatherCache(location:WeatherLocation,now=Date.now()):WeatherForecast|undefined{
  const key=weatherCacheKey(location),cached=memory.get(key);if(cached&&validCached(cached,now))return cached;
  try{const value:unknown=JSON.parse(localStorage.getItem(key)??'null');if(validCached(value,now)){memory.set(key,value);return value;}localStorage.removeItem(key);}catch{/* Storage is optional. */}
  return undefined;
}
function saveWeatherCache(location:WeatherLocation,forecast:WeatherForecast){
  const key=weatherCacheKey(location);memory.set(key,forecast);while(memory.size>40)memory.delete(memory.keys().next().value!);
  try{const keys=Object.keys(localStorage).filter(value=>value.startsWith(CACHE_PREFIX));for(const old of keys){const value=JSON.parse(localStorage.getItem(old)??'null');if(!validCached(value,Date.now()))localStorage.removeItem(old);}while(keys.length>=40){const old=keys.shift();if(old&&old!==key)localStorage.removeItem(old);}localStorage.setItem(key,JSON.stringify(forecast));}catch{/* Quota failures do not block live weather. */}
}
export function forecastURL(location:WeatherLocation){
  const url=new URL('https://api.open-meteo.com/v1/forecast');
  url.search=new URLSearchParams({latitude:String(location.lat),longitude:String(location.lng),timezone:location.timezone,hourly:'temperature_2m,precipitation_probability,weather_code',timeformat:'unixtime',forecast_days:'11'}).toString();return url.toString();
}
export async function getWeatherForecast(location:WeatherLocation,options:{force?:boolean;now?:number}={}):Promise<WeatherForecast>{
  const now=options.now??Date.now(),key=weatherCacheKey(location),cached=readWeatherCache(location,now);
  if(!options.force&&cached&&now-cached.checkedAt<WEATHER_FRESH_MS)return cached;
  const existing=pending.get(key);if(existing)return existing;
  const task=(async()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12_000);try{const response=await fetch(forecastURL(location),{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});if(!response.ok)throw new Error('Weather could not refresh.');const forecast=parseForecast(await response.json(),Date.now());saveWeatherCache(location,forecast);return forecast;}finally{clearTimeout(timer);}})();
  pending.set(key,task);try{return await task;}finally{if(pending.get(key)===task)pending.delete(key);}
}
