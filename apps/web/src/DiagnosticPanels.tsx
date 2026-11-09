import React,{useEffect,useState} from 'react';
import {get,type Json} from './api';
import {Button,Alert,useAction} from './ui';
import {diagnosticStatus,startDiagnostics,stopDiagnostics,deleteDiagnosticRecordings,flushDiagnostics} from './diagnostics';
function useRecording(){const [recording,set]=useState(diagnosticStatus());useEffect(()=>{const update=()=>set(diagnosticStatus());window.addEventListener('porchday:diagnostics',update);update();return()=>window.removeEventListener('porchday:diagnostics',update);},[]);return recording;}
export function DiagnosticsIndicator(){const recording=useRecording();if(!recording)return null;return <aside className="panel" role="status" data-diagnostic-private><span>Diagnostics recording · {recording.mode==='content'?'includes content':'details only'}</span>{' '}<button type="button" onClick={()=>void stopDiagnostics()}>Stop recording</button></aside>;}
export function DiagnosticsSettings(){
 const recording=useRecording(),action=useAction();const [include,setInclude]=useState(false),[sessions,setSessions]=useState<Json[]>([]);
 async function load(){setSessions((await get('/diagnostics/sessions')).items);}
 return <section className="panel form-stack" data-diagnostic-private><h2>Detailed diagnostics</h2>
  <p>Record this device’s actions, request timings, failures and retries for Porchday’s authorized builders to investigate. Recording stops after 24 hours. Recordings are deleted after three days. Other devices and accounts are not enabled.</p>
  <label className="check-field"><input type="checkbox" checked={recording?recording.mode==='content':include} disabled={!!recording} onChange={e=>setInclude(e.target.checked)}/><span>Also include on-screen content and draft input</span></label>
  <p className="small-copy">Content mode sends visible text, marked post drafts/captions and small photo thumbnails from Feed, Share, Albums and My wall to Porchday. This may include other people’s content you can see. These diagnostic copies are readable by authorized builders, outside the usual end-to-end encryption. Passwords, recovery screens, keys and tokens are excluded. This is a bounded timeline, not a video recording of your screen.</p>
  <p className="small-copy">Recordings have event and size limits and may stop early when full. Uploads retry when this app is open and online. Your device retains a bounded offline queue. Stopping clears unsent events; deleting removes your recordings from all devices on the server. Previously exported operator evidence cannot be recalled.</p>
  <div className="button-row">{recording?<Button onClick={()=>action.run(stopDiagnostics)}>Stop recording</Button>:<Button busy={action.busy} onClick={()=>action.run(()=>startDiagnostics(include?'content':'details',include))}>{include?'Start recording with content':'Start detailed diagnostics'}</Button>}
   <Button variant="outline" onClick={()=>action.run(async()=>{await flushDiagnostics();await load();})}>View recordings</Button>
   <Button variant="quiet" onClick={()=>action.run(async()=>{await deleteDiagnosticRecordings();setSessions([]);},'Your diagnostic recordings were deleted.')}>Delete my diagnostic recordings</Button></div>
  {recording&&<p>Recording until {new Date(recording.expires_at).toLocaleString()}. Recording ID: <code>{recording.id}</code></p>}
  {sessions.map(s=><p key={s.id}><a href={`/diagnostics?recording=${s.id}`}>{new Date(s.started_at).toLocaleString()} · {s.mode}</a> · <code>{s.id}</code></p>)}
  <Alert>{action.error}</Alert><Alert success>{action.notice}</Alert>
 </section>;
}
export default function DiagnosticInspector(){
 const [id,setId]=useState(new URLSearchParams(location.search).get('recording')||''),[staff,setStaff]=useState(false),[data,setData]=useState<Json|null>(null);const action=useAction();
 async function load(){if(!/^[0-9a-f-]{36}$/.test(id))throw Error('Enter a recording ID.');if(!staff){setData(await get(`/diagnostics/sessions/${id}`));return;}const r=await fetch(`/api/staff/diagnostics/${id}`,{credentials:'same-origin',redirect:'error'});if(!r.ok)throw Error('Operator access requires an active builder staff role and Cloudflare Access sign-in.');setData(await r.json());}
 return <section className="panel form-stack" data-diagnostic-private><h1>Diagnostic timeline</h1><label>Recording ID<input value={id} onChange={e=>setId(e.target.value)}/></label><label className="check-field"><input type="checkbox" checked={staff} onChange={e=>{setStaff(e.target.checked);setData(null);}}/>Open as authorized operator (access is audited)</label><Button busy={action.busy} onClick={()=>action.run(load)}>Load recording</Button><Alert>{action.error}</Alert>
 {data&&<><p>Mode: {data.session.mode} · Release: {data.session.release||'unknown'}</p>{data.events.map((e:Json)=>{let payload:Json={};try{payload=JSON.parse(e.payload);}catch{}return <article className="panel" key={e.id}><strong>{new Date(e.at).toLocaleTimeString()} · {e.kind}</strong>{typeof payload.thumbnail==='string'&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(payload.thumbnail)?<img src={payload.thumbnail} alt="Consented diagnostic thumbnail"/>:<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(payload,null,2)}</pre>}</article>;})}</>}
 </section>;
}
