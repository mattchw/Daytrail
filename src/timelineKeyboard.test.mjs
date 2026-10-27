import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('./timelineKeyboard.ts', import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
}).outputText;
const {timelineKeyboardCoordinates} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const rect = (left, top, width = 400, height = 50) => ({left, top, width, height});
const target = (id, type, rectangle, disabled = false) => ({id, data: {current: {type}}, disabled, rectangle});
function navigate(code, targets, options = {}) {
  let prevented = false;
  const containers = new Map(targets.map(entry => [entry.id, entry]));
  containers.getEnabled = () => [...containers.values()].filter(entry => !entry.disabled);
  const result = timelineKeyboardCoordinates({code, preventDefault: () => {prevented = true;}}, {
    context: {active: {id: options.activeId || 'idea:favourite'},
      collisionRect: options.collisionRect || rect(200, 200, 400, 200),
      droppableContainers: containers,
      droppableRects: new Map(targets.filter(entry => entry.rectangle).map(entry => [entry.id, entry.rectangle])),
      over: options.overId ? {id: options.overId} : null},
  });
  return {result, prevented};
}
let passed = 0;
function check(name, run) {run(); passed++; console.log(`✓ ${name}`);}

check('a plain Idea draggable reaches the next insertion point without a matching droppable', () => {
  const {result, prevented} = navigate('ArrowDown', [target('gap', 'insertion', rect(200, 450))]);
  assert.deepEqual(result, {x: 200, y: 375}); assert.equal(prevented, true);
});
check('a tall activity is centered on the narrow gap instead of overlapping the next stop center', () => {
  const {result} = navigate('ArrowDown', [target('gap', 'insertion', rect(200, 450)), target('next-stop', 'activity', rect(200, 500, 400, 240))], {activeId: 'act:stop'});
  assert.deepEqual({x: result.x + 200, y: result.y + 100}, {x: 400, y: 475});
});
check('vertical arrows prefer itinerary gaps and obey direction', () => {
  const targets = [target('above', 'insertion', rect(200, 100)), target('below', 'insertion', rect(200, 450)), target('day', 'day', rect(200, 320))];
  assert.deepEqual(navigate('ArrowDown', targets).result, {x: 200, y: 375});
  assert.deepEqual(navigate('ArrowUp', targets).result, {x: 200, y: 25});
});
check('horizontal arrows reach day tabs and Ideas without choosing nearby map or activity nodes', () => {
  const targets = [target('right-gap', 'insertion', rect(650, 250)), target('day', 'day', rect(650, 250, 100, 80)), target('map', 'map', rect(610, 250, 100, 80)), target('left-ideas', 'ideas', rect(0, 250, 100, 80))];
  assert.deepEqual(navigate('ArrowRight', targets).result, {x: 500, y: 190});
  assert.deepEqual(navigate('ArrowLeft', targets).result, {x: -150, y: 190});
});
check('navigation ignores the current target, active item, disabled and unmeasured gaps', () => {
  const targets = [target('current', 'insertion', rect(200, 320)), target('idea:favourite', 'insertion', rect(200, 350)), target('disabled', 'insertion', rect(200, 360), true), target('missing', 'insertion'), target('hidden', 'insertion', rect(200, 370, 0, 0)), target('invalid', 'insertion', rect(200, NaN)), target('next', 'insertion', rect(200, 450))];
  assert.deepEqual(navigate('ArrowDown', targets, {overId: 'current'}).result, {x: 200, y: 375});
});
check('the nearest directional gap wins while unrelated drop targets are ignored', () => {
  const targets = [target('far', 'insertion', rect(200, 700)), target('near', 'insertion', rect(200, 450)), target('stop', 'activity', rect(200, 310)), target('map', 'map', rect(200, 320))];
  assert.deepEqual(navigate('ArrowDown', targets).result, {x: 200, y: 375});
});
check('an edge can fall back to the Ideas tray, with no wrap to the opposite direction', () => {
  const targets = [target('last-gap', 'insertion', rect(200, 100)), target('ideas', 'ideas', rect(200, 500, 400, 100))];
  assert.deepEqual(navigate('ArrowDown', targets).result, {x: 200, y: 450});
  assert.equal(navigate('ArrowDown', [targets[0]]).result, undefined);
});
check('drop and cancel keys remain owned by KeyboardSensor', () => {
  for (const code of ['Space', 'Enter', 'Escape', 'Tab']) {
    const result = navigate(code, [target('gap', 'insertion', rect(200, 450))]);
    assert.equal(result.result, undefined); assert.equal(result.prevented, false);
  }
});
console.log(`\n${passed} timeline keyboard checks passed.`);
