export class ProviderBodyTransportError extends Error{}
/** Enforce the byte bound during streaming, not after allocating the body. */
export async function readProviderJson(response:Response,limit=65536):Promise<unknown>{
 const reader=response.body?.getReader();if(!reader)throw Error('PROVIDER_BODY_EMPTY');const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){let item:ReadableStreamReadResult<Uint8Array>;try{item=await reader.read();}catch{throw new ProviderBodyTransportError();}const {done,value}=item;if(done)break;size+=value.byteLength;if(size>limit)throw Error('PROVIDER_BODY_TOO_LARGE');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
