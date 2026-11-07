import type {Conversion,Input,Output} from 'mediabunny';
import {VIDEO_MAX_BYTES,VIDEO_MAX_SECONDS,VIDEO_SOURCE_MAX_BYTES} from '@porchday/crypto/video';
export interface VideoInspection {duration:number;width:number;height:number;audio:boolean;alternateAudioTracks?:number}
export interface VideoPreparationOptions {resolution:720|1080;start:number;end:number;signal:AbortSignal;progress?:(fraction:number)=>void}
export interface PreparedLargeVideo {blob:File;mime:'video/mp4';width:number;height:number;duration:number;poster:string;preview:string;dispose:()=>Promise<void>}
const storageError='This browser cannot prepare a private video here. Try an updated browser with local file storage.';
const codecError='This browser cannot prepare this video format without losing picture or sound. Try an updated browser, or export an H.264/AAC MP4 first.';
async function open(file:File){const{Input,ALL_FORMATS,BlobSource}=await import('mediabunny');if(file.size<1||file.size>VIDEO_SOURCE_MAX_BYTES)throw Error('Choose a video source up to 1 GiB. Trim or export a smaller copy first.');return new Input({formats:ALL_FORMATS,source:new BlobSource(file)});}
// iPhone Spatial Audio movies contain a compatibility AAC track alongside
// spatial audio. Prefer that track even when the unsupported spatial track is default.
async function sourceAudio(input:Input){
 return await input.getPrimaryAudioTrack({filter:async track=>await track.getCodec()==='aac'})
  ?? await input.getPrimaryAudioTrack({filter:async track=>await track.getCodec()!==null});
}
async function inspect(input:Input,prepared=false):Promise<VideoInspection>{
 const videos=await input.getVideoTracks(),audio=await input.getAudioTracks();
 if(videos.length!==1)throw Error('Choose a video with one picture track. Export a standard 2D video first.');
 if(prepared&&audio.length>1)throw Error('The prepared video must contain only one audio track.');
 if(audio.length&&!await sourceAudio(input))throw Error(codecError);
 const track=videos[0],duration=await input.computeDuration(),width=await track.getDisplayWidth(),height=await track.getDisplayHeight();
 if(!Number.isFinite(duration)||duration<=0||!width||!height||Math.max(width,height)>7680||width*height>7680*4320)throw Error('This video has unsupported dimensions or duration.');
 if(await track.hasHighDynamicRange())throw Error('This HDR video needs an SDR export before sharing. Export an H.264 SDR copy so its colors stay correct.');
 return{duration,width,height,audio:audio.length>0,...(audio.length>1?{alternateAudioTracks:audio.length-1}:{})};
}
export async function inspectVideo(file:File){const input=await open(file);try{return await inspect(input);}finally{input.dispose();}}
export function preparedVideoSize(width:number,height:number,resolution:720|1080){const scale=Math.min(1,(resolution===1080?1920:1280)/Math.max(width,height),resolution/Math.min(width,height));return{width:Math.max(2,Math.floor(width*scale/2)*2),height:Math.max(2,Math.floor(height*scale/2)*2)};}
export async function prepareLargeVideo(file:File,options:VideoPreparationOptions):Promise<PreparedLargeVideo>{
 const{ALL_FORMATS,BlobSource,Conversion,Input,Mp4OutputFormat,Output,Quality,StreamTarget}=await import('mediabunny');
 const input=await open(file);let directory:FileSystemDirectoryHandle|undefined,output:Output|undefined,conversion:Conversion|undefined,writable:FileSystemWritableFileStream|undefined;
 const draftId=crypto.randomUUID();let preview='';
 const cancel=()=>{void conversion?.cancel().catch(()=>{});};options.signal.addEventListener('abort',cancel,{once:true});
 try{
  options.signal.throwIfAborted();const info=await inspect(input),{start,end,resolution}=options;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>info.duration+0.001||end<=start||end-start>VIDEO_MAX_SECONDS)throw Error('Choose a section up to 10 minutes, within this video.');
  if(!navigator.storage?.getDirectory)throw Error(storageError);
  const root=await navigator.storage.getDirectory();directory=await root.getDirectoryHandle('porchday-video-preparation',{create:true});
  const handle=await directory.getFileHandle(draftId,{create:true});if(!handle.createWritable)throw Error(storageError);writable=await handle.createWritable();
  const dimensions=preparedVideoSize(info.width,info.height,resolution);
  const track=await input.getPrimaryVideoTrack(),audioTrack=await sourceAudio(input);
  const copyable=start===0&&Math.abs(end-info.duration)<0.001&&file.size<=VIDEO_MAX_BYTES&&dimensions.width===info.width&&dimensions.height===info.height&&await track?.getCodec()==='avc'&&(!audioTrack||await audioTrack.getCodec()==='aac');
  const target=new StreamTarget(new WritableStream({async write(chunk){options.signal.throwIfAborted();if(chunk.position+chunk.data.length>VIDEO_MAX_BYTES)throw Error('The prepared video is larger than 250 MiB. Choose 720p or a shorter section.');await writable!.write({type:'write',position:chunk.position,data:chunk.data});}}),{chunked:true,chunkSize:1024*1024});
  output=new Output({target,format:new Mp4OutputFormat({fastStart:'reserve'})});
  // Retain audio rather than silently dropping a track when AAC encoding is
  // unavailable. An explicit error offers an existing compatible MP4.
  conversion=await Conversion.init({input,output,tracks:'all',trim:{start,end},tags:{},showWarnings:false,
   video:{...dimensions,fit:'contain',codec:'avc',...(copyable?{}:{quality:new Quality({bitrate:resolution===1080?3_000_000:1_800_000}),frameRate:30,keyFrameInterval:2}),allowTransformationMetadata:false},
   audio:selected=>selected===audioTrack?{codec:'aac',...(copyable?{}:{quality:new Quality({bitrate:128_000})})}:{discard:true}});
  if(!conversion.isValid||conversion.discardedTracks.some(({track:discarded,reason})=>reason!=='discarded_by_user'||discarded.type!=='audio'||discarded===audioTrack)||conversion.utilizedTracks.length!==1+Number(info.audio))throw Error(codecError,{cause:conversion.discardedTracks.map(t=>({type:t.track.type,reason:t.reason}))});
  conversion.onProgress=fraction=>options.progress?.(fraction);options.signal.throwIfAborted();await conversion.execute();await writable.close();writable=undefined;
  const blob=await handle.getFile();if(!blob.size||blob.size>VIDEO_MAX_BYTES)throw Error('Choose a shorter video or 720p.');
  const verified=new Input({source:new BlobSource(blob),formats:ALL_FORMATS});
  try{const result=await inspect(verified,true),video=await verified.getPrimaryVideoTrack(),audio=await verified.getPrimaryAudioTrack();if(await video?.getCodec()!=='avc'||info.audio&&await audio?.getCodec()!=='aac'||result.audio!==info.audio||result.duration>600.1)throw Error(codecError);}finally{verified.dispose();}
  preview=URL.createObjectURL(blob);const poster=await videoPoster(preview,options.signal);options.signal.throwIfAborted();
  const ownedDirectory=directory,ownedPreview=preview;let disposed=false;
  return{blob,mime:'video/mp4',...dimensions,duration:end-start,poster,preview,async dispose(){if(disposed)return;disposed=true;URL.revokeObjectURL(ownedPreview);await ownedDirectory.removeEntry(draftId).catch(()=>{});}};
 }catch(error){URL.revokeObjectURL(preview);await conversion?.cancel().catch(()=>{});await writable?.abort().catch(()=>{});await directory?.removeEntry(draftId).catch(()=>{});if(error instanceof DOMException&&error.name!=='AbortError')throw Error(storageError,{cause:error.name});throw error;}
 finally{options.signal.removeEventListener('abort',cancel);input.dispose();}
}
async function videoPoster(url:string,signal:AbortSignal){
 const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';
 try{await new Promise<void>((resolve,reject)=>{let timer:ReturnType<typeof setTimeout>;const finish=(error?:unknown)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);video.onloadeddata=null;video.onerror=null;error?reject(error):resolve();};const abort=()=>finish(signal.reason??Error('Video preparation canceled'));timer=setTimeout(()=>finish(Error('Video preview timed out.')),15000);video.onloadeddata=()=>finish();video.onerror=()=>finish(Error(codecError));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)return abort();video.src=url;});
  const canvas=document.createElement('canvas'),scale=Math.min(1,320/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));const context=canvas.getContext('2d');if(!context)throw Error('Video preview is unavailable.');context.drawImage(video,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',0.7).split(',')[1];
 }finally{video.removeAttribute('src');video.load();}
}

export async function validatePreparedVideo(file:File){const input=await open(file);try{const info=await inspect(input,true),video=await input.getPrimaryVideoTrack(),audio=await input.getPrimaryAudioTrack();if(file.size>VIDEO_MAX_BYTES||info.duration>600.1||Math.max(info.width,info.height)>1920||Math.min(info.width,info.height)>1080||await video?.getCodec()!=="avc"||audio&&await audio.getCodec()!=="aac")throw Error(codecError);return info;}finally{input.dispose();}}

/** Old unencrypted preparation files are temporary, never a durable draft. */
export async function cleanAbandonedVideoPreparation(){
 if(typeof navigator.storage?.getDirectory!=="function")return;
 const root=await navigator.storage.getDirectory();let directory:FileSystemDirectoryHandle;try{directory=await root.getDirectoryHandle("porchday-video-preparation");}catch{return;}
 for await(const[name,entry]of (directory as any).entries())if(entry.kind==="file"){const file=await entry.getFile();if(file.lastModified<Date.now()-24*60*60*1000)await directory.removeEntry(name).catch(()=>{});}
}
