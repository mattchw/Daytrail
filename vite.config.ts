import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import {readAuthConfiguration} from './src/auth/config';

export default defineConfig(({mode})=>{
  const env=loadEnv(mode,process.cwd(),'VITE_');
  // Vite embeds these values in browser assets. Refuse server credentials before
  // either serving or building, even if a developer accidentally pastes one.
  for(const [name,value] of Object.entries(env)){
    if(!value)continue;
    let serverToken=false;
    if(value.startsWith('eyJ'))try{serverToken=JSON.parse(Buffer.from(value.split('.')[1]||'','base64url').toString()).role==='service_role';}catch{/* Not a JWT. */}
    if(/SECRET|PASSWORD|SERVICE_ROLE|DATABASE_URL/.test(name)||value.startsWith('sb_secret_')||/^postgres(ql)?:\/\//i.test(value)||serverToken){
      throw Error('A server credential was placed in a VITE_ variable. Remove it: VITE_ values are public browser configuration.');
    }
  }
  if(env.VITE_SUPABASE_URL||env.VITE_SUPABASE_PUBLISHABLE_KEY){
    const config=readAuthConfiguration(env);if(config.issue)throw Error(config.issue);
  }
  return {plugins:[react()],build:{outDir:'dist'},server:{host:'localhost',port:5182,strictPort:true},preview:{host:'localhost',port:5182,strictPort:true}};
});
