import {beforeEach,describe,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({queries:[] as string[],mode:'',rows:[{name:'000_initial.sql'}],fail:false,end:vi.fn(async()=>{})}));
vi.mock('postgres',()=>({default:vi.fn(()=>({end:fixture.end,begin:async(mode:string,run:(tx:unknown)=>unknown)=>{
 fixture.mode=mode;
 return run(async(strings:TemplateStringsArray)=>{
  const query=strings.join('');fixture.queries.push(query);
  if(fixture.fail)throw Error('private database connection credential');
  if(query.includes('schema_migrations'))return fixture.rows;
  if(query.startsWith('select'))return [{synthetic:'metadata'}];
  return [];
 });
}}))}));
import {assertReleaseSchema,captureReleaseSchema,validateReleaseDatabaseTarget,validateSchemaFingerprint} from './release-schema.ts';
const options={connection:'postgres://role.branch@host.pg.psdb.cloud:5432/db',branchId:'branch',expectedMigrations:['000_initial.sql'],signal:new AbortController().signal};
beforeEach(()=>{fixture.queries=[];fixture.mode='';fixture.rows=[{name:'000_initial.sql'}];fixture.fail=false;fixture.end.mockClear();});
describe('release schema drift gate',()=>{
 it('uses one bounded read-only repeatable snapshot and returns only hashes and migration names',async()=>{
  const result=await captureReleaseSchema(options);validateSchemaFingerprint(result);
  expect(fixture.mode).toBe('isolation level repeatable read read only');
  expect(fixture.queries.slice(0,3)).toEqual(["set local statement_timeout='5s'","set local lock_timeout='1s'","set local transaction_timeout='15s'"]);
  expect(fixture.queries.slice(3).every(query=>query.startsWith('select'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('metadata');expect(fixture.end).toHaveBeenCalled();
  assertReleaseSchema(result,await captureReleaseSchema(options));
 });
 it('rejects each drift category and malformed baselines',async()=>{
  const result=await captureReleaseSchema(options);
  for(const patch of [{migrations:['001_next.sql']},{functionsSha256:'a'.repeat(64)},{columnsSha256:'b'.repeat(64)}])expect(()=>assertReleaseSchema({...result,...patch},result)).toThrow('RELEASE_SCHEMA_CHANGED');
  expect(()=>validateSchemaFingerprint({...result,migrations:['001_next.sql','000_initial.sql']})).toThrow();
  expect(()=>validateSchemaFingerprint({...result,functionsSha256:'invalid'})).toThrow();
 });
 it('requires exact reviewed migration names, not only the count',async()=>{
  fixture.rows=[{name:'001_other.sql'}];await expect(captureReleaseSchema(options)).rejects.toThrow('RELEASE_SCHEMA_MIGRATIONS_CHANGED');
  await expect(captureReleaseSchema({...options,expectedMigrations:['000_initial.sql','000_initial.sql']})).rejects.toThrow('RELEASE_SCHEMA_MIGRATIONS_INVALID');
 });
 it('rejects wrong branch, pooler, lookalike hostname and URL option overrides',()=>{
  validateReleaseDatabaseTarget(options.connection,'branch');
  validateReleaseDatabaseTarget(options.connection+'?sslmode=verify-full','branch');
  for(const url of [options.connection.replace('role.branch','role.other'),options.connection.replace(':5432',':6432'),options.connection.replace('.pg.psdb.cloud','.pg.psdb.cloud.invalid'),options.connection+'?sslmode=disable','invalid'])expect(()=>validateReleaseDatabaseTarget(url,'branch')).toThrow('RELEASE_SCHEMA_TARGET_INVALID');
 });
 it('sanitizes database errors and closes the connection',async()=>{
  fixture.fail=true;await expect(captureReleaseSchema(options)).rejects.toThrow(/^RELEASE_SCHEMA_READ_FAILED$/);expect(fixture.end).toHaveBeenCalled();
 });
 it('does not connect after cancellation',async()=>{
  const abort=new AbortController();abort.abort();await expect(captureReleaseSchema({...options,signal:abort.signal})).rejects.toThrow();expect(fixture.queries).toEqual([]);
 });
});
