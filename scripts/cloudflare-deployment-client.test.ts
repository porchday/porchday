import {it,expect,vi} from 'vitest';
import {CloudflareDeploymentClient} from './cloudflare-deployment-client.ts';
import {observeDeployment} from './deployment-recovery.ts';
const version='22222222-0000-0000-0000-000000000000',deployment='33333333-0000-0000-0000-000000000000',operation='11111111-0000-0000-0000-000000000000';
const reply=(percentage=100,message='porchday-recovery:'+operation)=>Response.json({success:true,result:{deployments:[{id:deployment,versions:[{version_id:version,percentage}],annotations:{'workers/message':message}}]}});
const client=(fetch:typeof globalThis.fetch)=>new CloudflareDeploymentClient({accountId:'a'.repeat(32),worker:'porchday-staging',apiToken:'synthetic-only-token-for-test',fetch});
it('routes frontend observations to that exact Worker endpoint',async()=>{
 const request=vi.fn(async()=>reply()),frontend=new CloudflareDeploymentClient({accountId:'a'.repeat(32),worker:'porchday-staging-edge',apiToken:'synthetic-only-token-for-test',fetch:request});
 expect((await frontend.observe(new AbortController().signal)).version).toBe(version);expect((request.mock.calls as unknown as [string,RequestInit][])[0][0]).toBe('https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/porchday-staging-edge/deployments');
});
it('retries the observed Cloudflare 500 read and preserves operation identity',async()=>{
 const request=vi.fn().mockResolvedValueOnce(Response.json({success:false,errors:[{code:10500}]},{status:500})).mockResolvedValueOnce(reply());
 expect(await observeDeployment(client(request),undefined,async()=>{})).toEqual({version,deploymentId:deployment,operationId:operation});expect(request).toHaveBeenCalledTimes(2);expect(request.mock.calls.every(x=>!x[1].method)).toBe(true);
});
it('rejects authorization failures without repeating the read or exposing the body',async()=>{
 const request=vi.fn(async()=>new Response('sensitive upstream detail',{status:403}));await expect(observeDeployment(client(request),undefined,async()=>{})).rejects.toThrow('DEPLOYMENT_PROVIDER_READ_REJECTED');expect(request).toHaveBeenCalledTimes(1);
});
it('rejects a percentage rollout rather than silently selecting one version',async()=>{
 await expect(client(vi.fn(async()=>reply(50))).observe(new AbortController().signal)).rejects.toThrow('STATE_UNSUPPORTED');
});
it('classifies legacy annotations as unowned',async()=>{
 expect((await client(vi.fn(async()=>reply(100,'A different deployment'))).observe(new AbortController().signal)).operationId).toBeNull();
});
it('sends one annotated POST and reports uncertainty without retrying it',async()=>{
 const request=vi.fn(async()=>{throw Error('network includes a credential');});await expect(client(request).deploy(version,operation,new AbortController().signal)).rejects.toThrow('DEPLOYMENT_WRITE_UNCONFIRMED');expect(request).toHaveBeenCalledTimes(1);const init=(request.mock.calls as unknown as [string,RequestInit][])[0][1];expect(init.method).toBe('POST');expect(JSON.parse(init.body as string).annotations['workers/message']).toBe('porchday-recovery:'+operation);
});
it('bounds provider response bodies',async()=>{
 await expect(client(vi.fn(async()=>new Response('x'.repeat(65537)))).observe(new AbortController().signal)).rejects.toThrow('RESPONSE_INVALID');
});
it('retries a broken read response stream without retaining its error details',async()=>{
 const broken=new Response(new ReadableStream({start(controller){controller.error(Error('private transport detail'));}}));const request=vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(reply());
 expect((await observeDeployment(client(request),undefined,async()=>{})).version).toBe(version);expect(request).toHaveBeenCalledTimes(2);
});
