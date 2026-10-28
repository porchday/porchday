import {beforeEach,expect,test,vi} from 'vitest';
import {readMemberBootstrap} from '../src/member-bootstrap';
import type {Env} from '../src/types';
const f=vi.hoisted(()=>({calls:[] as any[],fail:'',connected:0,ended:0,destroyed:0}));
vi.mock('pg',()=>({Pool:class {
 constructor(options:unknown){f.calls.push(options);}
 async connect(){f.connected++;return {query:async(text:string,values?:unknown[])=>{
  f.calls.push({text,values});if(f.fail&&(text.startsWith(f.fail)||(f.fail==='COMMIT'&&text.endsWith('COMMIT'))))throw Error('original failure');
  return text.startsWith('select')?[{rows:[{id:'a',startup_devices:[]}]},{command:'COMMIT'}]:{rows:[]};
 },release:(destroy:boolean)=>{if(destroy)f.destroyed++;}};}
 async end(){f.ended++;}
}}));
const env={HYPERDRIVE_SOCIAL:{connectionString:'synthetic-social'}} as Env;
const actor='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{f.calls=[];f.fail='';f.connected=0;f.ended=0;f.destroyed=0;});
test('one setup batch precedes UUID-only RLS query/commit batch, with isolated cleanup',async()=>{
 const result=await readMemberBootstrap(env,actor,true);
 expect(result).toEqual({id:'a',startup_devices:[],connection_limit:300});
 const queries=f.calls.filter(x=>x.text);expect(queries).toHaveLength(2);
 expect(queries[0]).toEqual({text:`BEGIN; SET LOCAL app.member_id = '${actor}'`,values:undefined});
 expect(queries[1].text).toContain(`where m.id='${actor}'::uuid; COMMIT`);expect(queries[1].values).toBeUndefined();
 expect(f.destroyed).toBe(1);expect(f.ended).toBe(1);
});
test('ordinary response excludes roster; new requests repeat the transaction',async()=>{
 expect(await readMemberBootstrap(env,actor,false)).not.toHaveProperty('startup_devices');
 await readMemberBootstrap(env,actor,false);expect(f.connected).toBe(2);expect(f.ended).toBe(2);
});
test('malformed identity never reaches a SQL connection or literal',async()=>{
 for(const id of [actor+"'; COMMIT; --",'',actor+'\n',actor.replace('1','g')])await expect(readMemberBootstrap(env,id,true)).rejects.toThrow('Invalid authenticated');
 expect(f.calls).toHaveLength(0);
});
test.each(['BEGIN','select','COMMIT'])('failure in %s rolls back and destroys the connection without retrying or returning data',async phase=>{
 f.fail=phase;await expect(readMemberBootstrap(env,actor,true)).rejects.toThrow('original failure');
 const queries=f.calls.filter(x=>x.text).map(x=>x.text);expect(queries.at(-1)).toBe('ROLLBACK');
 expect(queries.filter(x=>x.startsWith(phase)||(phase==='COMMIT'&&x.endsWith('COMMIT')))).toHaveLength(1);expect(f.destroyed).toBe(1);expect(f.ended).toBe(1);
});
