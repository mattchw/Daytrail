import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const url = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64');
const compile = (path, modules = {}) => url(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
}).outputText.replace(/from (['"])([^'"]+)\1/g, (match, _, name) => modules[name] ? `from ${JSON.stringify(modules[name])}` : match));
const modelURL = compile('./model.ts'), sessionURL = compile('./placeHydration.ts');
const {createPlaceSession, providerOnlyPlace} = await import(sessionURL);
const {seedTrip} = await import(modelURL);
const place = (extra = {}) => ({id: 'google-shared', googlePlaceId: 'shared', name: 'Public museum', cat: 'attr', x: 50, y: 50,
  area: 'Public address', typical: '1 h', blurb: 'Public description', lat: 35, lng: 135,
  attributions: [{provider: 'Maps provider', providerURI: 'https://example.com/'}], ...extra});
const privatePlace = () => place({userLabel: 'A private meeting', userNotes: 'Apartment code 1234'});
const privateText = ['A private meeting', 'Apartment code 1234'];
const assertPrivateAbsent = value => { const json = JSON.stringify(value); for (const text of privateText) assert.equal(json.includes(text), false, text); };
let checks = 0;
async function check(name, test) { await test(); checks++; console.log(`✓ ${name}`); }

await check('provider projection excludes user fields and unknown attached state', () => {
  const clean = providerOnlyPlace({...privatePlace(), debug: 'Private debug', note: 'Other private text'});
  assert.equal(clean.name, 'Public museum');
  assert.equal(clean.googlePlaceId, 'shared');
  assert.equal(clean.userLabel, undefined); assert.equal(clean.userNotes, undefined);
  assert.equal(clean.debug, undefined); assert.equal(clean.note, undefined); assertPrivateAbsent(clean);
});
await check('registered previews preserve annotations without seeding a reusable provider result', () => {
  const session = createPlaceSession(); session.select('account-a'); session.register('account-a', privatePlace());
  assert.equal(session.read('account-a').registered['google-shared'].name, 'A private meeting');
  assert.equal(session.read('account-a').registered['google-shared'].blurb, 'Apartment code 1234');
  assert.deepEqual(session.read('account-a').resolved, {});
});
await check('account changes synchronously remove private previews and reject late writes', () => {
  const session = createPlaceSession(); session.select('account-a'); session.register('account-a', privatePlace());
  session.remember('account-a', 'google:shared', privatePlace()); session.select('account-b');
  assertPrivateAbsent(session.read('account-b'));
  assert.deepEqual(session.read('account-b').resolved, {});
  assert.equal(session.register('account-a', privatePlace()), false);
  assert.equal(session.remember('account-a', 'google:shared', privatePlace()), false);
  assertPrivateAbsent(session.read('account-b'));
});
await check('provider and preview caches do not retain caller-owned object references', () => {
  const input = privatePlace(), session = createPlaceSession(); session.select('account-a');
  session.register('account-a', input); session.remember('account-a', 'google:shared', input);
  input.userNotes = 'Changed later'; input.attributions[0].provider = 'Changed later';
  assert.equal(session.read('account-a').registered[input.id].userNotes, 'Apartment code 1234');
  assert.equal(session.read('account-a').registered[input.id].attributions[0].provider, 'Maps provider');
  assert.equal(session.read('account-a').resolved['google:shared'].attributions[0].provider, 'Maps provider');
});

// A small deterministic hook dispatcher exercises the actual hook's render and
// effect boundaries without a DOM or network. In particular we can render the
// next account before old effects are cleaned up, the privacy-sensitive window.
const reactURL = url(`
  export const useMemo = (fn, deps) => globalThis.__placeHook.useMemo(fn, deps);
  export const useCallback = (fn, deps) => useMemo(() => fn, deps);
  export const useState = initial => globalThis.__placeHook.useState(initial);
  export const useEffect = (fn, deps) => globalThis.__placeHook.useEffect(fn, deps);
`);
const serviceURL = url(`
  export const fetchPlace = id => globalThis.__placeFetch(id);
  export const findSamplePlace = async () => null;
`);
const hookURL = compile('./usePlaceData.ts', {'react': reactURL, './googleMaps': serviceURL, './model': modelURL, './placeHydration': sessionURL, './offline/connectivity': url('export const useConnectivity = () => globalThis.__placeOnline !== false;')});
const {usePlaceData} = await import(hookURL);
const equalDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
function harness() {
  let cursor = 0; const slots = [], effects = [];
  const api = {
    useMemo(fn, deps) { const index = cursor++; if (!slots[index] || !equalDeps(slots[index].deps, deps)) slots[index] = {value: fn(), deps}; return slots[index].value; },
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = {value: typeof initial === 'function' ? initial() : initial}; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useEffect(fn, deps) { const index = cursor++; if (!slots[index] || !equalDeps(slots[index].deps, deps)) { effects.push(() => { slots[index]?.cleanup?.(); slots[index] = {deps, cleanup: fn()}; }); } },
    render(trip, isolationKey, enabled = false) { cursor = 0; globalThis.__placeHook = api; try { return usePlaceData(trip, 0, enabled, isolationKey); } finally { delete globalThis.__placeHook; } },
    flushEffects() { for (const effect of effects.splice(0)) effect(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
  return api;
}
const itinerary = (id = 'same-trip-id', annotations = {}) => {
  const trip = seedTrip(); trip.id = id;
  trip.days = [{...trip.days[0], items: [{...trip.days[0].items[0], placeId: 'google-shared'}]}];
  trip.ideas = []; trip.customPlaces = {'google-shared': place({name: 'Saved place', blurb: '', ...annotations})};
  return trip;
};
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

await check('the actual hook cannot inherit annotations for the same Google place across accounts before effects run', () => {
  const hook = harness(), tripA = itinerary('same-trip-id', {userLabel: 'A private meeting', userNotes: 'Apartment code 1234'}), tripB = itinerary();
  const a = hook.render(tripA, 'account-a'); hook.flushEffects(); a.register(privatePlace());
  assert.equal(hook.render(tripA, 'account-a').places['google-shared'].userNotes, 'Apartment code 1234');
  const b = hook.render(tripB, 'account-b');
  assertPrivateAbsent(b.places); assert.equal(b.places['google-shared'].userNotes, undefined);
  a.register({...privatePlace(), id: 'old-account-preview'});
  assert.equal(hook.render(tripB, 'account-b').places['old-account-preview'], undefined);
  assertPrivateAbsent(hook.render(tripB, 'account-b').places); hook.dispose();
});
await check('same-account trip changes and returning to an account create fresh preview sessions', () => {
  const hook = harness(), first = itinerary('first-trip'), second = itinerary('second-trip');
  const a = hook.render(first, 'account-a'); a.register({...privatePlace(), id: 'preview-private'});
  assert.equal(hook.render(first, 'account-a').places['preview-private'].name, 'A private meeting');
  assert.equal(hook.render(second, 'account-a').places['preview-private'], undefined);
  hook.render(second, 'account-b');
  const returned = hook.render(first, 'account-a'); a.register({...privatePlace(), id: 'late-private'});
  assert.equal(returned.places['preview-private'], undefined);
  assert.equal(hook.render(first, 'account-a').places['late-private'], undefined); hook.dispose();
});
await check('late hydration from a previous account cannot populate the new render or its loading state', async () => {
  let resolve; globalThis.__placeFetch = () => new Promise(yes => { resolve = yes; });
  const hook = harness(), value = itinerary();
  hook.render(value, 'account-a', true); hook.flushEffects();
  hook.render(value, 'account-b', false);
  resolve(privatePlace()); await settle();
  const b = hook.render(value, 'account-b', false);
  assertPrivateAbsent(b.places); assert.equal(b.loading, false); assert.equal(b.error, null); hook.dispose();
});
await check('hydration merges provider details with only the current trip’s private annotations', async () => {
  globalThis.__placeFetch = async () => privatePlace();
  const hook = harness(), value = itinerary('current-trip', {userLabel: 'My own label', userNotes: ''});
  hook.render(value, 'current-account', true); hook.flushEffects(); await settle();
  const current = hook.render(value, 'current-account', true).places['google-shared'];
  assert.equal(current.name, 'My own label'); assert.equal(current.blurb, '');
  assert.equal(current.userLabel, 'My own label'); assert.equal(current.userNotes, '');
  assertPrivateAbsent(current); hook.dispose();
});
await check('hydration preserves current admission cutoffs and cannot revive a cleared cutoff',async()=>{
 globalThis.__placeFetch=async()=>({...privatePlace(),lastEntryMinutes:{1:800}});
 const hook=harness(),value=itinerary('admission-trip',{lastEntryMinutes:{1:990}});
 hook.render(value,'current-account',true);hook.flushEffects();await settle();
 assert.deepEqual(hook.render(value,'current-account',true).places['google-shared'].lastEntryMinutes,{1:990});
 const updated=structuredClone(value);delete updated.customPlaces['google-shared'].lastEntryMinutes;
 assert.equal(hook.render(updated,'current-account',true).places['google-shared'].lastEntryMinutes,undefined);
 hook.dispose();
});
await check('offline renders authored details without a new provider request', async () => {
  let calls=0; globalThis.__placeFetch=async()=>{calls++;return privatePlace();};
  const hook=harness(),value=itinerary('offline-trip',{offlineDetails:{name:'My saved museum',address:'Booking address',localAddress:'Local address',hours:'09:00–17:00'}});
  globalThis.__placeOnline=false;
  hook.render(value,'current-account',true);hook.flushEffects();await settle();
  const result=hook.render(value,'current-account',true);
  assert.equal(calls,0);assert.equal(result.places['google-shared'].name,'My saved museum');
  assert.equal(result.places['google-shared'].area,'Booking address');assert.equal(result.loading,false);
  hook.dispose();delete globalThis.__placeOnline;
});
delete globalThis.__placeFetch;
console.log(`\n${checks} place privacy checks passed.`);
