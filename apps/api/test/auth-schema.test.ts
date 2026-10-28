import {expect,test} from 'vitest';
import {AuthSchemaGate} from '../src/auth-schema';
import type {Env} from '../src/types';
const env={APP_URL:'https://example.test',CF_VERSION_METADATA:{id:'release-a'},HYPERDRIVE_AUTH:{connectionString:'synthetic-a'}} as Env;
test('completed schema verdict reused only for the same deployment, origin and binding',()=>{
 const gate=new AuthSchemaGate(),key=gate.key(env);expect(gate.needsValidation(key)).toBe(true);gate.succeeded(key);expect(gate.needsValidation(key)).toBe(false);
 for(const changed of [{...env,CF_VERSION_METADATA:{id:'b'}},{...env,APP_URL:'https://other.test'},{...env,HYPERDRIVE_AUTH:{connectionString:'b'}}])expect(gate.needsValidation(gate.key(changed as Env))).toBe(true);
});
test('failure is sticky and wins over concurrent success until a new deployment',()=>{
 const gate=new AuthSchemaGate(),key=gate.key(env);gate.failed(key);expect(()=>gate.succeeded(key)).toThrow();expect(()=>gate.needsValidation(key)).toThrow();expect(gate.needsValidation(gate.key({...env,CF_VERSION_METADATA:{id:'next'}} as Env))).toBe(true);
});
test('unversioned runtime never caches and pending work has no shared verdict',()=>{
 const gate=new AuthSchemaGate();expect(gate.key({...env,CF_VERSION_METADATA:undefined})).toBeUndefined();gate.succeeded(undefined);expect(gate.needsValidation(undefined)).toBe(true);const key=gate.key(env);expect(gate.needsValidation(key)).toBe(true);expect(gate.needsValidation(key)).toBe(true);
});
