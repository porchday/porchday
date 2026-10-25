import {expect,test} from 'vitest';
import {app} from '../src/index';
import type {Env} from '../src/types';

const env={ENVIRONMENT:'development',APP_URL:'https://porchday.test'} as Env;
test('Apple association is absent until real signing identifiers are configured and limits links to posts',async()=>{
 const url='https://porchday.test/.well-known/apple-app-site-association';
 expect((await app.request(url,{},env)).status).toBe(404);
 expect((await app.request(url,{}, {...env,APNS_TEAM_ID:'replace-me',APNS_BUNDLE_ID:'com.example.app'})).status).toBe(404);
 const response=await app.request(url,{}, {...env,APNS_TEAM_ID:'A123456789',APNS_BUNDLE_ID:'com.example.porchday'});
 expect(response.status).toBe(200);
 expect(response.headers.get('content-type')).toContain('application/json');
 expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
 const body=await response.json() as any;
 expect(body.applinks.details).toHaveLength(1);
 expect(body.applinks.details[0].appIDs).toEqual(['A123456789.com.example.porchday']);
 expect(body.applinks.details[0].components.map((c:Record<string,string>)=>c['/'])).toEqual(['/app/post/*']);
});

test('unconfigured deployment safeguards stop API traffic while health remains available',async()=>{
 const production={...env,ENVIRONMENT:'production'} as Env;
 const unavailable=await app.request('https://porchday.test/api/auth/get-session',{},production);
 expect(unavailable.status).toBe(503);
 expect(unavailable.headers.get('cache-control')).toBe('private, no-store');
 expect(await unavailable.json()).toMatchObject({error:{code:'PRIVACY_CHECKPOINT_REQUIRED'}});
 expect((await app.request('https://porchday.test/health',{},production)).status).toBe(200);
});
