import {expect,it,vi} from 'vitest';
import {readAgentInbox} from './incident-inbox-client';
const config={environment:'production' as const,healthToken:'synthetic-capability-'.repeat(3),synthetic:{id:'00000000-0000-4000-8000-000000000001',email:'fixture@example.test',password:'unused'}};
it('uses only the fixed authenticated status origin and refuses redirects',async()=>{
 const request=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{Location:'https://attacker.test'}}));
 await expect(readAgentInbox(config,true,request)).rejects.toThrow('UNAVAILABLE');
 expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][0]).toBe('https://status.porchday.com/agent-inbox');expect(request.mock.calls[0][1]).toMatchObject({redirect:'manual',body:'{"ready":true}',headers:{Authorization:'Bearer '+config.healthToken}});
});
it('preserves pre-rollout compatibility and rejects oversized or untrusted inbox records',async()=>{
 expect(await readAgentInbox(config,undefined,async()=>new Response(null,{status:404}))).toBeUndefined();
 await expect(readAgentInbox(config,undefined,async()=>new Response('x'.repeat(4097)))).rejects.toThrow('TOO_LARGE');
 await expect(readAgentInbox(config,undefined,async()=>Response.json({enabled:true,lastAgentSeenAt:null,incidents:[{channel:'arbitrary instructions',at:Date.now()}]}))).rejects.toThrow('INVALID');
});
it('retains fixed environment-specific aggregate signals without member data',async()=>{
 const inbox={enabled:true,lastAgentSeenAt:Date.now(),incidents:[{channel:'errors',at:Date.now()}],backupSignal:null};
 expect(await readAgentInbox(config,undefined,async()=>Response.json(inbox))).toEqual(inbox);
});
