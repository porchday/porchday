import {it,expect} from 'vitest';
import {leasedRoutingPorts} from './release-routing-ports.ts';
import {deploymentPlanHash,type DeploymentPlan,type RecoveryState} from './deployment-recovery.ts';
import {routingPlanHash,type RoutingState} from './domain-routing-recovery.ts';
const uuid=(n:number)=>n.toString().padStart(8,'0')+'-0000-0000-0000-000000000000';
const before={hostname:'staging.porchday.com',service:'porchday-staging',environment:'production',zoneId:'a'.repeat(32)},after={...before,service:'porchday-staging-edge'};
const plan:DeploymentPlan={operationId:uuid(1),worker:after.service,candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64),backendVersion:uuid(8),backendReaderFloor:uuid(9),routing:{operationId:uuid(1),moves:[{before,after}]}};
it.each(['lease','version','deployment','intent','inventory','abort'] as const)('refuses routing writes when %s changes',async kind=>{
 const deployment:RecoveryState={v:1,revision:3,planHash:deploymentPlanHash(plan),phase:'candidate-observed',candidateDeploymentId:uuid(5)};
 const state:RoutingState={revision:2,planHash:routingPlanHash(plan.routing!),direction:'forward',completed:0,intent:kind!=='intent',terminal:false};
 let writes=0;
 const ports=leasedRoutingPorts({plan,lease:{assert:()=>{if(kind==='lease')throw Error('lease lost');return {}; }},deploymentJournal:{read:async()=>deployment,write:async()=>{}},routingJournal:{read:async()=>state,write:async()=>{}},observeDeployment:async()=>({version:kind==='version'?uuid(99):plan.candidateVersion,deploymentId:kind==='deployment'?uuid(99):uuid(5),operationId:plan.operationId}),verifyInventory:async()=>{if(kind==='inventory')throw Error('inventory drift');},provider:{observe:async()=>before,assign:async()=>{writes++;}},signal:kind==='abort'?AbortSignal.abort():new AbortController().signal});
 await expect(ports.assign(after)).rejects.toThrow();expect(writes).toBe(0);
});
