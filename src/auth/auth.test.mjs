import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const load = async name => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString('base64')}`);
const { readAuthConfiguration } = await load('./config.ts');
const { createAuthController, safeReturnPath, authError, AUTH_RETURN_KEY } = await load('./controller.ts');
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`✓ ${name}`); }
const session = (id = 'alice') => ({ user: { id, email: `${id}@example.test`, user_metadata: { full_name: id, access_token: 'must-not-expose' } }, access_token: 'must-not-expose', refresh_token: 'must-not-expose' });
const ok = value => ({ data: { session: value }, error: null });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness(href = 'https://daytrail.example/?view=day#trip=abc', overrides = {}) {
  let currentHref = href, callback;
  const storage = new Map(), calls = { get: 0, exchange: [], oauth: [], signOut: [], navigate: [], unsubscribe: 0 };
  const client = {
    getSession: async () => { calls.get++; return ok(null); },
    completeCallback: async () => { calls.exchange.push(true); callback?.('SIGNED_IN', session()); return ok(session()); },
    signInWithOAuth: async input => { calls.oauth.push(input); return { data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google&state=private' }, error: null }; },
    signOut: async input => { calls.signOut.push(input); callback?.('SIGNED_OUT', null); return { error: null }; },
    onAuthStateChange: listener => { callback = listener; return () => { calls.unsubscribe++; }; },
    ...overrides,
  };
  const env = {
    href: () => currentHref,
    replaceURL: path => { currentHref = new URL(path, currentHref).href; },
    navigate: url => { calls.navigate.push(url); },
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: key => { storage.delete(key); } },
    now: () => 1_000_000,
    authOrigin: 'https://project.supabase.co',
  };
  return { client, env, calls, storage, emit: (event, value) => callback(event, value), controller: () => createAuthController(client, env) };
}

await check('configuration accepts only public hosted Supabase URL and publishable key', () => {
  const env = { VITE_SUPABASE_URL: 'https://project.supabase.co/', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789abcdefgh' };
  assert.equal(readAuthConfiguration(env).config.url, 'https://project.supabase.co');
  for (const key of ['', 'sb_secret_0123456789abcdefgh', 'eyJhbGciOi.service_role.signature', 'anon-token']) assert.equal(readAuthConfiguration({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: key }).config, null);
  for (const url of ['http://project.supabase.co', 'https://project.supabase.co.evil.test', 'https://user:password@project.supabase.co', 'https://project.supabase.co/?token=secret', 'https://project.supabase.co/path', 'https://project.supabase.co/#secret']) assert.equal(readAuthConfiguration({ ...env, VITE_SUPABASE_URL: url }).config, null);
  assert.equal(readAuthConfiguration({}).config, null);
});

await check('unconfigured auth never creates a fake session or attempts sign-in', async () => {
  const h = harness(), auth = createAuthController(null, h.env, 'Missing configuration');
  await auth.start();
  assert.equal(auth.getSnapshot().status, 'unconfigured');
  assert.equal(auth.getSnapshot().user, null);
  assert.equal(await auth.signIn(), false);
  assert.equal(await auth.signOut(), false);
  assert.equal(h.calls.get, 0);
});

await check('safe return paths reject external, protocol-relative, backslash and control paths', () => {
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/\n/evil', 'javascript:alert(1)', null]) assert.equal(safeReturnPath(path, 'https://daytrail.example'), null);
  assert.equal(safeReturnPath('/?view=day#trip=abc', 'https://daytrail.example'), '/?view=day#trip=abc');
});

await check('session restore exposes only display data and no tokens', async () => {
  const h = harness(undefined, { getSession: async () => ok(session()) }), auth = h.controller();
  await auth.start();
  assert.deepEqual(auth.getSnapshot().user, { id: 'alice', name: 'alice', email: 'alice@example.test' });
  assert.equal(auth.getSnapshot().status, 'signed-in');
  assert.ok(!JSON.stringify(auth.getSnapshot()).includes('must-not-expose'));
});

await check('Google redirect waits for local-save hook, preserves full return URL and deduplicates clicks', async () => {
  const h = harness(), auth = h.controller(), saved = deferred();
  const first = auth.signIn(() => saved.promise), second = auth.signIn();
  await Promise.resolve();
  assert.equal(h.calls.oauth.length, 0);
  saved.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(h.calls.oauth.length, 1);
  assert.deepEqual(h.calls.oauth[0], { provider: 'google', options: { redirectTo: 'https://daytrail.example/?auth=callback', skipBrowserRedirect: true } });
  assert.equal(JSON.parse(h.storage.get(AUTH_RETURN_KEY)).path, '/?view=day#trip=abc');
  assert.equal(auth.getSnapshot().pending, 'signing-in');
  await auth.signIn();
  assert.equal(h.calls.oauth.length, 1);
});

await check('failed trip flush prevents redirect and never calls OAuth', async () => {
  const h = harness(), auth = h.controller();
  assert.equal(await auth.signIn(() => { throw Error('unsaved data'); }), false);
  assert.equal(h.calls.oauth.length, 0);
  assert.equal(auth.getSnapshot().error.code, 'local-save');
});

await check('sign-in flushes edits made while the SDK prepares its redirect', async () => {
  const oauth = deferred(), started = deferred();
  const h = harness(undefined, { signInWithOAuth: () => { started.resolve(); return oauth.promise; } }), auth = h.controller();
  let latestTrip = 'original itinerary';
  const saves = [];
  const login = auth.signIn(() => { saves.push(latestTrip); });
  await started.promise;
  latestTrip = 'new note added while account panel was closed';
  oauth.resolve({ data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google' }, error: null });
  assert.equal(await login, true);
  assert.deepEqual(saves, ['original itinerary', 'new note added while account panel was closed']);
  assert.equal(h.calls.navigate.length, 1);
});

await check('failed final flush blocks navigation and removes pending return metadata', async () => {
  const h = harness(), auth = h.controller();
  let saves = 0;
  const login = auth.signIn(() => { saves++; if (saves === 2) throw Error('latest changes not saved'); });
  assert.equal(await login, false);
  assert.equal(saves, 2);
  assert.equal(h.calls.oauth.length, 1);
  assert.equal(h.calls.navigate.length, 0);
  assert.equal(h.storage.has(AUTH_RETURN_KEY), false);
  assert.equal(auth.getSnapshot().error.code, 'local-save');
  assert.equal(auth.getSnapshot().pending, null);
});

await check('return metadata follows a URL change while OAuth preparation is pending', async () => {
  const oauth = deferred(), started = deferred();
  const h = harness(undefined, { signInWithOAuth: () => { started.resolve(); return oauth.promise; } }), auth = h.controller();
  const login = auth.signIn();
  await started.promise;
  h.env.replaceURL('/?view=day#trip=new-shared-itinerary');
  h.env.now = () => 1_000_050;
  oauth.resolve({ data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google' }, error: null });
  assert.equal(await login, true);
  assert.deepEqual(JSON.parse(h.storage.get(AUTH_RETURN_KEY)), { path: '/?view=day#trip=new-shared-itinerary', createdAt: 1_000_050 });
  assert.equal(h.calls.navigate.length, 1);
});

await check('failed final return-metadata write blocks redirect and clears stale metadata', async () => {
  const oauth = deferred(), started = deferred();
  const h = harness(undefined, { signInWithOAuth: () => { started.resolve(); return oauth.promise; } }), auth = h.controller();
  const login = auth.signIn();
  await started.promise;
  assert.equal(h.storage.has(AUTH_RETURN_KEY), true);
  h.env.storage.setItem = () => { throw Error('storage became unavailable'); };
  oauth.resolve({ data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google' }, error: null });
  assert.equal(await login, false);
  assert.equal(h.calls.navigate.length, 0);
  assert.equal(h.storage.has(AUTH_RETURN_KEY), false);
  assert.equal(auth.getSnapshot().error.code, 'storage');
  assert.equal(auth.getSnapshot().pending, null);
});

await check('blocked return storage prevents a redirect and permits a later retry', async () => {
  const h = harness(), setItem = h.env.storage.setItem;
  h.env.storage.setItem = () => { throw Error('storage blocked'); };
  const auth = h.controller();
  assert.equal(await auth.signIn(), false);
  assert.equal(auth.getSnapshot().error.code, 'storage');
  h.env.storage.setItem = setItem;
  assert.equal(await auth.signIn(), true);
});

await check('unexpected SDK redirect origin or provider cannot navigate the browser', async () => {
  for (const url of ['https://evil.test/auth/v1/authorize?provider=google', 'https://project.supabase.co/auth/v1/authorize?provider=github', 'https://project.supabase.co/other?provider=google']) {
    const h = harness(undefined, { signInWithOAuth: async () => ({ data: { url }, error: null }) }), auth = h.controller();
    assert.equal(await auth.signIn(), false);
    assert.equal(h.calls.navigate.length, 0);
    assert.equal(h.storage.has(AUTH_RETURN_KEY), false);
  }
});

await check('StrictMode-like repeated initialization exchanges a callback exactly once and restores shared trip', async () => {
  const h = harness('https://daytrail.example/?auth=callback&code=private-code');
  h.storage.set(AUTH_RETURN_KEY, JSON.stringify({ path: '/?view=day#trip=encoded-copy', createdAt: h.env.now() }));
  const auth = h.controller();
  await Promise.all([auth.start(), auth.start(), auth.start()]);
  assert.deepEqual(h.calls.exchange, [true]);
  assert.equal(auth.getSnapshot().status, 'signed-in');
  assert.equal(h.env.href(), 'https://daytrail.example/?view=day#trip=encoded-copy');
  assert.equal(h.storage.has(AUTH_RETURN_KEY), false);
});

await check('callback cleanup preserves unrelated query fields and hash without valid return metadata', async () => {
  const h = harness('https://daytrail.example/?auth=callback&code=private-code&view=day#details');
  h.storage.set(AUTH_RETURN_KEY, JSON.stringify({ path: '//evil.test', createdAt: h.env.now() }));
  await h.controller().start();
  assert.equal(h.env.href(), 'https://daytrail.example/?view=day#details');
});

await check('expired or future return metadata cannot change the callback destination', async () => {
  for (const createdAt of [-1_000_000, 1_000_001]) {
    const h = harness('https://daytrail.example/?auth=callback&code=x&view=day');
    h.storage.set(AUTH_RETURN_KEY, JSON.stringify({ path: '/unexpected', createdAt }));
    await h.controller().start();
    assert.equal(h.env.href(), 'https://daytrail.example/?view=day');
  }
});

await check('Google cancellation is safe, readable, and strips provider error details', async () => {
  const h = harness('https://daytrail.example/?auth=callback&error=access_denied&error_description=SECRET&view=day#note'), auth = h.controller();
  await auth.start();
  assert.equal(auth.getSnapshot().error.code, 'cancelled');
  assert.equal(h.calls.exchange.length, 0);
  assert.equal(h.env.href(), 'https://daytrail.example/?view=day#note');
  assert.ok(!JSON.stringify(auth.getSnapshot()).includes('SECRET'));
  auth.dismissError();
  assert.equal(auth.getSnapshot().error, null);
});

await check('callback failure preserves an existing session without claiming the new sign-in succeeded', async () => {
  const h = harness('https://daytrail.example/?auth=callback&code=bad', {
    completeCallback: async () => ({ data: { session: null }, error: { code: 'flow_state_expired', message: 'SECRET' } }),
    getSession: async () => ok(session('existing')),
  }), auth = h.controller();
  await auth.start();
  assert.equal(auth.getSnapshot().user.id, 'existing');
  assert.equal(auth.getSnapshot().error.code, 'expired');
  assert.equal(h.env.href(), 'https://daytrail.example/');
});

await check('unconfigured callback still removes authentication query material', async () => {
  const h = harness('https://daytrail.example/?auth=callback&code=SECRET&view=day');
  await createAuthController(null, h.env, 'Not configured').start();
  assert.equal(h.env.href(), 'https://daytrail.example/?view=day');
});

await check('unrelated code query is never mistaken for an OAuth callback', async () => {
  const h = harness('https://daytrail.example/?code=user-code#trip=abc');
  await h.controller().start();
  assert.equal(h.calls.exchange.length, 0);
  assert.equal(h.env.href(), 'https://daytrail.example/?code=user-code#trip=abc');
});

await check('late getSession result cannot resurrect a session after a sign-out event', async () => {
  const wait = deferred(), h = harness(undefined, { getSession: () => wait.promise }), auth = h.controller();
  const started = auth.start();
  h.emit('SIGNED_OUT', null);
  wait.resolve(ok(session()));
  await started;
  assert.equal(auth.getSnapshot().status, 'signed-out');
  assert.equal(auth.getSnapshot().user, null);
});

await check('refresh and cross-tab sign-in update the visible account', async () => {
  const h = harness(), auth = h.controller();
  await auth.start();
  h.emit('SIGNED_IN', session('alice'));
  h.emit('TOKEN_REFRESHED', session('bob'));
  assert.equal(auth.getSnapshot().user.id, 'bob');
  h.emit('SIGNED_OUT', null);
  assert.equal(auth.getSnapshot().status, 'signed-out');
});

await check('local sign-out preserves all trip storage and uses local SDK scope', async () => {
  const h = harness(undefined, { getSession: async () => ok(session()) }), auth = h.controller();
  h.storage.set('daytrail.workspace.v1', 'precious trips');
  await auth.start();
  assert.equal(await auth.signOut(), true);
  assert.deepEqual(h.calls.signOut, [{ scope: 'local' }]);
  assert.equal(h.storage.get('daytrail.workspace.v1'), 'precious trips');
  assert.equal(auth.getSnapshot().status, 'signed-out');
});

await check('sign-out errors retain account state and present sanitized feedback', async () => {
  const h = harness(undefined, { getSession: async () => ok(session()), signOut: async () => ({ error: { message: 'SECRET' } }) }), auth = h.controller();
  await auth.start();
  assert.equal(await auth.signOut(), false);
  assert.equal(auth.getSnapshot().user.id, 'alice');
  assert.equal(auth.getSnapshot().error.code, 'sign-out');
  assert.ok(!JSON.stringify(auth.getSnapshot()).includes('SECRET'));
});

await check('session-check failure can be retried without starting Google sign-in', async () => {
  let fail = true;
  const h = harness(undefined, { getSession: async () => fail ? { data: { session: null }, error: { name: 'AuthRetryableFetchError' } } : ok(session()) }), auth = h.controller();
  await auth.start();
  assert.equal(auth.getSnapshot().error.code, 'network');
  fail = false;
  await auth.retry();
  assert.equal(auth.getSnapshot().status, 'signed-in');
  assert.equal(auth.getSnapshot().error, null);
  assert.equal(h.calls.oauth.length, 0);
});

await check('Back-navigation restoration clears pending redirect and allows another attempt', async () => {
  const h = harness(), auth = h.controller();
  await auth.signIn();
  await auth.resumeFromNavigation();
  assert.equal(auth.getSnapshot().pending, null);
  assert.equal(h.storage.has(AUTH_RETURN_KEY), false);
  await auth.signIn();
  assert.equal(h.calls.oauth.length, 2);
});

await check('opposite actions and refresh cannot race an in-progress sign-in', async () => {
  const h = harness(), auth = h.controller(), wait = deferred();
  const login = auth.signIn(() => wait.promise);
  assert.equal(await auth.signOut(), false);
  await auth.retry();
  wait.resolve();
  assert.equal(await login, true);
  assert.equal(h.calls.signOut.length, 0);
  assert.equal(h.calls.get, 1);
});

await check('only one session retry runs and cannot be overwritten by a competing action', async () => {
  const h = harness(), auth = h.controller();
  await auth.start();
  const wait = deferred();
  h.client.getSession = () => { h.calls.get++; return wait.promise; };
  const retry = auth.retry();
  await auth.retry();
  assert.equal(await auth.signOut(), false);
  assert.equal(await auth.signIn(), false);
  wait.resolve(ok(session()));
  await retry;
  assert.equal(h.calls.get, 2);
  assert.equal(auth.getSnapshot().status, 'signed-in');
  assert.equal(auth.getSnapshot().pending, null);
});

await check('controller disposal unsubscribes and ignores late events', async () => {
  const h = harness(), auth = h.controller();
  await auth.start();
  const before = auth.getSnapshot();
  auth.dispose();
  h.emit('SIGNED_IN', session());
  assert.equal(auth.getSnapshot(), before);
  assert.equal(h.calls.unsubscribe, 1);
});

await check('raw provider messages and unknown callback errors are never exposed', () => {
  for (const context of ['session', 'callback', 'sign-in', 'sign-out']) {
    assert.ok(!authError({ message: 'SECRET', code: 'SECRET' }, context).message.includes('SECRET'));
  }
});

await check('query and fragment provider exchange failures use fixed guidance and clean auth fields', async () => {
  for (const href of [
    'https://daytrail.example/?auth=callback&error=server_error&error_code=unexpected_failure&error_description=Unable%20to%20exchange%20external%20code%20SECRET&view=day#details',
    'https://daytrail.example/?auth=callback&view=day#error=server_error&error_code=unexpected_failure&error_description=Unable%20to%20exchange%20external%20code%20SECRET&tab=map',
  ]) {
    const h = harness(href), auth = h.controller();
    await auth.start();
    assert.equal(auth.getSnapshot().error.code, 'provider-exchange');
    assert.ok(auth.getSnapshot().error.message.includes('provider settings'));
    assert.ok(!JSON.stringify(auth.getSnapshot()).includes('SECRET'));
    assert.equal(h.calls.exchange.length, 0);
    assert.ok(!h.env.href().includes('error'));
    assert.ok(h.env.href().includes('view=day'));
  }
});

await check('fragment cancellation and flow identifiers are cleaned without removing unrelated fields', async () => {
  const h = harness('https://daytrail.example/?auth=callback&sb_flow_id=old-flow&view=day#error=access_denied&sb_flow_id=other-flow&tab=map'), auth = h.controller();
  await auth.start();
  assert.equal(auth.getSnapshot().error.code, 'cancelled');
  assert.equal(h.env.href(), 'https://daytrail.example/?view=day#tab=map');
});

await check('initial callback context survives SDK cleanup before controller initialization', async () => {
  const h = harness('https://daytrail.example/?auth=callback&code=already-exchanged&sb_flow_id=fake-flow&view=day#trip=abc');
  h.env.initialHref = h.env.href();
  h.env.replaceURL('/?auth=callback&view=day#trip=abc');
  const auth = h.controller();
  await auth.start();
  assert.equal(auth.getSnapshot().status, 'signed-in');
  assert.equal(h.calls.exchange.length, 1);
  assert.equal(h.env.href(), 'https://daytrail.example/?view=day#trip=abc');
});

await check('missing callback code cannot report success using a previously stored session', async () => {
  const h = harness('https://daytrail.example/?auth=callback', { getSession: async () => ok(session('existing')) }), auth = h.controller();
  await auth.start();
  assert.equal(h.calls.exchange.length, 0);
  assert.equal(auth.getSnapshot().error.code, 'callback');
  assert.equal(auth.getSnapshot().user.id, 'existing');
});

await check('known callback problems have safe specific messages while unknown codes stay generic', () => {
  for (const [code, expected] of [['pkce_code_verifier_not_found', 'verifier'], ['flow_state_not_found', 'expired'], ['flow_state_expired', 'expired'], ['invalid_client', 'google-config'], ['provider_disabled', 'provider'], ['RAW_UNKNOWN_VALUE', 'callback']]) {
    const error = authError({ code, message: 'SECRET raw provider content' }, 'callback');
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes('SECRET'));
    assert.ok(!error.message.includes('RAW_UNKNOWN_VALUE'));
  }
});

await check('prepared account opens offline without treating a stored identity as an online session',async()=>{
  const h=harness();h.env.online=()=>false;h.env.offlineProfile={read:()=>({id:'alice',name:'Alice'}),clear:()=>{}};const auth=h.controller();await auth.start();
  assert.equal(auth.getSnapshot().user.id,'alice');assert.equal(auth.getSnapshot().offline,true);assert.equal(h.calls.get,0);
});
await check('an unprepared browser cannot invent an offline account',async()=>{
  const h=harness(undefined,{getSession:async()=>{throw new TypeError('Offline');}});h.env.online=()=>false;h.env.offlineProfile={read:()=>null,clear:()=>{}};const auth=h.controller();await auth.start();
  assert.equal(auth.getSnapshot().user,null);assert.equal(auth.getSnapshot().offline,false);
});
await check('reconnection replaces local-only identity only after provider recovery',async()=>{
  let online=false,profile={id:'alice'};const h=harness(undefined,{getSession:async()=>ok(session('bob'))});h.env.online=()=>online;h.env.offlineProfile={read:()=>profile,clear:()=>{profile=null;}};const auth=h.controller();await auth.start();
  online=true;await auth.retry();assert.equal(auth.getSnapshot().user.id,'bob');assert.equal(auth.getSnapshot().offline,false);assert.equal(profile,null);
});
await check('explicit offline sign-out clears prepared resume even if SDK emits SIGNED_OUT offline',async()=>{
  let profile={id:'alice'};const h=harness();h.env.online=()=>false;h.env.offlineProfile={read:()=>profile,clear:()=>{profile=null;}};const auth=h.controller();await auth.start();
  assert.equal(await auth.signOut(),true);assert.equal(profile,null);assert.equal(auth.getSnapshot().user,null);assert.equal(auth.getSnapshot().offline,false);
});
await check('a rejected online session never falls back to an offline profile',async()=>{
  const h=harness(undefined,{getSession:async()=>({data:{session:null},error:{code:'invalid_session'}})});h.env.online=()=>true;h.env.offlineProfile={read:()=>({id:'alice'}),clear:()=>{}};const auth=h.controller();await auth.start();assert.equal(auth.getSnapshot().user,null);
});
console.log(`\n${passed} auth checks passed.`);
