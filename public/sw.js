/* Daytrail app assets only. No account, provider, API or OAuth responses. */
const PREFIX='daytrail-shell-v1-',META='daytrail-shell-meta-v1',POINTER='/__daytrail_shell_pointer__',SIZE='/__daytrail_shell_bytes__',INVENTORY='/__daytrail_shell_inventory__';
let preparing=null;
const asset=url=>url.origin===self.location.origin&&!url.search&&/^\/assets\/[A-Za-z0-9_./-]+\.(?:js|css|woff2?|svg|png|ico)$/.test(url.pathname);
const shellNavigation=url=>url.origin===self.location.origin&&url.pathname==='/'&&!url.search;
const htmlEntries=html=>[...new Set([...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match=>new URL(match[1],self.location.origin)).filter(url=>asset(url)&&/\.(?:js|css)$/.test(url.pathname)).map(url=>url.pathname))].sort();
async function pointer(){const response=await(await caches.open(META)).match(POINTER);return response?await response.text():null;}
async function status(){const name=await pointer();if(!name||!(await caches.keys()).includes(name))return{ready:false};const cache=await caches.open(name);const size=await(await caches.open(META)).match(SIZE),inventory=await cache.match(INVENTORY);if(!inventory)return{ready:false};const urls=await inventory.json();if(!Array.isArray(urls))return{ready:false};for(const url of urls)if(!await cache.match(url))return{ready:false};const page=await cache.match('/');if(!page)return{ready:false};return{ready:true,bytes:size?Number(await size.text())||0:0,entries:htmlEntries(await page.text())};}
function appIssue(phase,code){const error=new Error();error.offlinePhase=phase;error.offlineCode=code;return error;}
function safeFailure(error){const phase=error?.offlinePhase||'checking app storage',code=error?.offlineCode||(['QuotaExceededError','TypeError','InvalidStateError','SecurityError'].includes(error?.name)?error.name:'Error');return `Could not save the offline app while ${phase} (${code}). ${code==='QuotaExceededError'?'Free device storage and retry.':'Keep Daytrail online, refresh, and retry.'}`;}
async function prepare(){
  if(preparing)return preparing;
  preparing=(async()=>{
    let phase='loading the app page',name=null;
    try{
    const response=await fetch(new URL('/index.html',self.location.origin).href,{cache:'no-store',credentials:'same-origin'});if(!response.ok)throw appIssue(phase,`HTTP ${response.status}`);if(!response.headers.get('content-type')?.includes('text/html'))throw appIssue(phase,'Unexpected content type');
    phase='reading the app page';const html=await response.clone().text();phase='checking app entry URLs';const entry=[...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(m=>new URL(m[1],self.location.origin)).filter(asset);
    if(!entry.some(url=>url.pathname.endsWith('.js')))throw appIssue(phase,'Production assets unavailable');
    phase='preparing app storage';const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(html));name=PREFIX+Array.from(new Uint8Array(hash)).slice(0,12).map(n=>n.toString(16).padStart(2,'0')).join('');
    const cache=await caches.open(name),seen=new Set(),queue=[...entry,new URL('/assets/figtree-latin.woff2',self.location.origin),new URL('/assets/figtree-latin-ext.woff2',self.location.origin),new URL('/assets/daytrail.svg',self.location.origin)];let bytes=new TextEncoder().encode(html).byteLength;
      while(queue.length){const url=queue.shift();if(seen.has(url.href)||!asset(url))continue;if(seen.size>250)throw appIssue(phase,'Asset limit reached');seen.add(url.href);
        phase='downloading app assets';const result=await fetch(url.href,{cache:'no-store',credentials:'same-origin'});if(!result.ok)throw appIssue(phase,`HTTP ${result.status}`);if(result.type==='opaque')throw appIssue(phase,'Unreadable asset response');
        const content=await result.clone().arrayBuffer();bytes+=content.byteLength;phase='saving app assets';await cache.put(url.href,result);
        if(/\.(?:js|css)$/.test(url.pathname)){const text=new TextDecoder().decode(content);for(const match of text.matchAll(/["'(]((?:\.\.?\/|\/assets\/|assets\/)[^"'()\s]+\.(?:js|css|woff2?|svg|png|ico))["')]/g)){const child=new URL(match[1].startsWith('assets/')?'/'+match[1]:match[1],url);if(asset(child))queue.push(child);}}
      }
      phase='downloading the app manifest';const manifest=await fetch(new URL('/manifest.webmanifest',self.location.origin).href,{cache:'no-store'});if(!manifest.ok)throw appIssue(phase,`HTTP ${manifest.status}`);phase='saving the app manifest';await cache.put('/',response);await cache.put('/manifest.webmanifest',manifest);await cache.put(INVENTORY,new Response(JSON.stringify([...seen,'/','/manifest.webmanifest'])));
      phase='finishing offline preparation';await(await caches.open(META)).put(POINTER,new Response(name));await(await caches.open(META)).put(SIZE,new Response(String(bytes)));
      // Keep prior bundles for tabs still running an older build; never force reload.
      const generations=(await caches.keys()).filter(key=>key.startsWith(PREFIX)&&key!==name);for(const old of generations.slice(0,-2))await caches.delete(old);
      return{ready:true,bytes,entries:htmlEntries(html)};
    }catch(error){try{if(name&&await pointer()!==name)await caches.delete(name);}catch{/* Keep the original diagnostic if cleanup also fails. */}if(!error.offlinePhase)error.offlinePhase=phase;throw error;}
  })().finally(()=>{preparing=null;});return preparing;
}
self.addEventListener('install',event=>{event.waitUntil(prepare());});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});
self.addEventListener('message',event=>{if(!['STATUS','PREPARE_SHELL'].includes(event.data?.type))return;event.waitUntil((event.data.type==='STATUS'?status():prepare()).then(result=>event.ports[0]?.postMessage(result),error=>event.ports[0]?.postMessage({ready:false,error:safeFailure(error)})));});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);if(request.method!=='GET')return;
  if(request.mode==='navigate'&&shellNavigation(url)){event.respondWith(fetch(new URL('/index.html',self.location.origin).href,{cache:'no-store',credentials:'same-origin'}).catch(async()=>{const name=await pointer(),cached=name?await(await caches.open(name)).match('/'):null;return cached||new Response('Open Daytrail online once and save your trip before travelling offline.',{status:503,headers:{'Content-Type':'text/plain'}});}));return;}
  if(asset(url)||url.origin===self.location.origin&&url.pathname==='/manifest.webmanifest'&&!url.search){event.respondWith((async()=>{const name=await pointer(),cached=name?await(await caches.open(name)).match(request,{ignoreVary:true}):null;if(cached)return cached;for(const old of(await caches.keys()).filter(key=>key.startsWith(PREFIX)&&key!==name)){const asset=await(await caches.open(old)).match(request,{ignoreVary:true});if(asset)return asset;}return fetch(request);})());}
});
