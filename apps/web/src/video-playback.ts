import {validateVideoManifest,type VideoManifest} from '@porchday/crypto/video';
export async function registerVideoPlayback(mediaId:string,manifest:VideoManifest,expiresAt:string|null,signal:AbortSignal){
 validateVideoManifest(manifest);signal.throwIfAborted();
 if(!navigator.serviceWorker)throw Error('Video streaming is unavailable in this browser. Try the native app.');
 const controller=navigator.serviceWorker.controller;if(!controller)throw Error('Reload Porchday to finish enabling video playback.');
 const token=crypto.randomUUID();const close=()=>controller.postMessage({type:'VIDEO_CLOSE',token});
 await new Promise<void>((resolve,reject)=>{const channel=new MessageChannel(),timer=setTimeout(()=>finish(Error('Reload Porchday to get the video player update.')),5000);function finish(error?:Error){clearTimeout(timer);channel.port1.close();signal.removeEventListener('abort',abort);if(error){close();reject(error);}else resolve();}const abort=()=>finish(Error('Video closed'));channel.port1.onmessage=event=>finish(event.data?.ok?undefined:Error('This video is unavailable or has expired.'));signal.addEventListener('abort',abort,{once:true});controller.postMessage({type:'VIDEO_REGISTER',token,mediaId,manifest,expiresAt},[channel.port2]);});
 if(signal.aborted){close();signal.throwIfAborted();}signal.addEventListener('abort',close,{once:true});
 return{url:`/__porchday_video/${token}.mp4`,close(){signal.removeEventListener('abort',close);close();}};
}
