import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {captureArchiveMedia,captureArchiveImport,type ArchiveBoundary} from './hosted-browser-archive-support.js';

function fixture(){
 const member=randomUUID(),device=randomUUID(),source=randomUUID(),post=randomUUID(),media=randomUUID(),job=randomUUID(),createdAt=new Date().toISOString();
 const b:ArchiveBoundary={member,device,originalIds:new Set([source,member]),sources:new Map([[`${member}:post:${source}`,{id:source,journal_kind:'post',created_at:createdAt,expires_at:null}]]),media:new Map(),posts:new Set()};
 const e=(kind:'post'|'media',id:string,parentId:string|null)=>({v:1,protocol:'porchday-openpgp-v1',context:{id,kind,authorId:member,authorDeviceId:device,audience:'only_me',groupId:null,parentId,revision:1,epoch:1,createdAt,expiresAt:null},recipients:[{memberId:member,deviceId:device,fingerprint:'synthetic'}],ciphertext:'private ciphertext never in receipt'});
 const m={id:media,envelope:e('media',media,post),byte_size:512};
 const p={id:job,posts:[{envelope:e('post',post,null),source_id:`${member}:post:${source}`,media_ids:[media]}]};
 return {b,m,p,member,source,post,media};
}
describe('Hosted browser archive write boundaries',()=>{
 it('requires the exact explicit invocation before fixture or browser access',()=>{
  for(const args of [[],['--run'],['--run','--attempt=12345678','--account=B']]){
   const r=spawnSync(process.execPath,['--import','tsx','scripts/hosted-browser-archive.ts',...args],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
   expect(r.status).toBe(1);expect(r.stdout).toBe('');expect(r.stderr).not.toMatch(/password|recoverySecret|at /);
   expect(r.stderr).toContain('HOSTED_BROWSER_ARCHIVE_FAILED');
  }
 });
 it('captures only new private own-member IDs and metadata without ciphertext',()=>{
  const {b,m,p,post,media}=fixture(),captured=captureArchiveMedia(m,b);b.media.set(media,captured);
  const result=captureArchiveImport(p,b);expect(result.posts[0].id).toBe(post);expect(result.posts[0].mediaIds).toEqual([media]);
  expect(JSON.stringify(result)).not.toMatch(/ciphertext|private ciphertext/);
  b.posts.add(post);expect(()=>captureArchiveImport(p,b)).toThrow('ARCHIVE_IMPORT_SOURCE_MISMATCH');
 });
 it('refuses profile replacement, other recipients/authors, original IDs, unknown photos and changed deadlines',()=>{
  const {b,m,p,source,media}=fixture();b.media.set(media,captureArchiveMedia(m,b));
  expect(()=>captureArchiveImport({...p,profile:{}},b)).toThrow('ARCHIVE_IMPORT_BOUNDARY');
  const mutate=(change:(value:any)=>void)=>{const copy=structuredClone(p);change(copy);return()=>captureArchiveImport(copy,b);};
  expect(mutate(x=>x.posts[0].envelope.context.id=source)).toThrow('ARCHIVE_PRIVATE_WRITE_REQUIRED');
  expect(mutate(x=>x.posts[0].envelope.context.audience='connections')).toThrow('ARCHIVE_PRIVATE_WRITE_REQUIRED');
  expect(mutate(x=>x.posts[0].envelope.context.authorId=randomUUID())).toThrow('ARCHIVE_PRIVATE_WRITE_REQUIRED');
  expect(mutate(x=>x.posts[0].envelope.recipients[0].memberId=randomUUID())).toThrow('ARCHIVE_PRIVATE_WRITE_REQUIRED');
  expect(mutate(x=>x.posts[0].media_ids=[randomUUID()])).toThrow('ARCHIVE_IMPORT_SOURCE_MISMATCH');
  expect(mutate(x=>x.posts[0].envelope.context.expiresAt=new Date(Date.now()+10000).toISOString())).toThrow('ARCHIVE_IMPORT_SOURCE_MISMATCH');
  expect(()=>captureArchiveMedia({...m,id:source},b)).toThrow('ARCHIVE_MEDIA_BOUNDARY');
 });
});
