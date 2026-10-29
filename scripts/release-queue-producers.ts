import {isDeepStrictEqual} from 'node:util';

export type QueueProducerRegistration={keys:string[]};
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('QUEUE_PRODUCER_REGISTRATION_INVALID');return value as Record<string,unknown>;}
/** Explicit binding-only preparation of paused, unattached range queues.
 * Upload/rollback may expose either no registration or this exact Worker.
 * Candidate activation requires its registration. Raw observations are retained;
 * no consumer, setting, foreign producer or other inventory change is admitted.
 */
export function registeredQueueInventory(options:{before:unknown;observed:unknown;worker:string;beforeBindings:unknown;afterBindings:unknown;registration:QueueProducerRegistration;phase:'upload'|'candidate'|'baseline'}){
 const fail=():never=>{throw Error('QUEUE_PRODUCER_REGISTRATION_INVALID');};
 const {worker,registration,phase}=options;
 if(!['staging','production'].includes(worker)||!['upload','candidate','baseline'].includes(phase)||!registration||Object.keys(registration).join(',')!=='keys'||!Array.isArray(registration.keys)||registration.keys.length<1||registration.keys.length>3||new Set(registration.keys).size!==registration.keys.length)fail();
 const before=object(options.before),observed=object(options.observed),prior=options.beforeBindings,next=options.afterBindings;
 if(!Array.isArray(prior)||!Array.isArray(next))return fail();
 const names=new Set(registration.keys.map(key=>{if(!new RegExp('^'+worker+'-denial-[012]$').test(key))fail();return 'DENIAL_RANGE_'+key.at(-1);}));
 const sort=(values:unknown[])=>[...values].sort((a,b)=>String(object(a).name).localeCompare(String(object(b).name)));
 if(prior.some(b=>names.has(String(object(b).name)))||!isDeepStrictEqual(sort(next.filter(b=>!names.has(String(object(b).name)))),sort(prior)))fail();
 for(const list of [prior,next])if(list.some(b=>object(b).name==='SESSION_DENIAL_QUEUE_TOPOLOGY_V1'&&object(b).text!=='shared'))fail();
 const expected=structuredClone(before);
 for(const key of registration.keys){
  const name='porchday-'+key,binding={type:'queue',name:'DENIAL_RANGE_'+key.at(-1),queue_name:name};
  if(next.filter(b=>object(b).name===binding.name).length!==1||!next.some(b=>isDeepStrictEqual(b,binding)))fail();
  const original=object(before[key]),actual=object(observed[key]);
  const empty={queue_id:original.queue_id,queue_name:name,settings:{delivery_delay:0,delivery_paused:true,message_retention_period:345600},consumers:[],consumers_total_count:0,producers:[],producers_total_count:0};
  if(typeof original.queue_id!=='string'||!/^[a-f0-9]{32}$/.test(original.queue_id)||!isDeepStrictEqual(original,empty))fail();
  const registered={...empty,producers:[{type:'worker',script:'porchday-'+worker}],producers_total_count:1};
  if(!isDeepStrictEqual(actual,registered)&&(phase==='candidate'||!isDeepStrictEqual(actual,empty)))fail();
  expected[key]=structuredClone(actual);
 }
 // Include the complete map: exceptions cannot hide an added or changed queue.
 if(!isDeepStrictEqual(observed,expected))fail();
 return expected;
}
