import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const mapsURL = dataURL(compile('./googleMaps.ts').replaceAll('import.meta.env', '({})'));
const resolverURL = dataURL(compile('./destinationMap.ts').replace(/from ['"]\.\/googleMaps['"]/g, `from ${JSON.stringify(mapsURL)}`));
const { createDestinationResolver } = await import(resolverURL);
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`✓ ${name}`); }

const cityBounds = { north: 35.3, south: 34.8, east: 136, west: 135.5 };
const place = (options = {}) => ({
  location: { lat: () => 35.01, lng: () => 135.77 },
  viewport: { toJSON: () => cityBounds },
  types: ['locality', 'political'],
  ...options,
});
function harness(search = async () => ({ places: [place()] }), clock = Date.now) {
  const requests = [], libraries = [];
  let loads = 0;
  const resolve = createDestinationResolver(async () => {
    loads++;
    return { importLibrary: async name => {
      libraries.push(name);
      return { Place: { searchByText: request => { requests.push(request); return search(request); } } };
    } };
  }, clock);
  return { resolve, requests, libraries, get loads() { return loads; } };
}

await check('destination lookup uses the exact trimmed query and only required provider fields', async () => {
  const h = harness();
  const result = await h.resolve('  Kyoto, Japan  ');
  assert.deepEqual(result, { center: { lat: 35.01, lng: 135.77 }, bounds: cityBounds });
  assert.deepEqual(h.libraries, ['places']);
  assert.deepEqual(h.requests, [{ textQuery: 'Kyoto, Japan', fields: ['location', 'viewport', 'types', 'attributions'], maxResultCount: 8, language: 'en' }]);
  assert.equal(await h.resolve('   '), null);
  assert.equal(h.loads, 1);
});

await check('geographic destinations win over businesses sharing the query name', async () => {
  const business = place({ location: { lat: () => 40, lng: () => -70 }, types: ['restaurant', 'establishment'] });
  for (const type of ['locality', 'postal_town', 'administrative_area_level_1', 'administrative_area_level_7', 'country', 'continent', 'political', 'sublocality_level_2', 'natural_feature']) {
    const h = harness(async () => ({ places: [business, place({ types: [type] })] }));
    assert.deepEqual((await h.resolve('Destination')).center, { lat: 35.01, lng: 135.77 }, type);
  }
  const fallback = harness(async () => ({ places: [business] }));
  assert.deepEqual((await fallback.resolve('A named resort')).center, { lat: 40, lng: -70 });
});

await check('region viewports retain antimeridian bounds and city centers work without a viewport', async () => {
  const bounds = { north: -12, south: -21, east: -178, west: 176 };
  const region = harness(async () => ({ places: [place({ location: { lat: () => -17.7, lng: () => 178.1 }, viewport: { toJSON: () => bounds }, types: ['country'] })] }));
  assert.deepEqual(await region.resolve('Fiji'), { center: { lat: -17.7, lng: 178.1 }, bounds });
  for (const viewport of [null, undefined]) {
    const city = harness(async () => ({ places: [place({ viewport })] }));
    assert.deepEqual(await city.resolve('Kyoto'), { center: { lat: 35.01, lng: 135.77 } });
  }
});

await check('invalid provider coordinates and bounds are rejected rather than becoming a map position', async () => {
  const bad = [
    null, {}, place({ location: null }), place({ location: { lat: () => NaN, lng: () => 0 } }),
    place({ location: { lat: () => 91, lng: () => 0 } }), place({ location: { lat: () => 0, lng: () => 181 } }),
    place({ location: { lat: () => '35', lng: () => 135 } }), place({ location: { lat: () => 0, lng: () => Infinity } }),
    ...[
      { ...cityBounds, north: NaN }, { ...cityBounds, south: -91 }, { ...cityBounds, east: 181 },
      { ...cityBounds, west: -181 }, { ...cityBounds, north: 30 }, { ...cityBounds, north: cityBounds.south },
      { ...cityBounds, east: cityBounds.west }, null, {},
    ].map(bounds => place({ viewport: { toJSON: () => bounds } })),
    place({ viewport: { toJSON: () => { throw Error('bad provider value'); } } }),
  ];
  for (const result of bad) {
    const h = harness(async () => ({ places: [result] }));
    assert.equal(await h.resolve('Destination'), null);
  }
  const skipsBad = harness(async () => ({ places: [...bad, place()] }));
  assert.deepEqual((await skipsBad.resolve('Destination')).center, { lat: 35.01, lng: 135.77 });
});

await check('attributions retain provider names and safe links without arbitrary metadata', async () => {
  const h = harness(async () => ({ places: [place({ attributions: [
    { provider: 'Example provider', providerURI: 'https://example.com/credit' },
    { provider: 'Example provider', providerURI: 'https://example.com/credit' },
    { provider: 'Unsafe URL', providerURI: 'javascript:alert(1)' },
    { provider: 'Credentials', providerURI: 'https://user:password@example.com/' },
    { provider: '  Name only  ' }, { provider: '' }, { provider: null }, null,
  ], displayName: 'Unneeded name', photos: ['unneeded-photo'] })] }));
  assert.deepEqual((await h.resolve('Destination')).attributions, [
    { provider: 'Example provider', providerURI: 'https://example.com/credit' },
    { provider: 'Unsafe URL' }, { provider: 'Credentials' }, { provider: 'Name only' },
  ]);
});

await check('concurrent callers share one lookup and successful results expire after ten minutes', async () => {
  let time = 0, release;
  const h = harness(() => new Promise(resolve => { release = resolve; }), () => time);
  const first = h.resolve('Kyoto'), concurrent = h.resolve(' Kyoto ');
  assert.equal(first, concurrent);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.requests.length, 1);
  release({ places: [place()] });
  const view = await first;
  time = 10 * 60_000 - 1;
  assert.equal(await h.resolve('Kyoto'), view);
  assert.equal(h.requests.length, 1);
  time++;
  const fresh = h.resolve('Kyoto');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.requests.length, 2);
  release({ places: [place()] });
  assert.deepEqual(await fresh, view);
});

await check('failed and empty results are retryable and provider secrets never cross the error boundary', async () => {
  let calls = 0;
  const h = harness(async () => {
    if (++calls === 1) throw { code: 'PERMISSION_DENIED', message: 'secret request URL with API key' };
    if (calls === 2) return { places: [] };
    return { places: [place()] };
  });
  await assert.rejects(h.resolve('Kyoto'), error => /access was denied/.test(error.message) && !/secret|API key/.test(error.message));
  assert.equal(await h.resolve('Kyoto'), null);
  assert.ok(await h.resolve('Kyoto'));
  assert.equal(h.requests.length, 3);
  const quota = harness(async () => { throw { code: 'OVER_QUERY_LIMIT', message: 'internal details' }; });
  await assert.rejects(quota.resolve('Kyoto'), /usage limit/);
});

await check('lookups time out safely and a timeout does not poison the retry cache', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let calls = 0;
  const h = harness(() => ++calls === 1 ? new Promise(() => {}) : Promise.resolve({ places: [place()] }));
  const timer = {};
  try {
    globalThis.setTimeout = callback => { queueMicrotask(callback); return timer; };
    globalThis.clearTimeout = value => { assert.equal(value, timer); };
    await assert.rejects(h.resolve('Kyoto'), /Place search is unavailable/);
  } finally {
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
  }
  assert.ok(await h.resolve('Kyoto'));
  assert.equal(h.requests.length, 2);
});

await check('successful destination cache stays bounded and cache data is isolated between resolver instances', async () => {
  const h = harness();
  for (let index = 0; index < 201; index++) await h.resolve('Destination ' + index);
  assert.equal(h.requests.length, 201);
  await h.resolve('Destination 200');
  assert.equal(h.requests.length, 201);
  await h.resolve('Destination 0');
  assert.equal(h.requests.length, 202);
  const separate = harness();
  await separate.resolve('Destination 0');
  assert.equal(separate.requests.length, 1);
});

console.log(`${passed} destination-map checks passed.`);
