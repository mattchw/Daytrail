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
const {default:DiscoveryExplorer}=await import(moduleURL(resolve(dirname(fileURLToPath(import.meta.url)),'DiscoveryExplorer.tsx')));
const noop=()=>{};
const result=(id,name)=>({place:{id,name,cat:'attr',x:0,y:0,area:'Kyoto',typical:'1 h',blurb:''},info:{fetchedAt:0,photos:[]}});
const results=[result('museum','City museum'),result('gallery','Riverside gallery')];
const props={destination:'Kyoto',dayLabel:'Day 2',tripDate:'2026-10-27',query:'museums',setQuery:noop,category:'museums',onCategory:noop,results,loading:false,error:'',searched:true,scope:'destination',selectedResult:null,onSearch:noop,onSelect:noop,onBack:noop,onBackToDestination:noop,onSave:noop,onAdd:noop,statusOf:()=>'',scrollTop:240,onScrollTop:noop};
const render=(overrides={})=>renderToStaticMarkup(React.createElement(DiscoveryExplorer,{...props,...overrides}));
const existingCards=html=>{assert.match(html,/aria-label="View City museum"/);assert.match(html,/aria-label="View Riverside gallery"/);};

test('appending keeps existing place cards and add-here actions available',()=>{
  const html=render({hasMore:true,loadingMore:true,onLoadMore:noop,addHere:true,onChooseAdd:noop});
  existingCards(html);
  assert.match(html,/Loading more places…/);
  assert.match(html,/<button[^>]*class="button dx-more-button"[^>]*disabled/);
  assert.match(html,/aria-label="Add City museum here"/);
  assert.match(html,/aria-label="Choose day and position for City museum"/);
  assert.doesNotMatch(html,/dx-skeleton/);
});

test('an append failure retains results and offers its own retry',()=>{
  const html=render({hasMore:true,moreError:'More places could not load.',onLoadMore:noop});
  existingCards(html);
  assert.match(html,/role="alert">More places could not load/);
  assert.match(html,/Try loading more places again/);
  assert.doesNotMatch(html,/A small detour|dx-skeleton/);
});

test('the end state appears only when the provider has no further results',()=>{
  assert.doesNotMatch(render(),/reached the end/);
  assert.doesNotMatch(render({hasMore:true,onLoadMore:noop}),/reached the end/);
  const end=render({hasMore:false,onLoadMore:noop});
  existingCards(end);
  assert.match(end,/reached the end of these results/);
  assert.match(end,/Try another category or search a different area on the map/);
  assert.doesNotMatch(end,/Show more places/);
});

test('filtered empty pages can still offer explicit continuation',()=>{
  const html=render({results:[],hasMore:true,onLoadMore:noop});
  assert.match(html,/No places found here/);
  assert.match(html,/Show more places/);
  assert.doesNotMatch(html,/reached the end/);
});

test('selected place details remain selected while additional results load',()=>{
  const html=render({selectedResult:results[0],hasMore:true,loadingMore:true,onLoadMore:noop});
  assert.match(html,/dx-explorer-detail/);
  assert.match(html,/All results/);
  assert.match(html,/City museum/);
  assert.doesNotMatch(html,/Show more places|Loading more places|View Riverside gallery/);
});
