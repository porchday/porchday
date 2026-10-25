import {test,expect,vi} from 'vitest';
import {event,normalizedRoute} from '../src/telemetry';
test('telemetry drops identifiers, secret-like strings and arbitrary payload fields even on failures',()=>{
 const spy=vi.spyOn(console,'log').mockImplementation(()=>{});
 try{
  event('error',{code:'private-secret-token-should-never-appear',route:'/api/posts/4dc907ef-5906-47da-9214-84bbd9f5fb22?key=secret',environment:'member@example.test',message:'private text',password:'secret',body:'private media',status:500} as never);
  const serialized=spy.mock.calls.map(x=>x[0]).join('');
  expect(JSON.parse(serialized)).toEqual({event:'error',status:500});
  expect(normalizedRoute('/api/auth/reset-password/secret-token?token=secret')).toBe('/api/auth/*');
 }finally{spy.mockRestore();}
});
test('unavailable telemetry never fails the application operation',()=>{
 const spy=vi.spyOn(console,'log').mockImplementation(()=>{throw Error('transport down');});
 try{expect(()=>event('job',{code:'cleanup_complete',count:3})).not.toThrow();}finally{spy.mockRestore();}
});
