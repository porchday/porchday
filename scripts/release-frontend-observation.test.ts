import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const ports=vi.hoisted(()=>({read:vi.fn(),execute:vi.fn(),begin:vi.fn(),state:vi.fn(),completed:vi.fn(),gate:vi.fn(),alert:vi.fn()}));
vi.mock('./release-activation-cli.ts',()=>({readActivationManifest:ports.read,executeActivationWithContinuity:ports.execute}));
vi.mock('./release-assets-hosted.ts',()=>({beginHostedAssetTransition:ports.begin}));
vi.mock('./deployment-recovery-journal.ts',()=>({FileRecoveryJournal:class{read=ports.state;}}));
vi.mock('./deployment-recovery-lease.ts',()=>({FileDeploymentLease:{completed:ports.completed}}));
vi.mock('./release-continuity-gate.ts',()=>({createContinuityGate:()=>({assertPromotion:ports.gate})}));
vi.mock('./release-alerts.ts',()=>({queueReleaseAlert:ports.alert}));
import {executeFrontendActivationWithClients} from './release-frontend-observation.ts';
let root:string,manifest:any,browser:any,observation:any;
const id='11111111-1111-4111-8111-111111111111',baseline='22222222-2222-4222-8222-222222222222',candidate='33333333-3333-4333-8333-333333333333';
const file=(kind:string)=>join(root,`frontend-${id}-${kind}.json`);
beforeEach(()=>{
 vi.resetAllMocks();root=realpathSync(mkdtempSync(join(tmpdir(),'frontend-observed-')));mkdirSync(join(root,'journal'),{mode:0o700});
 manifest={plan:{operationId:id,worker:'porchday-staging-edge',candidateVersion:candidate,baselineVersion:baseline,baselineDeploymentId:baseline,candidateSource:'a'.repeat(40),backendVersion:baseline,backendReaderFloor:baseline,compatibleRollbackVersions:[baseline],evidenceDigest:'b'.repeat(64)},review:{assets:{baseline:{source:'a'.repeat(40),files:{}},candidate:{source:'b'.repeat(40),files:{}}},execution:{root,proofDirectory:root,journalDirectory:join(root,'journal')}}};
 browser={baselineReceipt:{observed:true},assertOpen:vi.fn(),finish:vi.fn().mockResolvedValue({passed:true}),close:vi.fn().mockResolvedValue(undefined)};
 observation={target:{environment:'staging'},assertScope:vi.fn()};ports.read.mockReturnValue(manifest);ports.begin.mockResolvedValue(browser);ports.state.mockResolvedValue(null);ports.completed.mockResolvedValue(null);ports.execute.mockImplementation(async(_m,_e,_o,s,accept)=>({status:await accept(s)==='healthy'?'complete':'rolled-back',samples:3}));
});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
it('persists browser baseline and command intent before one maintained activation, then the result',async()=>{
 ports.execute.mockImplementation(async(_m,_e,o,s,accept)=>{expect(JSON.parse(readFileSync(file('baseline'),'utf8')).value.observed).toBe(true);expect(JSON.parse(readFileSync(file('command-intent'),'utf8')).value.automaticRetry).toBe(false);o.assertScope();expect(await accept(s)).toBe('healthy');browser.assertOpen.mockImplementation(()=>{throw Error('closed after acceptance');});o.assertScope();return {status:'complete'};});
 const result=await executeFrontendActivationWithClients('/manifest',{},observation,new AbortController().signal);
 expect(result.browser.passed).toBe(true);expect(ports.execute).toHaveBeenCalledTimes(1);expect(browser.assertOpen).toHaveBeenCalled();expect(observation.assertScope).toHaveBeenCalled();expect(browser.finish).toHaveBeenCalledOnce();expect(browser.close).toHaveBeenCalledOnce();expect(ports.alert).not.toHaveBeenCalled();
 expect(JSON.parse(readFileSync(file('browser-result'),'utf8')).value.passed).toBe(true);
});
it('does not dispatch when baseline observation or its durable receipt fails',async()=>{
 writeFileSync(file('baseline'),'existing');await expect(executeFrontendActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('UNVERIFIED');expect(ports.execute).not.toHaveBeenCalled();expect(browser.close).toHaveBeenCalledOnce();expect(ports.alert).toHaveBeenCalledOnce();
});
it.each(['rolled-back','attention-required','throw','browser-failure'])('retains %s without replay or a fabricated successful browser acceptance',async outcome=>{
 if(outcome==='throw')ports.execute.mockRejectedValue(Error('private provider text'));else if(outcome==='browser-failure')browser.finish.mockResolvedValue({passed:false,newErrors:{pageErrors:1}});else ports.execute.mockResolvedValue({status:outcome});
 await expect(executeFrontendActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('UNVERIFIED');expect(ports.execute).toHaveBeenCalledOnce();expect(browser.close).toHaveBeenCalledOnce();expect(ports.alert).toHaveBeenCalledOnce();
 if(outcome!=='browser-failure')expect(browser.finish).not.toHaveBeenCalled();
 const stored=readdirSync(root).filter(x=>x.endsWith('.json')).map(x=>readFileSync(join(root,x),'utf8')).join('');expect(stored).not.toContain('private provider text');expect(JSON.parse(readFileSync(file('attention'),'utf8')).value.automaticRetry).toBe(false);
 await expect(executeFrontendActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow();expect(ports.execute).toHaveBeenCalledOnce();
});
it('rejects historical state and wrong scope before browser work',async()=>{
 ports.state.mockResolvedValue({phase:'complete'});await expect(executeFrontendActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('REQUIRES_RECONCILIATION');expect(ports.begin).not.toHaveBeenCalled();
 ports.state.mockResolvedValue(null);manifest.plan.worker='porchday-staging';await expect(executeFrontendActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('TARGET_REQUIRED');expect(ports.begin).not.toHaveBeenCalled();expect(ports.execute).not.toHaveBeenCalled();
});

it('retains a failed close and never exposes its exception text as acceptance',async()=>{
 browser.close.mockRejectedValue(Error('private close failure'));
 await expect(executeFrontendActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('CLOSE_UNVERIFIED');
 expect(JSON.parse(readFileSync(file('close-failure'),'utf8')).value.code).toBe('FRONTEND_OBSERVATION_CLOSE_UNVERIFIED');expect(ports.execute).toHaveBeenCalledOnce();expect(ports.alert).toHaveBeenCalledOnce();
});
it('checks observer liveness during the maintained command',async()=>{
 browser.assertOpen.mockImplementation(()=>{throw Error('closed');});
 ports.execute.mockImplementation(async(_m,_e,o)=>{o.assertScope();throw Error('must not proceed');});
 await expect(executeFrontendActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('UNVERIFIED');
 expect(browser.finish).not.toHaveBeenCalled();expect(ports.execute).toHaveBeenCalledOnce();expect(browser.close).toHaveBeenCalledOnce();
});
