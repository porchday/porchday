/** Operator-only staging bootstrap. No hosted execution without exact human approval. */
import postgres from 'postgres';
import {readFile,open} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {argumentsFor,expectedEmail,readReference,verifyDirectory,verifyAccessInventory,stagingConnection,provisionRole,StaffRoleError} from './provision-staff-role-support.js';

let db:ReturnType<typeof postgres>|undefined,intent:Awaited<ReturnType<typeof open>>|undefined,applyStarted=false;
try{
 const options=argumentsFor(process.argv.slice(2)),email=expectedEmail(options.identity,process.env);
 const resources=JSON.parse(await readFile('infra/resources.json','utf8'));
 const connection=stagingConnection(process.env,resources); // Bind account/branch before any provider read.
 const reference=await readReference(options.referencePath,email);
 // This existing tool verifies both staff rosters, OTP, Launcher and MFA. Its
 // output is deliberately not forwarded; provider errors cannot disclose email.
 try{const result=await promisify(execFile)('python3',['scripts/provision-staff-access.py','--check'],{timeout:60_000,maxBuffer:64*1024});verifyAccessInventory(JSON.parse(result.stdout),resources);}catch{throw new StaffRoleError('STAFF_ROLE_ACCESS_CONFIGURATION');}
 await verifyDirectory(reference,process.env);
 db=postgres(connection,{max:1,prepare:false,fetch_types:false,ssl:'verify-full',connect_timeout:10,onnotice:()=>{}});
 if(options.apply){
  // Exclusive intent persists across uncertain outcomes; no blind apply retry.
  intent=await open(options.referencePath+'.apply-receipt.jsonl','wx',0o600);
  await intent.writeFile(JSON.stringify({v:1,environment:'staging',identity:options.identity,reference,role:'recovery',state:'intent',startedAt:new Date().toISOString()})+'\n');await intent.sync();applyStarted=true;
 }
 const result=await provisionRole(db,reference,options.apply);
 if(intent){await intent.writeFile(JSON.stringify({state:'verified',result,completedAt:new Date().toISOString()})+'\n');await intent.sync();}
 console.log(JSON.stringify({environment:'staging',identity:options.identity,role:'recovery',mode:options.apply?'apply':'read_only',result,directoryCrosscheck:true,mfaProof:'human_confirmation_required'}));
}catch(error){
 const code=error instanceof StaffRoleError?error.message:'STAFF_ROLE_OPERATION_FAILED';
 console.error(JSON.stringify({error:code,...(applyStarted?{writeOutcome:'inspect_private_receipt_and_run_read_only_before_any_retry'}:{})}));process.exitCode=1;
}finally{
 try{await intent?.close();}catch{console.error(JSON.stringify({error:'STAFF_ROLE_RECEIPT_CLOSE_FAILED'}));process.exitCode=1;}
 try{await db?.end({timeout:1});}catch{console.error(JSON.stringify({error:'STAFF_ROLE_DATABASE_CLOSE_FAILED'}));process.exitCode=1;}
}

