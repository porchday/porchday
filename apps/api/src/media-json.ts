import {JSONParser,TokenType} from '@streamparser/json';

/** Adapter for exactly @streamparser/json 0.0.26's accumulator interface.
 * The upstream tokenizer/parser still handles every JSON grammar rule. Its
 * accumulator currently drops U+FEFF at decoder boundaries and retains one
 * cons-string node per unpaired surrogate. Bound those allocations here and
 * preserve every UTF-16 code unit; never change the global TextDecoder.
 * Revisit this adapter when upgrading the pinned dependency. */
class BoundedTokenString {
  private decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  private buffer=new Uint8Array(64*1024);
  private offset=0;
  private chunks:string[]=[];
  private pending:string[]=[];
  private pendingLength=0;
  byteLength=0;
  private appendText(text:string){
    if(!text.length)return;
    if(text.length>=8192){this.flushPending();this.chunks.push(text);return;}
    this.pending.push(text);this.pendingLength+=text.length;if(this.pendingLength>=8192)this.flushPending();
  }
  private flushPending(){if(this.pending.length){this.chunks.push(this.pending.join(''));this.pending=[];this.pendingLength=0;}}
  private flushBytes(){if(this.offset){this.appendText(this.decoder.decode(this.buffer.subarray(0,this.offset)));this.offset=0;}}
  appendChar(byte:number){if(this.offset===this.buffer.length)this.flushBytes();this.buffer[this.offset++]=byte;this.byteLength++;}
  appendBuf(bytes:Uint8Array,start=0,end=bytes.length){
    const size=end-start;if(this.offset+size>this.buffer.length)this.flushBytes();
    if(size>this.buffer.length)this.appendText(this.decoder.decode(bytes.subarray(start,end)));
    else{this.buffer.set(bytes.subarray(start,end),this.offset);this.offset+=size;}
    this.byteLength+=size;
  }
  appendCharCode(code:number){this.flushBytes();this.appendText(String.fromCharCode(code));}
  reset(){this.offset=0;this.chunks=[];this.pending=[];this.pendingLength=0;this.byteLength=0;}
  toString(){this.flushBytes();this.flushPending();const text=this.chunks.length===1?this.chunks[0]:this.chunks.join('');this.chunks=[text];return text;}
}
function mediaParser(){
  const parser=new JSONParser({paths:['$'],stringBufferSize:64*1024,numberBufferSize:64*1024});
  // Private upstream interface: the exact dependency version is pinned, the
  // shape is checked before use, and differential regressions cover upgrades.
  const tokenizer=(parser as unknown as {tokenizer?:{bufferedString?:BoundedTokenString;bufferedNumber?:BoundedTokenString}}).tokenizer;
  if(!tokenizer||typeof tokenizer.bufferedString?.appendCharCode!=='function'||typeof tokenizer.bufferedNumber?.appendBuf!=='function')throw Error('MEDIA_PARSER_INCOMPATIBLE');
  tokenizer.bufferedString=new BoundedTokenString();tokenizer.bufferedNumber=new BoundedTokenString();
  return parser;
}

/** Parse only bounded media envelopes. Depth/token limits exceed the valid
 * 4,000-recipient shape while preventing container amplification. */
export async function parseMediaJson(body:ReadableStream<Uint8Array>|null,maxBytes:number,fail:(code:string,status?:400|413)=>never):Promise<unknown> {
  if(!body)return fail('INVALID_MEDIA_ENVELOPE');
  const parser=mediaParser(),reader=body.getReader();
  let bytes=0,tokens=0,depth=0,values=0,result:unknown,leading=true;
  parser.onToken=({token})=>{
    if(++tokens>100_000)throw Error('JSON_TOKEN_LIMIT');
    if(token===TokenType.LEFT_BRACE||token===TokenType.LEFT_BRACKET){if(++depth>16)throw Error('JSON_DEPTH_LIMIT');}
    if(token===TokenType.RIGHT_BRACE||token===TokenType.RIGHT_BRACKET)depth--;
  };
  parser.onValue=({value})=>{result=value;values++;};
  try{
    while(true){const {done,value}=await reader.read();if(done)break;const before=bytes;bytes+=value.byteLength;if(bytes>maxBytes)return fail('PAYLOAD_TOO_LARGE',413);
      // Fetch JSON decoding permits one BOM at byte zero, never after spaces.
      // The upstream tokenizer otherwise also accepts the latter.
      for(let offset=0;leading&&offset<value.byteLength;offset++){
        const byte=value[offset];if(byte===32||byte===9||byte===10||byte===13)continue;
        if(byte===0xef&&before+offset!==0)throw Error('JSON_MISPLACED_BOM');leading=false;
      }
      for(let offset=0;offset<value.byteLength;offset+=64*1024)parser.write(value.subarray(offset,offset+64*1024));
    }
    if(!parser.isEnded)parser.end();
    if(values!==1||depth!==0)throw Error('JSON_INCOMPLETE');return result;
  }catch(error){await reader.cancel().catch(()=>{});if(bytes>maxBytes||(error instanceof Error&&error.message==='PAYLOAD_TOO_LARGE'))return fail('PAYLOAD_TOO_LARGE',413);return fail('INVALID_MEDIA_ENVELOPE');}
  finally{reader.releaseLock();}
}
