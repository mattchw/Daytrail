import {useSyncExternalStore} from 'react';
const read=()=>typeof navigator==='undefined'||navigator.onLine!==false;
const subscribe=(notify:()=>void)=>{window.addEventListener('online',notify);window.addEventListener('offline',notify);return()=>{window.removeEventListener('online',notify);window.removeEventListener('offline',notify);};};
/** Connectivity is a browser hint; individual sync failures remain visible. */
export function useConnectivity(){return useSyncExternalStore(subscribe,read,()=>true);}
