/** Synthetic record shapes from the existing journal schema; no member data. */
export async function syntheticJournalRecords(){
 const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
 const generation=id(1),started_at=new Date().toISOString();
 const pending=Array.from({length:255},(_,i)=>({id:id(i+1000),started_at}));
 const intent={id:id(2000),started_at};
 const events=Array.from({length:200},(_,i)=>({sequence:String(i+1),id:id(i+3000),occurred_at:started_at,decision:{action:'reaction',kind:'post_reactions',target:id(i+4000),member:id(i+5000),tag:'a'.repeat(128)}}));
 const batch=JSON.stringify({v:1,generation,from:'1',to:'200',previous:null,events});
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(batch))),b=>b.toString(16).padStart(2,'0')).join('');
 const head={key:`batches/${generation}/1-200-${hash}.json`,hash};
 const root={v:1,generation,mode:'active',sequence:'0',head:null,pending,reason:null};
 const registered={...root,pending:[...pending,intent]};
 const checkpointed={...registered,sequence:'200',head};
 const records={root:JSON.stringify(root),registered:JSON.stringify(registered),checkpointed:JSON.stringify(checkpointed),retired:JSON.stringify({...checkpointed,pending}),intent:JSON.stringify({v:1,...intent}),batch,receipt:JSON.stringify({v:1,id:intent.id,generation,sequence:'200',head})};
 return {records,bytes:Object.fromEntries(Object.entries(records).map(([key,value])=>[key,new TextEncoder().encode(value).length]))};
}
