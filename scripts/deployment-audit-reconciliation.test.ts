import {it,expect} from 'vitest';
import {verifyFailedActivation} from './deployment-audit-reconciliation.ts';
const id=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const plan={operationId:id(1),worker:'porchday-staging',candidateVersion:id(2),baselineVersion:id(3),baselineDeploymentId:id(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[id(3)],evidenceDigest:'b'.repeat(64)};
const account='a'.repeat(32),now=Date.parse('2026-11-01T18:30:00Z'),start='2026-11-01T18:20:00Z';
function fixtures(){const event={id:id(9),account:{id:account},action:{description:'Create Worker Deployment',type:'create',result:'failure',time:'2026-11-01T18:22:00Z'},raw:{method:'POST',status_code:500,uri:'/accounts/'+account+'/workers/scripts/'+plan.worker+'/deployments'},resource:{id:plan.worker,type:'scripts.deployments',request:{strategy:'percentage',versions:[{version_id:plan.candidateVersion,percentage:100}],annotations:{'workers/message':'porchday-recovery:'+plan.operationId}}}};const audit={success:true,result:[event]},history={success:true,result:{deployments:[{id:plan.baselineDeploymentId,versions:[{version_id:plan.baselineVersion,percentage:100}]}]}};return {audit,history,event};}
it('requires exact provider failure plus unchanged original deployment on both sides',()=>{const {audit,history}=fixtures();expect(verifyFailedActivation(plan,account,audit,history,history,start,now).disposition).toBe('provider-failed-baseline-retained');});
it.each(['success','operation','version','account','uri','recent','duplicate','pagination','changed','historical-candidate','missing'] as const)('fails closed for %s evidence',kind=>{const {audit,history,event}=fixtures();let after=structuredClone(history);switch(kind){case 'success':event.action.result='success';break;case 'operation':event.resource.request.annotations['workers/message']='other';break;case 'version':event.resource.request.versions[0].version_id=id(8);break;case 'account':event.account.id='c'.repeat(32);break;case 'uri':event.raw.uri+='/other';break;case 'recent':event.action.time='2026-11-01T18:29:00Z';break;case 'duplicate':audit.result.push(event);break;case 'pagination':Object.assign(audit,{result_info:{cursor:'more'}});break;case 'changed':after.result.deployments[0].id=id(8);break;case 'historical-candidate':after.result.deployments.push({id:id(8),versions:[{version_id:plan.candidateVersion,percentage:100}]});break;case 'missing':audit.result=[];break;}expect(()=>verifyFailedActivation(plan,account,audit,history,after,start,now)).toThrow('UNPROVEN');});
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
import {registerReleaseWatch,inspectReleaseWatch} from './release-watch.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {deploymentPlanHash,type RecoveryJournal} from './deployment-recovery.ts';
it('archives the exact lease with evidence, keeps the journal/canonical, and prevents replay',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'audit-lease-'))),canonical=JSON.stringify({stagingVersion:plan.baselineVersion,stagingRuntimeSource:'c'.repeat(40),compatibleRollbackVersions:{staging:plan.baselineVersion}});
 writeFileSync(join(root,'latest-verified-deployment.json'),canonical,{mode:0o600});let lease:FileDeploymentLease|undefined;
 try{
  lease=FileDeploymentLease.acquire(root,plan);const state={v:1 as const,revision:2,planHash:deploymentPlanHash(plan),phase:'activation-intent' as const},journal=new FileRecoveryJournal(join(root,'journal'));mkdirSync(join(root,'proofs'),{mode:0o700});const prepared={...state,revision:1,phase:'prepared' as const};await journal.write(null,prepared);await journal.write(prepared,state);const watch=registerReleaseWatch({root,plan,journalDirectory:join(root,'journal'),proofDirectory:join(root,'proofs')});
  const {audit,history,event}=fixtures();event.action.time=new Date(Date.now()-360000).toISOString();
  // Acquisition occurs after this historical request in this test; mirror an
  // existing durable operation created before the original provider request.
  lease.close();const ownerPath=join(root,'deployment-lock/owner.json'),owner=JSON.parse(readFileSync(ownerPath,'utf8'));owner.at=new Date(Date.now()-600000).toISOString();writeFileSync(ownerPath,JSON.stringify(owner));lease=FileDeploymentLease.acquire(root,plan);
  await expect(lease.reconcileFailedActivation(journal,account,async()=>({audit:{success:true,result:[]},before:history,after:history}))).rejects.toThrow('UNPROVEN');expect(existsSync(join(root,'deployment-lock'))).toBe(true);
  await lease.reconcileFailedActivation(journal,account,async()=>({audit,before:history,after:history}));
  expect(existsSync(join(root,'deployment-lock'))).toBe(false);expect(existsSync(join(root,'deployment-recovery-cancelled-'+plan.operationId,'rejection-reconciliation.json'))).toBe(true);expect(readFileSync(join(root,'latest-verified-deployment.json'),'utf8')).toBe(canonical);expect(()=>FileDeploymentLease.acquire(root,plan)).toThrow('ALREADY_CANCELLED');expect(await inspectReleaseWatch(watch)).toEqual({status:'cancelled'});expect(await journal.read()).toEqual(state);
 }finally{lease?.close();rmSync(root,{recursive:true,force:true});}
});
