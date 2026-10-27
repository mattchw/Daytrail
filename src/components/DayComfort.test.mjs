import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

const compiled=new Map();
function moduleURL(path){
  if(compiled.has(path))return compiled.get(path);
  let source=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  source=source.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm,'').replaceAll('import.meta.env','({})');
  source=source.replace(/^((?:import|export)\s[^\n]*?\sfrom\s)(['"])([^'"]+)\2/gm,(_,prefix,quote,specifier)=>{
    if(!specifier.startsWith('.'))return `${prefix}${JSON.stringify(import.meta.resolve(specifier))}`;
    const base=resolve(dirname(path),specifier),dependency=[base,`${base}.ts`,`${base}.tsx`].find(value=>existsSync(value));
    return `${prefix}${JSON.stringify(moduleURL(dependency))}`;
  });
  const result=`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;compiled.set(path,result);return result;
}
const {default:DayComfort}=await import(moduleURL(resolve(dirname(fileURLToPath(import.meta.url)),'DayComfort.tsx')));
const noop=()=>{};
const assessment={pace:'relaxed',limitMeters:8000,signature:'test',walking:{knownMeters:6700,routeMeters:6000,onSiteMeters:700,freeTimeMeters:0,unknownLegIds:[],unknownVisitIds:[],estimatedVisitIds:[],exceedsLimit:false},meals:[],gaps:[],timingComplete:true};
const weather={status:'too-early',date:'2026-11-20',timezone:'UTC',forecast:undefined,forecasts:{},locations:[],visits:[],risks:[],rainVisits:[],summary:null,signature:'weather',partial:false,retry:noop};
const lunch={...assessment,gaps:[{id:'lunch',window:'lunch',date:'2026-11-20',start:600,end:900,windowStart:690,windowEnd:810}]};
const props={assessment,weather,onPaceChange:noop,onPreview:noop,onDismiss:noop,onIndoorIdeas:noop};
const render=(overrides={})=>renderToStaticMarkup(React.createElement(DayComfort,{...props,...overrides}));
const visibleHeader=html=>html.slice(0,html.indexOf('<dialog'));
const disclosureCount=html=>(visibleHeader(html).match(/aria-haspopup="dialog"/g)||[]).length;

for(const compact of [false,true])test(`${compact?'mobile':'desktop'} meal reminders never insert expanded content into the itinerary`,()=>{
  const calm=render({compact}),warning=render({compact,assessment:lunch});
  for(const html of [calm,warning]){
    assert.equal(disclosureCount(html),2);
    assert.doesNotMatch(visibleHeader(html),/<article|<fieldset|<details|role="alert"/);
    assert.doesNotMatch(html,/<dialog[^>]* open[ >]/);
  }
  assert.match(visibleHeader(calm),/No reminders/);
  assert.match(visibleHeader(warning),/1 reminder/);
  assert.match(warning.slice(warning.indexOf('<dialog')),/There is a gap of at least four hours/);
});

for(const compact of [false,true])test(`${compact?'mobile':'desktop'} keeps both summary rows while meal timing is recalculated`,()=>{
  const calculating=render({compact,assessment:{...assessment,timingComplete:false}});
  const settled=render({compact,assessment:lunch});
  for(const html of [calculating,settled]){
    assert.equal(disclosureCount(html),2);
    assert.equal((visibleHeader(html).match(/class="comfort-summary-notice /g)||[]).length,1);
    assert.doesNotMatch(visibleHeader(html),/<article|<fieldset|<details|role="alert"/);
  }
  assert.match(visibleHeader(calculating),/Updating reminders…/);
  assert.doesNotMatch(visibleHeader(calculating),/No reminders|A little room for lunch/);
  assert.match(visibleHeader(settled),/1 reminder/);
});

test('dismissing a reminder preserves the details entry point',()=>{
  const html=render({assessment:lunch,isDismissed:()=>true});
  assert.equal(disclosureCount(html),2);
  assert.match(visibleHeader(html),/No reminders/);
  assert.doesNotMatch(html,/<article/);
  assert.match(html,/Comfortable walking distance each day/);
});

test('all reminder actions remain available inside the shared details dialog',()=>{
  const rainy={...weather,rainVisits:[{activityId:'garden',name:'The garden',status:'rain',probability:80}]};
  const busy={...lunch,walking:{...lunch.walking,knownMeters:10000,exceedsLimit:true}};
  const html=render({assessment:busy,weather:rainy});
  assert.equal(disclosureCount(html),2);
  assert.match(visibleHeader(html),/3 reminders/);
  const dialog=html.slice(html.indexOf('<dialog'));
  for(const action of ['Find a meal stop','I’ve got it covered','Review a driving option','Keep walking','Show indoor ideas','Review another day','Keep plan'])assert.ok(dialog.includes(action),action);
});

test('read-only plans retain weather information without offering itinerary mutations',()=>{
  const html=render({assessment:lunch,readOnly:true});
  assert.equal(disclosureCount(html),2);
  assert.match(html,/Comfortable walking distance each day/);
  assert.match(html,/<fieldset[^>]*disabled/);
  assert.doesNotMatch(html,/Find a meal stop/);
});
