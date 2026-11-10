/** Memory only: cached pixels never authorize a read. Every new consumer checks
 * the existing authenticated bytes route with HEAD before reusing a blob. */
export type CachedPhoto = {blob:Blob;width:number;height:number;expiresAt:number|null};
type Entry = {value:CachedPhoto;until:number;cost:number;timer:ReturnType<typeof setTimeout>};
export class PhotoCache {
  private entries=new Map<string,Entry>();
  private pending=new Map<string,Promise<CachedPhoto>>();
  private generation=0;
  constructor(private budget=48*1024*1024,private ttl=120_000,private now=()=>Date.now()){}
  private remove(key:string){const entry=this.entries.get(key);if(entry)clearTimeout(entry.timer);this.entries.delete(key);}
  clear(){this.generation++;for(const key of this.entries.keys())this.remove(key);this.pending.clear();}
  async read(key:string,authorize:()=>Promise<void>,load:()=>Promise<CachedPhoto>){
    const existing=this.pending.get(key);if(existing)return existing;
    const generation=this.generation;
    const work=(async()=>{
      const old=this.entries.get(key);
      if(old&&old.until>this.now()){
        await authorize();
        if(generation!==this.generation)throw Error('Photo access changed.');
        if(old.until>this.now()){this.entries.delete(key);this.entries.set(key,old);return old.value;}
      }
      this.remove(key);
      if(generation!==this.generation)throw Error('Photo access changed.');
      const value=await load();
      if(generation!==this.generation)throw Error('Photo access changed.');
      const until=Math.min(this.now()+this.ttl,value.expiresAt??Infinity);
      if(!Number.isFinite(until)||until<=this.now())throw Error('This attachment expired.');
      const cost=value.blob.size+value.width*value.height*4+key.length*2+256;
      if(Number.isSafeInteger(cost)&&cost>0&&cost<=this.budget){
        const entry:Entry={value,until,cost,timer:setTimeout(()=>{if(this.entries.get(key)===entry)this.remove(key);},Math.max(0,until-this.now()))};
        // Node-only tests should not keep a process alive for a cache expiry.
        if(typeof entry.timer==='object'&&'unref' in entry.timer)entry.timer.unref();
        this.entries.set(key,entry);
        let used=0;for(const entry of this.entries.values())used+=entry.cost;
        while(used>this.budget||this.entries.size>96){const first=this.entries.keys().next().value!;used-=this.entries.get(first)!.cost;this.remove(first);}
      }
      return value;
    })().catch(error=>{if(generation===this.generation)this.remove(key);throw error;}).finally(()=>{if(this.pending.get(key)===work)this.pending.delete(key);});
    this.pending.set(key,work);return work;
  }
}
export const photoCache=new PhotoCache();
let epoch=0;
const listeners=new Set<()=>void>();
export function invalidatePhotos(){epoch++;photoCache.clear();for(const listener of listeners)listener();}
export function photoEpoch(){return epoch;}
export function subscribePhotos(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
// Only three byte/decrypt/decode jobs at once; choose visible work before nearby work.
type Job={run:()=>Promise<void>;priority:()=>number;signal:AbortSignal;cancel:()=>void};
const queue:Job[]=[];let running=0;
function pump(){
  queue.sort((a,b)=>b.priority()-a.priority());
  while(running<3&&queue.length){const job=queue.shift()!;if(job.signal.aborted){job.cancel();continue;}running++;void job.run().finally(()=>{running--;pump();});}
}
export function schedulePhoto<T>(work:()=>Promise<T>,priority:()=>number,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const cancel=()=>reject(new DOMException('Photo is no longer nearby','AbortError'));
    const job:Job={priority,signal,cancel,run:async()=>{try{resolve(await work());}catch(error){reject(error);}}};
    queue.push(job);
    signal.addEventListener('abort',()=>{const index=queue.indexOf(job);if(index>=0){queue.splice(index,1);cancel();}},{once:true});
    pump();
  });
}
