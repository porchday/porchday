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
import {executeFrontendActivationWithClients,executeApplicationActivationWithClients,executeStagingBrowserRecoveryDrill,executeStagingApiRecoveryDrill} from './release-frontend-observation.ts';
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

it.each(['staging','production'])('observes asset-serving %s application workers before completion',async environment=>{
 manifest.plan.worker='porchday-'+environment;delete manifest.plan.backendVersion;delete manifest.plan.backendReaderFloor;
 manifest.plan.assetManifests={baseline:'a'.repeat(64),candidate:'b'.repeat(64)};
 manifest.review.assets.baseline.files['index.html']='a'.repeat(64);manifest.review.assets.candidate.files['index.html']='b'.repeat(64);observation.target.environment=environment;
 expect((await executeApplicationActivationWithClients('/manifest',{},observation,new AbortController().signal)).browser.passed).toBe(true);
 expect(ports.begin).toHaveBeenCalledWith(expect.objectContaining({origin:environment==='staging'?'https://staging.porchday.com':'https://porchday.org'}));expect(ports.execute).toHaveBeenCalledOnce();expect(browser.finish).toHaveBeenCalledOnce();
});
it('rejects missing web assets, monitor targets and environment drift before dispatch',async()=>{
 await expect(executeApplicationActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('ASSETS_REQUIRED');
 manifest.review.assets.baseline.files['index.html']='a'.repeat(64);manifest.review.assets.candidate.files['index.html']='b'.repeat(64);
 await expect(executeApplicationActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('ASSET_PINS_REQUIRED');
 manifest.plan.assetManifests={baseline:'a'.repeat(64),candidate:'b'.repeat(64)};
 manifest.plan.worker='porchday-monitor-staging';await expect(executeApplicationActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('TARGET_INVALID');
 manifest.plan.worker='porchday-staging';observation.target.environment='production';await expect(executeApplicationActivationWithClients('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('SCOPE_CHANGED');
 expect(ports.execute).not.toHaveBeenCalled();expect(ports.begin).not.toHaveBeenCalled();
});
it('requires staging before creating any drill intent or launching a browser',async()=>{
 manifest.plan.worker='porchday-production';observation.target.environment='production';
 await expect(executeStagingBrowserRecoveryDrill('/manifest',{},observation,new AbortController().signal)).rejects.toThrow('STAGING_REQUIRED');
 expect(ports.begin).not.toHaveBeenCalled();expect(ports.execute).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual(['journal']);
});
it.each((['rolled-back','complete','attention-required','missing-injection','unexpected-pass','missing-error'] as const).flatMap(outcome=>[false,true].map(apiOnly=>({outcome,apiOnly}))))('requires observed fault and verified rollback for a drill: $outcome API-only=$apiOnly',async({outcome,apiOnly})=>{
 manifest.plan.assetManifests={baseline:'a'.repeat(64),candidate:'b'.repeat(64)};
 manifest.review.assets.baseline.files['index.html']='a'.repeat(64);manifest.review.assets.candidate.files['index.html']='b'.repeat(64);
 if(apiOnly){manifest.plan.worker='porchday-staging';delete manifest.plan.backendVersion;delete manifest.plan.backendReaderFloor;delete manifest.plan.assetManifests;manifest.review.assets.candidate=structuredClone(manifest.review.assets.baseline);}
 const unknown=['missing-injection','unexpected-pass','missing-error'].includes(outcome);
 browser.finish.mockResolvedValue({passed:outcome==='unexpected-pass',drill:'staging-fresh-client-exception',drillExceptionObserved:outcome!=='missing-injection',newErrors:{pageErrors:outcome==='missing-error'?0:1}});
 ports.execute.mockImplementation(async(_m,_e,_o,s,accept)=>{expect(await accept(s)).toBe(unknown?'unknown':'unhealthy');return {status:unknown?'attention-required':outcome};});
 const result=(apiOnly?executeStagingApiRecoveryDrill:executeStagingBrowserRecoveryDrill)('/manifest',{},observation,new AbortController().signal);
 if(outcome==='rolled-back'){
  expect((await result).command.status).toBe('rolled-back');expect(JSON.parse(readFileSync(file('drill-result'),'utf8')).value.passed).toBe(true);expect(ports.alert).toHaveBeenCalledWith(root,manifest.plan,'notification-drill');
 }else{await expect(result).rejects.toThrow('UNVERIFIED');expect(readdirSync(root)).not.toContain(`frontend-${id}-drill-result.json`);expect(ports.alert).toHaveBeenCalledWith(root,manifest.plan,'command-failed');}
 expect(ports.begin).toHaveBeenCalledWith(expect.objectContaining({origin:'https://staging.porchday.com',stagingFreshClientException:true}));expect(ports.execute).toHaveBeenCalledOnce();expect(browser.close).toHaveBeenCalledOnce();
});

it.each(['production','frontend','asset-promotion','changed-public-assets','history'])('rejects API drill %s before browser work or intent',async kind=>{
 manifest.plan.worker='porchday-staging';delete manifest.plan.backendVersion;delete manifest.plan.backendReaderFloor;
 manifest.review.assets.baseline.files['index.html']='a'.repeat(64);manifest.review.assets.candidate=structuredClone(manifest.review.assets.baseline);
 if(kind==='production'){manifest.plan.worker='porchday-production';observation.target.environment='production';}
 if(kind==='frontend')manifest.plan.worker='porchday-staging-edge';
 if(kind==='asset-promotion')manifest.plan.assetManifests={baseline:'a'.repeat(64),candidate:'a'.repeat(64)};
 if(kind==='changed-public-assets')manifest.review.assets.candidate.files['index.html']='b'.repeat(64);
 if(kind==='history')ports.state.mockResolvedValue({phase:'complete'});
 await expect(executeStagingApiRecoveryDrill('/manifest',{},observation,new AbortController().signal)).rejects.toThrow();
 expect(ports.begin).not.toHaveBeenCalled();expect(ports.execute).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual(['journal']);
});

function apiActionDrill(){
 manifest.plan.worker='porchday-staging';delete manifest.plan.backendVersion;delete manifest.plan.backendReaderFloor;
 manifest.review.assets.baseline.files['index.html']='a'.repeat(64);manifest.review.assets.candidate=structuredClone(manifest.review.assets.baseline);
 browser.finish.mockResolvedValue({passed:false,drill:'staging-fresh-client-exception',drillExceptionObserved:true,newErrors:{pageErrors:1}});
}
it('claims a candidate action durably after candidate verification and before the browser fault',async()=>{
 apiActionDrill();const action=vi.fn(async(signal:AbortSignal)=>{
  expect(signal.aborted).toBe(false);expect(browser.finish).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(file('candidate-action-intent'),'utf8')).value.automaticRetry).toBe(false);
  return 'verified' as const;
 });
 browser.finish.mockImplementation(async()=>{
  expect(JSON.parse(readFileSync(file('candidate-action-result'),'utf8')).value.status).toBe('verified');
  return{passed:false,drill:'staging-fresh-client-exception',drillExceptionObserved:true,newErrors:{pageErrors:1}};
 });
 const result=await executeStagingApiRecoveryDrill('/manifest',{},observation,new AbortController().signal,action);
 expect(result.command.status).toBe('rolled-back');expect(action).toHaveBeenCalledOnce();expect(browser.finish).toHaveBeenCalledOnce();
 await expect(executeStagingApiRecoveryDrill('/manifest',{},observation,new AbortController().signal,action)).rejects.toThrow();
 expect(action).toHaveBeenCalledOnce();expect(ports.execute).toHaveBeenCalledOnce();
});
it.each(['lost-reply','invalid-result','abort-after-action','scope-drift','browser-closed'])('retains unknown candidate action %s without injecting the expected fault or retrying',async kind=>{
 apiActionDrill();const controller=new AbortController();
 const action=vi.fn(async()=>{
  if(kind==='lost-reply')throw Error('private action credentials');
  if(kind==='abort-after-action')controller.abort();
  if(kind==='scope-drift')observation.assertScope.mockImplementation(()=>{throw Error('private drift');});
  if(kind==='browser-closed')browser.assertOpen.mockImplementation(()=>{throw Error('private browser');});
  return kind==='invalid-result'?{private:'action payload'}:'verified';
 });
 ports.execute.mockImplementation(async(_m,_e,_o,s,accept)=>{expect(await accept(s)).toBe('unknown');return{status:'attention-required'};});
 await expect(executeStagingApiRecoveryDrill('/manifest',{},observation,controller.signal,action as any)).rejects.toThrow('UNVERIFIED');
 expect(action).toHaveBeenCalledOnce();expect(browser.finish).not.toHaveBeenCalled();
 expect(JSON.parse(readFileSync(file('candidate-action-result'),'utf8')).value.status).toBe('unknown');
 expect(readdirSync(root)).not.toContain(`frontend-${id}-drill-result.json`);
 expect(readdirSync(root).filter(x=>x.endsWith('.json')).map(x=>readFileSync(join(root,x),'utf8')).join('')).not.toContain('private');
 await expect(executeStagingApiRecoveryDrill('/manifest',{},observation,new AbortController().signal,action as any)).rejects.toThrow();expect(action).toHaveBeenCalledOnce();
});
it('refuses an existing action claim and duplicate acceptance calls before a second side effect',async()=>{
 apiActionDrill();const action=vi.fn(async()=>'verified' as const);
 ports.execute.mockImplementation(async(_m,_e,_o,s,accept)=>{expect(await accept(s)).toBe('unhealthy');await accept(s);return{status:'rolled-back'};});
 await expect(executeStagingApiRecoveryDrill('/manifest',{},observation,new AbortController().signal,action)).rejects.toThrow('UNVERIFIED');
 expect(action).toHaveBeenCalledOnce();expect(browser.finish).toHaveBeenCalledOnce();
});
it.each(['production','frontend','assets','history','aborted','invalid-hook'])('does not run a candidate action for rejected %s scope',async kind=>{
 apiActionDrill();const controller=new AbortController(),action=vi.fn(async()=>'verified' as const);
 if(kind==='production'){manifest.plan.worker='porchday-production';observation.target.environment='production';}
 if(kind==='frontend')manifest.plan.worker='porchday-staging-edge';
 if(kind==='assets')manifest.review.assets.candidate.files['index.html']='b'.repeat(64);
 if(kind==='history')ports.state.mockResolvedValue({phase:'rolled-back'});
 if(kind==='aborted')controller.abort();
 await expect(executeStagingApiRecoveryDrill('/manifest',{},observation,controller.signal,kind==='invalid-hook'?'invalid' as any:action)).rejects.toThrow();
 expect(action).not.toHaveBeenCalled();expect(ports.execute).not.toHaveBeenCalled();expect(ports.begin).not.toHaveBeenCalled();expect(readdirSync(root)).toEqual(['journal']);
});
