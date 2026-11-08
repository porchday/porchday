import React,{useEffect,useRef,useState} from 'react';
import {isNativeShell,nativeCall} from './native-shell';
import {Alert,Button} from './ui';
type Batch = {id:string;items:{id:string;name:string;type:string;size:number}[]};

/** Native handoffs stay local until the ordinary encrypted composer publishes them. */
export function SharedMediaInbox({disabled,remaining,onImport,onBusy}:{disabled:boolean;remaining:number;onBusy:(busy:boolean)=>void;onImport:(files:File[])=>Promise<boolean|undefined>}) {
 const [batches,setBatches]=useState<Batch[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState('');
 const retained=useRef<string[]>([]),live=useRef(true);
 async function refresh(){if(!isNativeShell())return;try{const found=await nativeCall('sharedMediaList');if(live.current&&Array.isArray(found))setBatches(found);}catch{/* Older shells and iOS have no shared inbox. */}}
 useEffect(()=>{live.current=true;void refresh();window.addEventListener('porchday:native-active',refresh);return()=>{live.current=false;window.removeEventListener('porchday:native-active',refresh);};},[]);
 // File snapshots can be read later by video preparation, so retain backing files until unmount.
 useEffect(()=>()=>{if(typeof navigator.storage?.getDirectory==="function")void navigator.storage.getDirectory().then(root=>Promise.all(retained.current.map(name=>root.removeEntry(name).catch(()=>{})))).catch(()=>{});},[]);
 async function importBatch(batch:Batch){
  setBusy(true);onBusy(true);setError('');
  try {
   if(batch.items.length>remaining)throw Error(`This selection has ${batch.items.length} items. Remove some draft attachments first (10 maximum).`);
   const root=await navigator.storage.getDirectory(),files:File[]=[];
   for(const item of batch.items){
    if(!Number.isSafeInteger(item.size)||item.size<1||item.size>1024**3)throw Error('This shared file is too large.');
    const name='porchday-shared-'+crypto.randomUUID();retained.current.push(name);
    const handle=await root.getFileHandle(name,{create:true}),writer=await handle.createWritable();
    try {
     for(let offset=0;offset<item.size;){
      if(!live.current)throw Error('Import cancelled.');
      setProgress(`Adding ${files.length+1} of ${batch.items.length}…`);
      const count=Math.min(262144,item.size-offset),encoded=await nativeCall('sharedMediaRead',{batch:batch.id,item:item.id,offset,count});
      if(typeof encoded!=='string')throw Error('Shared file data was unavailable.');
      const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
      if(bytes.length!==count)throw Error('This shared file was incomplete. Share it again from Photos.');
      await writer.write(bytes);offset+=bytes.length;
     }
     await writer.close();
    }catch(error){await writer.abort().catch(()=>{});throw error;}
    files.push(new File([await handle.getFile()],item.name,{type:item.type}));
   }
   if(await onImport(files)){await nativeCall('sharedMediaRemove',{batch:batch.id});await refresh();}
  }catch(error){if(live.current)setError((error as Error).message);}finally{if(live.current){setBusy(false);onBusy(false);setProgress('');}}
 }
 if(!batches.length)return null;
 return <section aria-label="Shared from Photos"><p>Shared from Photos. Add these to your draft, then choose who can see them.</p><Alert>{error}</Alert>{progress&&<p role="status">{progress}</p>}{batches.map(batch=><div key={batch.id}><Button type="button" disabled={disabled||busy} onClick={()=>void importBatch(batch)}>Add {batch.items.length} shared photos/videos</Button><Button type="button" disabled={disabled||busy} onClick={()=>{void nativeCall('sharedMediaRemove',{batch:batch.id}).then(refresh).catch(()=>setError('Could not remove these shared files.'));}}>Discard</Button></div>)}</section>;
}
