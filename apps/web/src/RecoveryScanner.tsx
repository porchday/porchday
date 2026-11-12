import React,{useEffect,useRef,useState} from 'react';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import {Alert,Button,Field} from './ui';
export function RecoveryQR({value}:{value:string}){
 const [url,setUrl]=useState('');useEffect(()=>{let alive=true;void QRCode.toDataURL(value,{width:280,margin:2,errorCorrectionLevel:'M'}).then(v=>{if(alive)setUrl(v);});return()=>{alive=false;};},[value]);
 return <div data-diagnostic-private>{url&&<img src={url} width="280" height="280" alt="Scan this Porchday pairing code on your other device"/>}<details><summary>Copy pairing code instead</summary><code style={{overflowWrap:'anywhere'}}>{value}</code><Button type="button" variant="quiet" onClick={()=>navigator.clipboard.writeText(value)}>Copy code</Button></details></div>;
}
export function RecoveryScanner({onRead}:{onRead:(value:string)=>void}){
 const video=useRef<HTMLVideoElement>(null),stream=useRef<MediaStream|null>(null),frame=useRef<number>(0),alive=useRef(true),generation=useRef(0);
 const [active,setActive]=useState(false),[error,setError]=useState(''),[code,setCode]=useState(''),[starting,setStarting]=useState(false);
 function stop(){generation.current++;cancelAnimationFrame(frame.current);stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;if(video.current)video.current.srcObject=null;if(alive.current){setActive(false);setStarting(false);}}
 useEffect(()=>{alive.current=true;const hidden=()=>{if(document.hidden)stop();};document.addEventListener('visibilitychange',hidden);return()=>{alive.current=false;stop();document.removeEventListener('visibilitychange',hidden);};},[]);
 function scan(source:CanvasImageSource,width:number,height:number){const scale=Math.min(1,1600/Math.max(width,height)),canvas=document.createElement('canvas');canvas.width=Math.floor(width*scale);canvas.height=Math.floor(height*scale);const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx||!canvas.width||!canvas.height)return null;ctx.drawImage(source,0,0,canvas.width,canvas.height);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);return jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'})?.data;}
 async function start(){if(starting||stream.current)return;const attempt=++generation.current;setStarting(true);setError('');try{const camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});if(!alive.current||attempt!==generation.current||document.hidden){camera.getTracks().forEach(t=>t.stop());return;}stream.current=camera;setStarting(false);setActive(true);const element=video.current!;element.srcObject=camera;await element.play();if(attempt!==generation.current)return;let last=0;const tick=(now:number)=>{if(!stream.current)return;if(now-last>180&&element.readyState>=2){last=now;const value=scan(element,element.videoWidth,element.videoHeight);if(value){stop();onRead(value);return;}}frame.current=requestAnimationFrame(tick);};frame.current=requestAnimationFrame(tick);}catch{if(attempt!==generation.current||!alive.current)return;stop();setError('Camera access is unavailable. Choose a picture of the QR code or paste the pairing code.');}}
 async function photo(file:File){setError('');const url=URL.createObjectURL(file);try{const img=new Image();img.src=url;await img.decode();const value=scan(img,img.naturalWidth,img.naturalHeight);if(!value)throw Error();onRead(value);}catch{setError('No readable QR code found. Try a clearer picture or paste the code.');}finally{URL.revokeObjectURL(url);}}
 return <div className="form-stack" data-diagnostic-private>
  <video ref={video} muted playsInline hidden={!active} style={{maxWidth:'100%'}} aria-label="Pairing code camera"/>
  {active?<Button type="button" variant="outline" onClick={stop}>Stop camera</Button>:<Button type="button" variant="outline" disabled={starting} onClick={start}>{starting?'Opening camera…':'Scan QR code'}</Button>}
  <label>Or choose a QR code picture<input type="file" accept="image/*" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void photo(file);}}/></label>
  <Field label="Or paste pairing code" value={code} onChange={e=>setCode(e.target.value)} autoComplete="off"/>
  <Button type="button" variant="outline" disabled={!code.trim()} onClick={()=>onRead(code)}>Use pairing code</Button>
  <Alert>{error}</Alert>
 </div>;
}
