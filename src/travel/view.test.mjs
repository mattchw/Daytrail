import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('./view.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.ES2022}}).outputText;
const {parseTravelView} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const value = {ownerId:'owner-a', scope:'account', tripId:'trip-a', dayId:'day-a', savedAt:1000};
test('travel view restores only the current owner and valid lifetime', () => {
  assert.deepEqual(parseTravelView(JSON.stringify(value), 'owner-a', 2000), value);
  assert.equal(parseTravelView(JSON.stringify(value), 'owner-b', 2000), null);
  assert.equal(parseTravelView(JSON.stringify(value), null, 2000), null);
  assert.equal(parseTravelView(JSON.stringify(value), 'owner-a', 999), null);
  assert.equal(parseTravelView(JSON.stringify(value), 'owner-a', 8 * 86400_000), null);
});
test('guest restoration cannot open an account view or malformed navigation', () => {
  const guest = {...value, ownerId:null, scope:'guest'};
  assert.deepEqual(parseTravelView(JSON.stringify(guest), null, 2000), guest);
  for (const raw of ['{', 'null', JSON.stringify({...guest,scope:'account'}), JSON.stringify({...guest,dayId:12}), JSON.stringify({...guest,savedAt:'1000'})]) assert.equal(parseTravelView(raw,null,2000),null);
});
