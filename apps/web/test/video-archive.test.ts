import {describe,it,expect} from 'vitest';
import {exportVideoSegments,validateArchivedVideo,validateArchivedSegment} from '../src/video-archive';
import {createVideoKey,encryptVideoSegment,VIDEO_CHUNK_BYTES,type VideoManifest} from '@porchday/crypto/video';
import {emptyArchive,packArchive,unpackArchive,validateSet} from '../src/archive';
describe('segmented video archives',()=>{
 it('exports authenticated bounded pieces in separate parts and rejects missing or modified data',async()=>{
  const owner=crypto.randomUUID(),id=crypto.randomUUID(),stream=crypto.randomUUID(),key=createVideoKey(),plain=[new Uint8Array(VIDEO_CHUNK_BYTES).fill(7),new Uint8Array(29).fill(9)];
  const encrypted=await Promise.all(plain.map((bytes,index)=>encryptVideoSegment(key,stream,index,bytes)));
  const manifest:VideoManifest={v:2,protocol:'porchday-video-aes256gcm-v2',streamId:stream,key,mime:'video/mp4',size:VIDEO_CHUNK_BYTES+29,width:640,height:480,duration:2,chunkSize:VIDEO_CHUNK_BYTES,segments:encrypted.map(e=>e.segment)};
  const files:Record<string,Uint8Array>={},records:any[]=[];
  const result=await exportVideoSegments(id,manifest,async index=>encrypted[index].bytes,async(record,bytes)=>{records.push(record);files[record.path]=bytes;});
  const media={...result,id,path:`photos/${id}.mp4`,mime:'video/mp4',expires_at:null};
  expect(()=>validateArchivedVideo(media)).not.toThrow();expect(files[records[1].path]).toEqual(plain[1]);
  const set=crypto.randomUUID(),a=emptyArchive(owner,'synthetic',{id:set,index:1,total:null}),b=emptyArchive(owner,'synthetic',{id:set,index:2,total:2,complete:true});a.version=2;b.version=2;a.video_segments=records;b.media=[media];
  const first=unpackArchive(packArchive(a,files)),last=unpackArchive(packArchive(b));expect(()=>validateSet([first.archive,last.archive])).not.toThrow();expect(()=>validateSet([last.archive])).toThrow();
  const corrupt=files[records[0].path].slice();corrupt[0]^=1;expect(()=>validateArchivedSegment(records[0],{[records[0].path]:corrupt})).toThrow();
  expect(()=>validateArchivedVideo({...media,segments:[...records].reverse()})).toThrow();expect(()=>validateArchivedVideo({...media,size:300*1024*1024})).toThrow();
 });
});
