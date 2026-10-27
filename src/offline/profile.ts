export interface OfflineProfile {id:string;email?:string;name?:string}
export const OFFLINE_PROFILE_KEY='daytrail.offline.profile.v1';
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export function readOfflineProfile(storage:StoragePort=localStorage):OfflineProfile|null {
  try{const value=JSON.parse(storage.getItem(OFFLINE_PROFILE_KEY)||'null');
    if(!value||typeof value.id!=='string'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value.id))return null;
    return{id:value.id,...(typeof value.email==='string'?{email:value.email.slice(0,320)}:{}),...(typeof value.name==='string'?{name:value.name.slice(0,160)}:{})};
  }catch{return null;}
}
export function saveOfflineProfile(value:OfflineProfile,storage:StoragePort=localStorage){
  const profile={id:value.id,...(value.email?{email:value.email.slice(0,320)}:{}),...(value.name?{name:value.name.slice(0,160)}:{})};
  storage.setItem(OFFLINE_PROFILE_KEY,JSON.stringify(profile));
  if(readOfflineProfile(storage)?.id!==value.id)throw new Error('This browser could not save your offline account. Allow site storage and try again.');
}
export function clearOfflineProfile(storage:StoragePort=localStorage){storage.removeItem(OFFLINE_PROFILE_KEY);}
