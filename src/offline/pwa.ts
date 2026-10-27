export interface ShellReply {ready:boolean;bytes?:number;error?:string;entries?:string[]}
/** Match the document's actual entry files, not a provider script or an older cached build. */
export function currentAppEntries(doc:Pick<Document,'querySelectorAll'|'baseURI'>=document):string[]{
  const base=new URL(doc.baseURI);return [...new Set(Array.from(doc.querySelectorAll('script[src],link[rel="stylesheet"][href]')).map(node=>new URL(node.getAttribute('src')||node.getAttribute('href')||'',base)).filter(url=>url.origin===base.origin&&!url.search&&/^\/assets\/[A-Za-z0-9_./-]+\.(?:js|css)$/.test(url.pathname)).map(url=>url.pathname))].sort();
}
export function matchingShell(entries:string[]|undefined,current:string[]):boolean {
  if(!Array.isArray(entries)||!current.some(path=>path.endsWith('.js')))return false;
  const cached=[...new Set(entries)].sort(),wanted=[...new Set(current)].sort();return cached.length===wanted.length&&cached.every((path,index)=>path===wanted[index]);
}
export interface ShellStatus {supported:boolean;ready:boolean;updateAvailable:boolean;error:string|null}
let snapshot:ShellStatus={supported:typeof navigator!=='undefined'&&'serviceWorker' in navigator&&typeof isSecureContext!=='undefined'&&isSecureContext,ready:false,updateAvailable:false,error:null};
const listeners=new Set<()=>void>();let registration:ServiceWorkerRegistration|null=null,starting:Promise<void>|null=null;
const emit=(patch:Partial<ShellStatus>)=>{snapshot={...snapshot,...patch};for(const listener of listeners)listener();};
export const shellStore={getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
function send(worker:ServiceWorker,type:string):Promise<ShellReply>{return new Promise((resolve,reject)=>{
  const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(new Error('The offline app could not finish saving. Reconnect and try again.'));},45000);
  channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};worker.postMessage({type},[channel.port2]);
});}
export function registerOfflineShell(production:boolean):Promise<void>{
  if(!production){
    emit({supported:false,ready:false,updateAvailable:false,error:'Offline launch is available in the production build.'});
    return (async()=>{try{
      if(typeof navigator==='undefined'||!('serviceWorker' in navigator)||typeof isSecureContext==='undefined'||!isSecureContext||typeof location==='undefined')return;
      const workers=navigator.serviceWorker;if(typeof workers.getRegistration!=='function')return;
      const scope=new URL('/',location.href).href,script=new URL('/sw.js',location.href).href;
      const existing=await workers.getRegistration(scope);
      if(!existing||existing.scope!==scope)return;
      const scripts=[existing.active,existing.waiting,existing.installing].filter((worker):worker is ServiceWorker=>!!worker);
      // Remove only Daytrail's own root registration; saved offline data stays intact.
      if(scripts.length&&scripts.every(worker=>worker.scriptURL===script))await existing.unregister();
    }catch{/* Development still opens when service-worker cleanup is unavailable. */}})();
  }
  if(!snapshot.supported)return Promise.resolve();
  return starting??=(async()=>{try{
    registration=await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const ready=await Promise.race([navigator.serviceWorker.ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Offline app installation did not finish.')),20000);})]).finally(()=>clearTimeout(timer));registration=ready;
    registration.addEventListener('updatefound',()=>{const installing=registration?.installing;installing?.addEventListener('statechange',()=>{if(installing.state==='installed'&&navigator.serviceWorker.controller)emit({updateAvailable:true});});});
    const worker=ready.active;if(worker){const result=await send(worker,'STATUS'),matches=matchingShell(result.entries,currentAppEntries());emit({ready:result.ready&&matches,updateAvailable:result.ready&&!matches,error:result.error||null});}
  }catch{emit({ready:false,error:'This browser could not prepare the offline app. Keep Daytrail open and retry.'});}})();
}
export async function prepareOfflineShell():Promise<number>{
  await starting;
  if(!snapshot.supported)throw new Error(snapshot.error||'Offline launch needs a supported browser and a secure production site.');
  const worker=registration?.active||navigator.serviceWorker.controller;
  if(!worker)throw new Error('The offline app is still starting. Try again shortly.');
  try{
    const entries=currentAppEntries(),existing=await send(worker,'STATUS');
    if(existing.ready&&matchingShell(existing.entries,entries)){emit({ready:true,error:null});return existing.bytes||0;}
    emit({ready:false});
    if(navigator.onLine===false)throw new Error('This version of Daytrail is not fully saved. Reconnect and prepare it before travelling offline.');
    const result=await send(worker,'PREPARE_SHELL');if(!result.ready)throw new Error(result.error||'The offline app could not be saved.');
    if(!matchingShell(result.entries,entries)){emit({ready:false,updateAvailable:true});throw new Error('A newer app version is available. Finish saving your changes, refresh online, then prepare offline access again.');}
    emit({ready:true,error:null});return result.bytes||0;
  }
  catch(error){emit({error:error instanceof Error?error.message:'The offline app could not be saved.'});throw error;}
}
