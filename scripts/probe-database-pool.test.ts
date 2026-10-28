import {describe,it,expect} from 'vitest';
import {pooledTarget} from './probe-database-pool';
describe('pool probe target isolation',()=>{
 const source='postgres://runtime.stage:synthetic@sample.pg.psdb.cloud:5432/postgres';
 it('changes only the port of the verified branch-qualified connection',()=>{
  const target=new URL(pooledTarget(source,'stage')),original=new URL(source);
  expect(target.port).toBe('6432');target.port='5432';expect(target.href).toBe(original.href);
 });
 it('refuses wrong branches, hosts, missing credentials and already changed routing',()=>{
  for(const value of [undefined,'invalid',source.replace('.stage:', '.production:'),source.replace('.pg.psdb.cloud','.example.test'),
   source.replace('5432','6432'),source.replace(':synthetic',''),source.replace('postgres:','https:')])
   expect(()=>pooledTarget(value,'stage')).toThrow(/POOL_PROBE_/);
 });
});
