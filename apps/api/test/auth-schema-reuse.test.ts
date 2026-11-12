import {beforeEach,expect,test,vi} from 'vitest';
import type {Env} from '../src/types';
const f=vi.hoisted(()=>({checks:0,schema:()=>Promise.resolve() as Promise<void>,validate:[] as unknown[]}));
vi.mock('better-auth',()=>({betterAuth:(options:{advanced:{database:{validateSchema:unknown}}})=>{
 const validate=options.advanced.database.validateSchema;f.validate.push(validate);
 return {options,$context:Promise.resolve({checkSchema:validate===false?undefined:()=>{f.checks++;return f.schema();}})};
}}));
const {createAuth}=await import('../src/auth');
const {authSchemaGate}=await import('../src/auth-schema');
const pool={} as never;
let release=0;
const env=()=>({APP_URL:'https://example.test',CF_VERSION_METADATA:{id:'reuse-'+(++release)},HYPERDRIVE_AUTH:{connectionString:'synthetic'}} as Env);
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
beforeEach(()=>{f.checks=0;f.schema=()=>Promise.resolve();f.validate=[];});

test('ordinary instances reuse a successful verdict for the same deployment',async()=>{
 const e=env();
 createAuth(e,pool);await settle();
 createAuth(e,pool);createAuth(e,pool,undefined,true);await settle();
 expect(f.validate).toEqual([true,false,false]);expect(f.checks).toBe(1);
 createAuth(env(),pool);await settle();
 expect(f.validate.at(-1)).toBe(true);
});

test('a failed check is not reused, so every request validates again',async()=>{
 const e=env();f.schema=()=>Promise.reject(Error('mismatch'));
 createAuth(e,pool);await settle();createAuth(e,pool);await settle();
 expect(f.validate).toEqual([true,true]);expect(authSchemaGate.validated(authSchemaGate.key(e))).toBe(false);
 authSchemaGate.failed(authSchemaGate.key(e));f.schema=()=>Promise.resolve();
 createAuth(e,pool);await settle();
 expect(f.validate.at(-1)).toBe(true);expect(()=>authSchemaGate.needsValidation(authSchemaGate.key(e))).toThrow();
});

test('unversioned runtimes and explicit callers keep their own choice',async()=>{
 const local={...env(),CF_VERSION_METADATA:undefined} as Env;
 createAuth(local,pool);await settle();createAuth(local,pool);await settle();
 const e=env();createAuth(e,pool,undefined,false,true);await settle();createAuth(e,pool,undefined,false,false);
 expect(f.validate).toEqual([true,true,true,false]);
 expect(authSchemaGate.validated(authSchemaGate.key(e))).toBe(false);
});
