import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

const dataURL=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
// Observe the existing drop-target contract without needing a browser or changing a trip.
const dndURL=dataURL(`export const calls=[]; let over=false; export const setOver=value=>{over=value;}; export function useDroppable(options){calls.push(options);return {setNodeRef:()=>{},isOver:over};}`);
const dnd=await import(dndURL);
const compiled=new Map();
function moduleURL(path){
  if(compiled.has(path))return compiled.get(path);
  let source=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  source=source.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm,'').replaceAll('import.meta.env','({})');
  source=source.replace(/^((?:import|export)\s[^\n]*?\sfrom\s)(['"])([^'"]+)\2/gm,(_,prefix,quote,specifier)=>{
    if(specifier==='@dnd-kit/core')return `${prefix}${JSON.stringify(dndURL)}`;
    if(!specifier.startsWith('.'))return `${prefix}${JSON.stringify(import.meta.resolve(specifier))}`;
    const base=resolve(dirname(path),specifier),dependency=[base,`${base}.ts`,`${base}.tsx`].find(value=>existsSync(value));
    return `${prefix}${JSON.stringify(moduleURL(dependency))}`;
  });
  const result=dataURL(source);compiled.set(path,result);return result;
}
const component=await import(moduleURL(resolve(dirname(fileURLToPath(import.meta.url)),'TripDayTab.tsx')));
const TripDayTab=component.default??component.TripDayTab;
const day={id:'day-two',label:'Day 2',date:'Wed 28',title:'Dublin',endMode:'walk',items:Array.from({length:5},(_,index)=>({aid:`visit-${index}`,placeId:`place-${index}`,duration:60,fixed:null,mode:'walk',note:''}))};
const schedule={finish:1172,finishApprox:false,late:0};
const props={day,index:1,active:true,onClick:()=>{},live:schedule};
const render=(overrides={})=>renderToStaticMarkup(React.createElement(TripDayTab,{...props,...overrides}));
const countSlots=html=>(html.match(/class="[^"]*\bday-tab-count\b[^"]*"/g)||[]).length;
const finishSlots=html=>(html.match(/class="[^"]*\bday-return\b[^"]*"/g)||[]).length;
const finishSlot=html=>html.match(/<[^>]*class="[^"]*\bday-return\b[^"]*"[^>]*>[^<]*<\/[^>]+>/)?.[0];

test('four-day navigation retains every summary slot through recalculation and day changes',()=>{
  for(const selected of [0,1,3])for(const status of ['ready','loading','unknown']){
    const html=renderToStaticMarkup(React.createElement('div',null,...Array.from({length:4},(_,index)=>React.createElement(TripDayTab,{...props,key:index,index,active:index===selected,day:{...day,id:`day-${index}`,label:`Day ${index+1}`},live:index===selected?{...schedule,finishApprox:status==='unknown'}:undefined,timingLoading:index===selected&&status==='loading'}))));
    assert.equal(countSlots(html),4,`${selected}:${status} count slots`);
    assert.equal(finishSlots(html),4,`${selected}:${status} finish slots`);
    assert.equal((html.match(/aria-selected="true"/g)||[]).length,1);
    assert.equal((html.match(/role="tab"/g)||[]).length,4);
  }
});

test('loading and unknown schedules never present a previous finish as current',()=>{
  const loading=render({timingLoading:true});
  assert.match(loading,/Updating finish…/);
  assert.doesNotMatch(loading,/Finish 19:32/);
  for(const live of [undefined,{...schedule,finishApprox:true}]){
    const unknown=render({live});
    assert.match(unknown,/Finish time unknown/);
    assert.doesNotMatch(unknown,/Finish 19:32|Updating finish/);
    assert.equal(finishSlots(unknown),1);
  }
});

test('known finish includes the overnight day offset',()=>{
  assert.match(render(),/Finish 19:32/);
  assert.match(render({live:{...schedule,finish:1478}}),/Finish 00:38 \+1d/);
});

test('inactive and empty days reserve a finish row without announcing placeholder content',()=>{
  for(const overrides of [{active:false,live:undefined},{active:false,timingLoading:true},{day:{...day,items:[]}}]){
    const html=render(overrides),slot=finishSlot(html);
    assert.equal(countSlots(html),1);
    assert.equal(finishSlots(html),1);
    assert.match(slot,/aria-hidden="true"/);
    assert.doesNotMatch(html,/Updating finish|Finish time unknown|Finish 19:32/);
  }
});

test('singular and large stop counts retain the same summary structure',()=>{
  for(const count of [0,1,5,99]){
    const html=render({day:{...day,items:Array.from({length:count},()=>day.items[0])}});
    assert.match(html,new RegExp(`${count} ${count===1?'stop':'stops'}`));
    assert.equal(countSlots(html),1);
    assert.equal(finishSlots(html),1);
  }
});

test('hours and timing conflicts remain visible without replacing summary slots',()=>{
  for(const overrides of [{hoursConflict:true},{live:{...schedule,late:15}},{hoursConflict:true,timingLoading:true}]){
    const html=render(overrides);
    assert.match(html,/conflict/i);
    assert.match(html,/text-warning/);
    assert.equal(countSlots(html),1);
    assert.equal(finishSlots(html),1);
  }
});

test('day drop targets keep their established index and hover contract',()=>{
  dnd.calls.length=0;
  dnd.setOver(true);
  const html=render({index:3,active:false,live:undefined});
  dnd.setOver(false);
  assert.deepEqual(dnd.calls,[{id:'day:3',data:{type:'day',dayIdx:3}}]);
  assert.match(html,/is-drop-over/);
  assert.match(html,/aria-selected="false"/);
});
