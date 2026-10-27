import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the installed SDK with isolated browser storage and a fake transport.
// No configured project, real credentials, or network request is used.
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const modules = { '../offline/profile':dataURL(compile('../offline/profile.ts')), './config': dataURL(compile('./config.ts')), './controller': dataURL(compile('./controller.ts')), '@supabase/supabase-js': import.meta.resolve('@supabase/supabase-js') };
const browserURL = dataURL(compile('./browser.ts').replaceAll('import.meta.env', '({})').replace(/from (['"])([^'"]+)\1/g, (match, _, name) => modules[name] ? `from ${JSON.stringify(modules[name])}` : match));
const { createSupabaseAuthAdapter } = await import(browserURL);
const { createAuthController } = await import(modules['./controller']);
const config = { url: 'https://fake-project.supabase.co', publishableKey: 'sb_publishable_fake_public_key_for_isolated_tests' };
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function fakeSession(id = 'new-user', expired = false) {
  const expires_at = Math.floor(Date.now() / 1000) + (expired ? -100 : 3600);
  return { access_token: `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: id, aud: 'authenticated', exp: expires_at })}.fake-signature`,
    refresh_token: 'fake-refresh', expires_in: 3600, expires_at, token_type: 'bearer',
    user: { id, email: `${id}@example.test`, aud: 'authenticated', app_metadata: { provider: 'google' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' } });
let fixtureId = 0;
function fixture({ existing, verifier = true, flowId, href = 'http://localhost:5182/?auth=callback&code=fake-one-use-code&view=day', failure } = {}) {
  const memory = new Map(), calls = [], removals = [];
  const storageKey = `daytrail-isolated-sdk-${++fixtureId}`;
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => { removals.push(key); memory.delete(key); } };
  if (existing) memory.set(storageKey, JSON.stringify(existing));
  if (verifier) memory.set(storageKey + '-code-verifier', JSON.stringify('a'.repeat(64)));
  if (flowId) {
    href += `&sb_flow_id=${flowId}`;
    memory.set(`${storageKey}-flow-${flowId}-code-verifier`, JSON.stringify('a'.repeat(64)));
    memory.set(`${storageKey}-flows-code-verifier`, JSON.stringify([flowId]));
    memory.set(storageKey + '-code-verifier', JSON.stringify('b'.repeat(64)));
  }
  globalThis.localStorage = storage;
  globalThis.window = { location: { href }, localStorage: storage,
    history: { state: null, replaceState(_state, _title, url) { window.location.href = new URL(url, window.location.href).href; } },
    addEventListener() {}, removeEventListener() {} };
  globalThis.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} };
  globalThis.BroadcastChannel = undefined;
  const initialHref = href;
  const adapter = createSupabaseAuthAdapter(config, initialHref, { storage, storageKey, fetch: async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const kind = url.searchParams.get('grant_type');
    calls.push(kind);
    if (kind === 'refresh_token') return response({ code: 'refresh_token_not_found', msg: 'Fake expired refresh rejected' }, 400);
    assert.equal(kind, 'pkce', 'Only the expected mocked token endpoint may be called');
    const body = JSON.parse(init.body);
    assert.equal(body.auth_code, 'fake-one-use-code');
    assert.equal(body.code_verifier, 'a'.repeat(64));
    assert.ok(memory.has(storageKey + '-code-verifier'), 'Verifier must survive until the token request');
    return failure ? response({ code: failure, msg: 'SECRET provider response must not appear in UI' }, 400) : response(fakeSession());
  } });
  const controller = createAuthController(adapter.port, {
    initialHref, href: () => window.location.href,
    replaceURL: path => window.history.replaceState(null, '', path),
    navigate: () => { throw Error('Tests must not navigate to an OAuth provider'); },
    storage, now: () => Date.now(), authOrigin: config.url,
  });
  return { controller, adapter, calls, memory, storageKey, removals, initialHref,
    dispose: async () => { controller.dispose(); await adapter.dispose(); } };
}
const originals = Object.fromEntries(['window', 'document', 'localStorage', 'BroadcastChannel', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
globalThis.fetch = async () => { throw Error('Unmocked network access is forbidden in auth integration tests'); };
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`✓ ${name}`); }
try {
  for (const [name, existing] of [['fresh browser', undefined], ['invalid saved session', {}], ['expired and revoked saved session', fakeSession('old-user', true)]]) {
    await check(`real SDK exchanges once before cleaning an ${name}`, async () => {
      const f = fixture({ existing });
      try {
        await Promise.all([f.controller.start(), f.controller.start(), f.controller.start()]);
        assert.deepEqual(f.calls, ['pkce']);
        assert.equal(f.controller.getSnapshot().status, 'signed-in');
        assert.equal(f.controller.getSnapshot().user.id, 'new-user');
        assert.equal(f.controller.getSnapshot().error, null);
        assert.equal(window.location.href, 'http://localhost:5182/?view=day');
      } finally { await f.dispose(); }
    });
  }
  await check('SDK completion before React initialization still yields one successful callback', async () => {
    const f = fixture();
    try {
      const completed = await f.adapter.port.completeCallback();
      assert.equal(completed.error, null);
      assert.equal(new URL(window.location.href).searchParams.has('code'), false);
      await f.controller.start();
      assert.equal(f.controller.getSnapshot().user.id, 'new-user');
      assert.equal(f.controller.getSnapshot().error, null);
      assert.deepEqual(f.calls, ['pkce']);
    } finally { await f.dispose(); }
  });
  await check('missing verifier cannot reuse an old session as successful callback completion', async () => {
    const f = fixture({ verifier: false, existing: fakeSession('old-user') });
    try {
      await f.controller.start();
      assert.deepEqual(f.calls, []);
      assert.equal(f.controller.getSnapshot().error.code, 'verifier');
      assert.notEqual(f.controller.getSnapshot().user?.id, 'new-user');
    } finally { await f.dispose(); }
  });
  await check('provider exchange failure in query and fragment gets fixed guidance with no token request', async () => {
    const f = fixture({ href: 'http://localhost:5182/?auth=callback&error=server_error&error_code=unexpected_failure&view=day#error=server_error&error_description=Unable%20to%20exchange%20external%20code%20SECRET&tab=map' });
    try {
      await f.controller.start();
      assert.deepEqual(f.calls, []);
      assert.equal(f.controller.getSnapshot().error.code, 'provider-exchange');
      assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('SECRET'));
      assert.equal(window.location.href, 'http://localhost:5182/?view=day#tab=map');
    } finally { await f.dispose(); }
  });
  await check('expired or reused PKCE code remains a failure with a previously signed-in user', async () => {
    const f = fixture({ existing: fakeSession('old-user'), failure: 'flow_state_expired' });
    try {
      await f.controller.start();
      assert.deepEqual(f.calls, ['pkce']);
      assert.equal(f.controller.getSnapshot().error.code, 'expired');
      assert.notEqual(f.controller.getSnapshot().user?.id, 'new-user');
      assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes('SECRET'));
    } finally { await f.dispose(); }
  });
  await check('SDK uses the matching flow verifier and callback cleanup removes its identifier', async () => {
    const f = fixture({ flowId: 'isolated-flow-12345' });
    try {
      await f.controller.start();
      assert.deepEqual(f.calls, ['pkce']);
      assert.equal(f.controller.getSnapshot().error, null);
      assert.equal(new URL(window.location.href).searchParams.has('sb_flow_id'), false);
    } finally { await f.dispose(); }
  });
  await check('an unrelated code URL never triggers the SDK callback exchange', async () => {
    const f = fixture({ href: 'http://localhost:5182/?code=unrelated-user-code#trip=example' });
    try {
      await f.controller.start();
      assert.deepEqual(f.calls, []);
      assert.equal(f.controller.getSnapshot().status, 'signed-out');
      assert.equal(window.location.href, f.initialHref);
    } finally { await f.dispose(); }
  });
} finally {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
console.log(`\n${passed} real-SDK auth integration checks passed.`);
