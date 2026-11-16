import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const built=await build({stdin:{contents:`import {dashboardJson} from './apps/api/src/health-dashboard-fetch.ts';export default {async fetch(request,env){try{return Response.json(await dashboardJson('https://monitor.internal'+new URL(request.url).pathname,{},env.HEALTH_MONITOR.fetch.bind(env.HEALTH_MONITOR)));}catch(error){return Response.json({error:error.message},{status:502});}}};`,resolveDir:process.cwd(),sourcefile:'dashboard-runtime-check.ts'},bundle:true,write:false,format:'esm',platform:'node',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
const runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'dashboard',modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-10-24',compatibilityFlags:['nodejs_compat'],serviceBindings:{HEALTH_MONITOR:'monitor'}},{name:'monitor',modules:true,script:`export default {fetch(request){return new URL(request.url).pathname==='/redirect'?Response.redirect('https://must-not-follow.example/',302):Response.json({status:'operational'});}}`,compatibilityDate:'2026-10-24'}]}));
try{
 const healthy=await runtime.dispatchFetch('https://dashboard.test/status');assert.equal(healthy.status,200);assert.deepEqual(await healthy.json(),{status:200,value:{status:'operational'}});
 const redirect=await runtime.dispatchFetch('https://dashboard.test/redirect');assert.equal(redirect.status,502);assert.deepEqual(await redirect.json(),{error:'REDIRECT_REJECTED'});
 console.log('Dashboard Workers runtime: bound monitor JSON and explicit redirect rejection passed.');
}finally{await runtime.dispose();}
