import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const compiled = new Map();
function moduleURL(path) {
  if (compiled.has(path)) return compiled.get(path);
  let source = ts.transpileModule(readFileSync(path, 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX}}).outputText;
  source = source.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm, '').replaceAll('import.meta.env', '({})');
  source = source.replace(/^((?:import|export)\s[^\n]*?\sfrom\s)(['"])([^'"]+)\2/gm, (_, prefix, quote, specifier) => {
    if (!specifier.startsWith('.')) return `${prefix}${JSON.stringify(import.meta.resolve(specifier))}`;
    const base = resolve(dirname(path), specifier), dependency = [base, `${base}.ts`, `${base}.tsx`].find(candidate => existsSync(candidate));
    return `${prefix}${JSON.stringify(moduleURL(dependency))}`;
  });
  const value = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  compiled.set(path, value); return value;
}
const root = dirname(fileURLToPath(import.meta.url));
const {mapFlightGeometry} = await import(moduleURL(resolve(root, 'MapPanel.tsx')));
const {createTrip} = await import(moduleURL(resolve(root, '../model.ts')));
const place = (id, lat, lng) => ({id, name:id, cat:'custom', area:'', typical:'', blurb:'', x:50, y:50, lat, lng});
const places = {hotel:place('hotel',53.34,-6.26),dublin:place('dublin',53.42,-6.27),cardiff:place('cardiff',51.40,-3.34)};
const moment = (date,time) => ({date,time,timezone:'Europe/Dublin'});
function fixture() {
  const trip = createTrip('Map check','Dublin','2026-11-01',3);
  trip.timezone='Europe/Dublin'; trip.customPlaces=places;
  trip.flights=[{id:'flight',fromPlaceId:'dublin',toPlaceId:'cardiff',departure:moment('2026-11-03','18:00'),arrival:moment('2026-11-03','19:00'),airportBufferMinutes:120,arrivalBufferMinutes:60}];
  return trip;
}
const airportIds = result => result.airports.map(place => place.id).sort();
let checks=0;
function check(name,run) {run();checks++;console.log(`✓ ${name}`);}

check('a ground departure boundary fits only the departure airport without a flight line',()=>{
  const trip=fixture(),day=trip.days[2];day.endPlaceId='dublin';day.finishBy=960;
  const result=mapFlightGeometry(day,places,[],trip,2);
  assert.deepEqual(airportIds(result),['dublin']);assert.deepEqual(result.paths,[]);assert.equal(result.hasFlights,false);
});
check('a ground arrival boundary excludes the remote origin airport',()=>{
  const trip=fixture(),day=trip.days[0],flight=trip.flights[0];
  Object.assign(flight,{fromPlaceId:'cardiff',toPlaceId:'dublin',departure:moment('2026-11-01','10:00'),arrival:moment('2026-11-01','11:00')});
  day.startPlaceId='dublin';day.startTime=720;
  const result=mapFlightGeometry(day,places,[],trip,0);
  assert.deepEqual(airportIds(result),['dublin']);assert.deepEqual(result.paths,[]);assert.equal(result.hasFlights,false);
});
check('a next-day departure buffer still shows only tonight’s local airport',()=>{
  const trip=fixture(),day=trip.days[2],flight=trip.flights[0];
  flight.departure=moment('2026-11-04','00:30');flight.arrival=moment('2026-11-04','01:30');
  day.endPlaceId='dublin';day.finishBy=1350;
  const result=mapFlightGeometry(day,places,[],trip,2);
  assert.deepEqual(airportIds(result),['dublin']);assert.deepEqual(result.paths,[]);
});
check('an actual airport-to-airport flight day retains both markers and its flight line',()=>{
  const trip=fixture(),day=trip.days[2];Object.assign(day,{startPlaceId:'dublin',endPlaceId:'cardiff',endMode:'flight',endFlightId:'flight'});
  const result=mapFlightGeometry(day,places,[],trip,2);
  assert.deepEqual(airportIds(result),['cardiff','dublin']);assert.equal(result.hasFlights,true);
  assert.deepEqual(result.paths,[[{lat:53.42,lng:-6.27},{lat:51.40,lng:-3.34}]]);
});
check('a linked flight followed by a ground journey retains only the actual flight segment',()=>{
  const trip=fixture(),day=trip.days[2];day.startPlaceId='dublin';
  const it={aid:'landing',placeId:'cardiff',duration:0,fixed:null,mode:'flight',note:'',flightId:'flight'};
  day.items=[it];
  const result=mapFlightGeometry(day,places,[{it,pl:places.cardiff}],trip,2);
  assert.deepEqual(airportIds(result),['cardiff','dublin']);assert.equal(result.paths.length,1);assert.equal(result.hasFlights,true);
});
check('an unapplied same-day booking does not zoom a ground plan out to remote airports',()=>{
  const trip=fixture();
  const result=mapFlightGeometry(trip.days[2],places,[],trip,2);
  assert.deepEqual(result.airports,[]);assert.deepEqual(result.paths,[]);assert.equal(result.hasFlights,false);
});
check('an overnight arrival shows the arrival airport without replaying the flight on its ground day',()=>{
  const trip=fixture(),flight=trip.flights[0];flight.departure=moment('2026-11-02','23:30');flight.arrival=moment('2026-11-03','00:30');
  const result=mapFlightGeometry(trip.days[2],places,[],trip,2);
  assert.deepEqual(airportIds(result),['cardiff']);assert.deepEqual(result.paths,[]);assert.equal(result.hasFlights,false);
});

console.log(`\n${checks} map flight geometry checks passed.`);
