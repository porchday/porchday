import { afterEach, expect, test, vi } from 'vitest';
import { withMember } from '../src/db';
import type { FeedTiming } from '../src/feed-timing';
const fixture=vi.hoisted(()=>({options:{} as {onparameter?:(...args:unknown[])=>void;debug?:unknown},before:true,fail:false,closed:0}));
vi.mock('postgres',()=>({default:(_url:string,options:typeof fixture.options)=>{
 fixture.options=options;
 const db=async()=>{options.onparameter?.('private-setting','private-value');return [];};
 db.begin=async(work:(sql:typeof db)=>Promise<unknown>)=>{
  if(fixture.before){options.onparameter?.('private-startup','private-server');options.onparameter?.('private-second','private-value');}
  if(fixture.fail)throw original;
  return work(db);
 };
 db.end=async()=>{fixture.closed++;};return db;
}}));
const original=Error('synthetic connection failure');
const env={HYPERDRIVE_SOCIAL:{connectionString:'synthetic'}} as Parameters<typeof withMember>[0];
const member='11111111-1111-4111-8111-111111111111';
afterEach(()=>{fixture.before=true;fixture.fail=false;fixture.closed=0;});
test('first parameter is a single numeric nested milestone and retains transaction lifecycle',async()=>{
 const spans:[string,number][]=[];
 expect(await withMember(env,member,async()=>42,{record:(name,ms)=>spans.push([name,ms])})).toBe(42);
 expect(spans.map(([name])=>name)).toEqual(['social_first_parameter','social_connect_begin','social_actor','social_query','social_commit','social_close']);
 expect(spans[0][1]).toBeLessThanOrEqual(spans[1][1]);
 expect(spans.every(([,ms])=>Number.isFinite(ms)&&ms>=0)).toBe(true);
 expect(JSON.stringify(spans)).not.toMatch(/private|synthetic|11111111/);
 expect(fixture.options.debug).toBeUndefined();expect(fixture.closed).toBe(1);
});
test('no startup callback is not reported as zero; later transaction parameters are ignored',async()=>{
 fixture.before=false;const phases:string[]=[];
 await withMember(env,member,async()=>42,{record:name=>phases.push(name)});
 expect(phases).not.toContain('social_first_parameter');expect(phases).toContain('social_connect_begin');
});
test('untraced request does not install a callback or enable debug',async()=>{
 await withMember(env,member,async()=>42);
 expect(fixture.options.onparameter).toBeUndefined();expect(fixture.options.debug).toBeUndefined();
});
test('diagnostic failure cannot change result or the original connection failure',async()=>{
 const timing:FeedTiming={record:()=>{throw Error('telemetry unavailable');}};
 expect(await withMember(env,member,async()=>42,timing)).toBe(42);
 fixture.fail=true;
 await expect(withMember(env,member,async()=>42,timing)).rejects.toBe(original);
 expect(fixture.closed).toBe(2);
});
