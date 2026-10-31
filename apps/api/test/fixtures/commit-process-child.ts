import postgres from 'postgres';
import {ProcessJournalStore} from './commit-process-store';
import {beginPrivacyIntent,publishAuthPrivacyCommitScope,checkpointJournal,completePrivacyIntent,type JournalDatabase} from '../../src/privacy-journal';

const url=process.env.COMMIT_PROCESS_DATABASE_URL,directory=process.env.COMMIT_PROCESS_DIRECTORY,phase=process.env.COMMIT_PROCESS_PHASE,fixture=process.env.COMMIT_PROCESS_FIXTURE;
if(!url||!directory||!phase||!fixture||!process.send||!['localhost','127.0.0.1'].includes(new URL(url).hostname)||!new URL(url).pathname.endsWith('/porchday_commit_proof_test'))throw Error('DISPOSABLE_PROCESS_FIXTURE_REQUIRED');
process.umask(0o077);
const owner=postgres(url,{max:1,prepare:false}),authUrl=new URL(url);authUrl.username='porchday_commit_auth_test';authUrl.password='local-commit-proof-only';
const auth=postgres(authUrl.href,{max:1,prepare:false});
const store=new ProcessJournalStore(directory),db:JournalDatabase={
 async status(){return(await owner`select app.safety_status() as value`)[0].value;},
 async page(after){return(await owner`select app.safety_page(${after}::bigint,200) as value`)[0].value;},
};
async function pause(name:string){if(name!==phase)return;process.send!({phase:name});await new Promise(()=>{});}
try{
 const intent=await beginPrivacyIntent(store,db),scope=await publishAuthPrivacyCommitScope(store,db,intent);
 process.send!({operationId:intent.id});await pause('registered');
 await auth.begin(async tx=>{
  await tx`update public.commit_fixture set value=value+1 where id=${fixture}`;
  await tx`select app.complete_privacy_transaction(${scope.operationId}::uuid,${scope.scopeSha256},${scope.generation}::uuid)`;
  await pause('before-commit');
 });
 await pause('after-commit');await checkpointJournal(store,db);await pause('after-checkpoint');
 store.afterPut=async(key,text)=>{
  if(key===`receipts/${intent.id}.json`)await pause('after-receipt');
  if(key==='control.json'&&JSON.parse(text).pending.length===0)await pause('after-retirement');
 };
 await completePrivacyIntent(store,db,intent);
 process.send!({failed:true});process.exitCode=1;
}catch{process.send!({failed:true});process.exitCode=1;}
finally{await auth.end();await owner.end();process.disconnect?.();}
