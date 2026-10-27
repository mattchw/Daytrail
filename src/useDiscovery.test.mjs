import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const url = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const reactURL = url(`
  export const useState=initial=>globalThis.__discoveryHook.useState(initial);
  export const useRef=initial=>globalThis.__discoveryHook.useRef(initial);
  export const useEffect=(fn,deps)=>globalThis.__discoveryHook.useEffect(fn,deps);
  export const useCallback=(fn,deps)=>globalThis.__discoveryHook.useMemo(()=>fn,deps);
`);
const dataURL = url(`
  export const searchDiscoveryPage=(...args)=>globalThis.__discoveryData.search(...args);
  export const fetchDiscoveryDetails=id=>globalThis.__discoveryData.details(id);
`);
const source = ts.transpileModule(readFileSync(new URL('./useDiscovery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replace(/from (['"])([^'"]+)\1/g, (match, _, name) => {
  const target = { react: reactURL, './discoveryData': dataURL }[name];
  return target ? `from ${JSON.stringify(target)}` : match;
});
const { useDiscovery } = await import(url(source));
const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
function dispatcher() {
  let cursor = 0, disposed = false, lateWrites = 0;
  const slots = [], effects = [];
  const api = {
    useRef(initial) { const index = cursor++; return (slots[index] ??= { value: { current: initial } }).value; },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, next => {
        if (disposed) lateWrites++;
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
      }];
    },
    useMemo(fn, deps) { const index = cursor++; if (!slots[index] || !equalDeps(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; });
    },
    render(id, destination) {
      cursor = 0; globalThis.__discoveryHook = api;
      try { return useDiscovery(id, destination); } finally { delete globalThis.__discoveryHook; }
    },
    flush() { for (const effect of effects.splice(0)) effect(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); disposed = true; },
    get lateWrites() { return lateWrites; },
  };
  return api;
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const place = (id, options = {}) => ({ place: { id, name: id, googlePlaceId: id, ...options }, info: { photos: [], fetchedAt: 100 } });
const page = (results, nextPageToken) => ({ results, ...(nextPageToken ? { nextPageToken } : {}) });
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let online = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get onLine() { return online; } } });
function session() {
  online = true;
  const requests = [], details = [], hook = dispatcher();
  globalThis.__discoveryData = {
    search(...args) { const request = { args: structuredClone(args), ...deferred() }; requests.push(request); return request.promise; },
    details(id) { const request = { id, ...deferred() }; details.push(request); return request.promise; },
  };
  let id = 'trip-a', destination = 'Dublin';
  const api = {
    requests, details, hook,
    get view() { return hook.render(id, destination); },
    render(nextId = id, nextDestination = destination) { id = nextId; destination = nextDestination; return hook.render(id, destination); },
    flush: () => hook.flush(),
    dispose: () => hook.dispose(),
    async start(results = [place('a')], token = 'page-2') {
      const pending = api.view.search(); requests.at(-1).resolve(page(results, token)); await pending; return api.view;
    },
  };
  api.view; api.flush();
  return api;
}
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`✓ ${name}`); }

try {
  await check('next pages use the submitted query, category and copied map bounds despite draft edits', async () => {
    const s = session(), bounds = { north: 54, south: 53, west: -7, east: -6 };
    s.view.setQuery('riverside');
    const first = s.view.changeCategory('parks'); s.requests[0].resolve(page([place('a')], 'unused')); await first;
    const area = s.view.searchArea(bounds); bounds.north = 10;
    s.requests[1].resolve(page([place('b')], 'more-parks')); await area;
    s.view.setQuery('new draft');
    const more = s.view.loadMore();
    assert.deepEqual(s.requests[2].args, ['riverside', 'Dublin', 'parks', { north: 54, south: 53, west: -7, east: -6 }, 'more-parks']);
    s.requests[2].resolve(page([place('c')])); await more;
    assert.equal(s.view.query, 'new draft'); assert.equal(s.view.scope, 'area'); s.dispose();
  });
  await check('double taps share one page request and appending retains selection and scroll position', async () => {
    const s = session(); await s.start();
    s.view.setScrollTop(430); const key = s.view.resultsKey;
    const selecting = s.view.select(s.view.results[0]);
    const detail = { ...place('a'), info: { photos: [{ key: 'photo' }], fetchedAt: 200, regularHours: { periods: [] } } };
    s.details[0].resolve(detail); await selecting;
    const view = s.view, one = view.loadMore(), two = view.loadMore();
    assert.equal(s.requests.length, 2); assert.equal(s.view.loadingMore, true);
    s.requests[1].resolve(page([place('alias', { googlePlaceId: 'a' }), place('a', { googlePlaceId: 'another' }), place('b'), place('b')], 'page-3'));
    await Promise.all([one, two]);
    assert.deepEqual(s.view.results.map(value => value.place.id), ['a', 'b']);
    assert.equal(s.view.results[0], detail); assert.equal(s.view.selectedResult, detail);
    assert.equal(s.view.resultsKey, key); assert.equal(s.view.scrollTop, 430); assert.equal(s.view.hasMore, true); s.dispose();
  });
  await check('details completing during pagination remain enriched after the page is appended', async () => {
    const s = session(); await s.start();
    const more = s.view.loadMore(), selecting = s.view.select(s.view.results[0]);
    const detail = { ...place('a'), info: { photos: [], fetchedAt: 400, rating: 5 } };
    s.details[0].resolve(detail); await selecting;
    s.requests[1].resolve(page([place('a'), place('b')])); await more;
    assert.equal(s.view.results[0], detail); assert.equal(s.view.selectedResult, detail); s.dispose();
  });
  await check('a page failure keeps cards and the token so retry fetches the same page', async () => {
    const s = session(); await s.start(); s.view.setScrollTop(500);
    const more = s.view.loadMore(); s.requests[1].reject(new Error('network')); await more;
    assert.deepEqual(s.view.results.map(value => value.place.id), ['a']);
    assert.equal(s.view.loadingMore, false); assert.equal(s.view.hasMore, true); assert.match(s.view.moreError, /try again/);
    const retry = s.view.loadMore(); assert.deepEqual(s.requests[2].args, s.requests[1].args);
    s.requests[2].resolve(page([place('b')])); await retry;
    assert.equal(s.view.moreError, ''); assert.equal(s.view.scrollTop, 500); assert.equal(s.view.hasMore, false); s.dispose();
  });
  await check('offline pagination preserves available results and resumes after reconnect', async () => {
    const s = session(); await s.start(); online = false;
    await s.view.loadMore(); assert.equal(s.requests.length, 1); assert.match(s.view.moreError, /Connect/);
    assert.equal(s.view.hasMore, true); assert.equal(s.view.loadingMore, false); assert.equal(s.view.results.length, 1);
    online = true; const more = s.view.loadMore(); s.requests[1].resolve(page([place('b')])); await more;
    assert.equal(s.view.results.length, 2); assert.equal(s.view.moreError, ''); s.dispose();
  });
  await check('filtered empty pages still allow explicit continuation without automatic requests', async () => {
    const s = session(); await s.start([], 'page-2');
    assert.equal(s.view.hasMore, true); assert.equal(s.requests.length, 1);
    const more = s.view.loadMore(); s.requests[1].resolve(page([], 'page-3')); await more;
    assert.equal(s.view.hasMore, true); assert.equal(s.requests.length, 2);
    const last = s.view.loadMore(); s.requests[2].resolve(page([place('found')])); await last;
    assert.equal(s.view.results[0].place.id, 'found'); assert.equal(s.view.hasMore, false); s.dispose();
  });
  await check('repeated tokens and token cycles terminate pagination without discarding returned cards', async () => {
    const s = session(); await s.start();
    let more = s.view.loadMore(); s.requests[1].resolve(page([place('b')], 'page-3')); await more;
    more = s.view.loadMore(); s.requests[2].resolve(page([place('c')], 'page-2')); await more;
    assert.equal(s.view.hasMore, false); assert.equal(s.view.results.length, 3);
    await s.view.loadMore(); assert.equal(s.requests.length, 3); s.dispose();
    const repeated = session(); await repeated.start();
    more = repeated.view.loadMore(); repeated.requests[1].resolve(page([place('b')], 'page-2')); await more;
    assert.equal(repeated.view.hasMore, false); assert.equal(repeated.view.results.length, 2); repeated.dispose();
  });
  await check('a new category invalidates older pages without clearing the new page loading state', async () => {
    const s = session(); await s.start(); const stale = s.view.loadMore();
    const next = s.view.changeCategory('restaurants');
    assert.equal(s.view.loadingMore, false); assert.equal(s.view.hasMore, false);
    s.requests[2].resolve(page([place('food')], 'food-more')); await next;
    const current = s.view.loadMore(); assert.equal(s.view.loadingMore, true);
    s.requests[1].resolve(page([place('stale')], 'stale-more')); await stale;
    assert.deepEqual(s.view.results.map(value => value.place.id), ['food']); assert.equal(s.view.loadingMore, true);
    s.requests[3].resolve(page([place('food-2')])); await current;
    assert.deepEqual(s.view.results.map(value => value.place.id), ['food', 'food-2']); s.dispose();
  });
  await check('an obsolete page failure cannot replace the current search status', async () => {
    const s = session(); await s.start(); const stale = s.view.loadMore();
    const next = s.view.searchArea({ north: 54, south: 53, west: -7, east: -6 });
    s.requests[1].reject(new Error('old page')); await stale;
    assert.equal(s.view.loading, true); assert.equal(s.view.moreError, '');
    s.requests[2].resolve(page([place('new-area')])); await next;
    assert.equal(s.view.results[0].place.id, 'new-area'); s.dispose();
  });
  await check('late first-page responses cannot replace a newer search', async () => {
    const s = session(); const stale = s.view.search();
    s.view.setQuery('coffee'); const current = s.view.search();
    s.requests[1].resolve(page([place('coffee')], 'coffee-more')); await current;
    s.requests[0].resolve(page([place('old')], 'old-more')); await stale;
    assert.equal(s.view.results[0].place.id, 'coffee');
    const more = s.view.loadMore(); assert.equal(s.requests[2].args[4], 'coffee-more');
    s.requests[2].resolve(page([])); await more; s.dispose();
  });
  await check('trip identity changes reject old requests before effects and stale callbacks afterwards', async () => {
    const s = session(); await s.start(); const old = s.view, stale = old.loadMore();
    s.render('trip-b', 'Paris');
    s.requests[1].resolve(page([place('wrong-trip')])); await stale;
    assert.equal(s.view.results.some(value => value.place.id === 'wrong-trip'), false);
    s.flush(); assert.equal(s.view.results.length, 0); assert.equal(s.view.hasMore, false); assert.equal(s.view.loadingMore, false);
    await old.loadMore(); await old.search(); await old.changeCategory('restaurants');
    assert.equal(s.requests.length, 2); assert.equal(s.view.category, 'all');
    await s.start([place('paris')], 'paris-more');
    assert.equal(s.requests[2].args[1], 'Paris'); s.dispose();
  });
  await check('unmount prevents pending search, detail and pagination state writes', async () => {
    const s = session(); await s.start();
    const more = s.view.loadMore(), detail = s.view.select(s.view.results[0]);
    s.dispose(); s.requests[1].resolve(page([place('b')], 'more')); s.details[0].resolve(place('a'));
    await Promise.all([more, detail]); assert.equal(s.hook.lateWrites, 0);
    const initial = session(), searching = initial.view.search(); initial.dispose();
    initial.requests[0].resolve(page([place('late')], 'more')); await searching;
    assert.equal(initial.hook.lateWrites, 0);
  });
  await check('first pages deduplicate identities and no-token searches never request an extra page', async () => {
    const s = session(); await s.start([place('a'), place('alias', { googlePlaceId: 'a' }), place('b')], '');
    assert.deepEqual(s.view.results.map(value => value.place.id), ['a', 'b']); assert.equal(s.view.hasMore, false);
    await s.view.loadMore(); assert.equal(s.requests.length, 1); s.dispose();
  });
  await check('offline new searches clear pagination and retry the submitted query after reconnect', async () => {
    const s = session(); await s.start(); online = false;
    s.view.setQuery('new museum'); await s.view.search();
    assert.equal(s.view.hasMore, false); assert.equal(s.view.loadingMore, false); assert.match(s.view.error, /connection/);
    s.view.setQuery('unfinished edit'); online = true;
    const retry = s.view.retry(); assert.equal(s.requests[1].args[0], 'new museum');
    s.requests[1].resolve(page([place('museum')])); await retry;
    assert.equal(s.view.error, ''); s.dispose();
  });
  console.log(`\n${passed} discovery session checks passed.`);
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  delete globalThis.__discoveryData;
}
