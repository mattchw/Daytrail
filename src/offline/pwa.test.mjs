import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),originalSecure=globalThis.isSecureContext,originalDocument=globalThis.document,originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
let entries=['/assets/app-current.js','/assets/app-current.css'],cached={ready:true,bytes:12345,entries:[...entries]},prepared={...cached},online=true;const calls=[];
const worker={postMessage({type},ports){calls.push(type);ports[0].postMessage(type==='STATUS'?cached:prepared);}};
const registration={active:worker,addEventListener(){}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{get onLine(){return online;},serviceWorker:{register:async()=>registration,ready:Promise.resolve(registration),controller:worker}}});globalThis.isSecureContext=true;
globalThis.document={baseURI:'http://localhost:5182/',querySelectorAll(){return entries.map(path=>({getAttribute:name=>name===(path.endsWith('.js')?'src':'href')?path:null}));}};
const source=ts.transpileModule(readFileSync(new URL('./pwa.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {matchingShell,currentAppEntries,registerOfflineShell,prepareOfflineShell,shellStore}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
let passed=0;const check=async(name,run)=>{calls.length=0;await run();passed++;console.log(`✓ ${name}`);};
try{
 await registerOfflineShell(true);
 await check('complete current build is reused without a network preparation',async()=>{assert.equal(await prepareOfflineShell(),12345);assert.deepEqual(calls,['STATUS']);assert.equal(shellStore.getSnapshot().ready,true);});
 await check('matching complete shell can be reused while offline',async()=>{online=false;assert.equal(await prepareOfflineShell(),12345);assert.deepEqual(calls,['STATUS']);online=true;});
 await check('an incomplete inventory requires preparation even if entry names match',async()=>{cached={...cached,ready:false};prepared={ready:true,bytes:15000,entries:[...entries]};assert.equal(await prepareOfflineShell(),15000);assert.deepEqual(calls,['STATUS','PREPARE_SHELL']);});
 await check('a different cached build cannot be treated as the current offline app',async()=>{cached={ready:true,bytes:14000,entries:['/assets/older.js','/assets/older.css']};prepared={ready:false,error:'Download unavailable'};await assert.rejects(prepareOfflineShell(),/Download unavailable/);assert.equal(shellStore.getSnapshot().ready,false);assert.deepEqual(calls,['STATUS','PREPARE_SHELL']);});
 await check('offline mismatch fails without attempting a network request',async()=>{online=false;await assert.rejects(prepareOfflineShell(),/not fully saved/);assert.deepEqual(calls,['STATUS']);online=true;});
 await check('deployment changes during preparation request a safe refresh instead of falsely reporting ready',async()=>{prepared={ready:true,bytes:16000,entries:['/assets/newer.js','/assets/newer.css']};await assert.rejects(prepareOfflineShell(),/newer app version/);assert.equal(shellStore.getSnapshot().ready,false);assert.equal(shellStore.getSnapshot().updateAvailable,true);});
 await check('entry comparison is order independent but exact and requires a script',()=>{assert.equal(matchingShell([...entries].reverse(),entries),true);assert.equal(matchingShell([...entries,'/assets/extra.js'],entries),false);assert.equal(matchingShell(['/assets/style.css'],['/assets/style.css']),false);});
 await check('provider scripts and query URLs cannot influence the build match',()=>{const doc={baseURI:'http://localhost:5182/',querySelectorAll:()=>['/assets/app-current.js','/assets/app-current.css','https://maps.googleapis.com/maps/api/js','/assets/debug.js?key=private'].map(path=>({getAttribute:name=>name==='src'?path:null}))};assert.deepEqual(currentAppEntries(doc),[...entries].sort());});
 let devModule=0;
 const freshDev=()=>import('data:text/javascript;base64,'+Buffer.from(source+`\n// dev cleanup case ${++devModule}`).toString('base64'));
 const setNavigator=value=>Object.defineProperty(globalThis,'navigator',{configurable:true,value});
 Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost:5182/planner?trip=one'}});
 await check('development unregisters only its own root worker and preserves the unsupported status',async()=>{
   let unregistered=0;const lookedUp=[];
   setNavigator({serviceWorker:{getRegistration:async scope=>{lookedUp.push(scope);return {scope:'http://localhost:5182/',active:{scriptURL:'http://localhost:5182/sw.js'},waiting:{scriptURL:'http://localhost:5182/sw.js'},unregister:async()=>{unregistered++;return true;}};}}});
   const dev=await freshDev();await dev.registerOfflineShell(false);
   assert.deepEqual(lookedUp,['http://localhost:5182/']);assert.equal(unregistered,1);
   assert.deepEqual(dev.shellStore.getSnapshot(),{supported:false,ready:false,updateAvailable:false,error:'Offline launch is available in the production build.'});
 });
 await check('development leaves other scripts, origins, scopes and mixed worker registrations untouched',async()=>{
   let unregistered=0;
   for(const candidate of [
     {scope:'http://localhost:5182/',active:{scriptURL:'http://localhost:5182/other-sw.js'}},
     {scope:'http://localhost:5182/',active:{scriptURL:'https://other.example/sw.js'}},
     {scope:'http://localhost:5182/other/',active:{scriptURL:'http://localhost:5182/sw.js'}},
     {scope:'http://localhost:5182/',active:{scriptURL:'http://localhost:5182/sw.js?other-app=1'}},
     {scope:'http://localhost:5182/',active:{scriptURL:'http://localhost:5182/sw.js'},waiting:{scriptURL:'http://localhost:5182/other-sw.js'}},
     {scope:'http://localhost:5182/'},
   ]){
     setNavigator({serviceWorker:{getRegistration:async()=>({...candidate,unregister:async()=>{unregistered++;return true;}})}});
     const dev=await freshDev();await dev.registerOfflineShell(false);
   }
   assert.equal(unregistered,0);
 });
 await check('development resolves safely without supported APIs or when cleanup fails',async()=>{
   delete globalThis.navigator;let dev=await freshDev();await dev.registerOfflineShell(false);
   setNavigator({});dev=await freshDev();await dev.registerOfflineShell(false);
   let insecureLookups=0;setNavigator({serviceWorker:{getRegistration:async()=>{insecureLookups++;return undefined;}}});globalThis.isSecureContext=false;dev=await freshDev();await dev.registerOfflineShell(false);assert.equal(insecureLookups,0);globalThis.isSecureContext=true;
   for(const failure of ['lookup','unregister']){
     setNavigator({serviceWorker:{getRegistration:async()=>{if(failure==='lookup')throw Error('lookup unavailable');return {scope:'http://localhost:5182/',active:{scriptURL:'http://localhost:5182/sw.js'},unregister:async()=>{throw Error('unregister unavailable');}};}}});
     dev=await freshDev();await dev.registerOfflineShell(false);assert.equal(dev.shellStore.getSnapshot().supported,false);
   }
 });
 console.log(`\n${passed} offline app-shell reuse checks passed.`);
}finally{if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else delete globalThis.location;if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator;if(originalDocument)globalThis.document=originalDocument;else delete globalThis.document;if(originalSecure===undefined)delete globalThis.isSecureContext;else globalThis.isSecureContext=originalSecure;}
