// Exact WebCrypto <-> CryptoKit wire compatibility, using ephemeral synthetic keys.
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
import {createVideoKey,encryptVideoSegment,decryptVideoSegment,VIDEO_CHUNK_BYTES} from '../packages/crypto/src/video.ts';
const directory=await mkdtemp(join(tmpdir(),'porchday-video-interop-'));
try{
 const key=createVideoKey(),streamId=crypto.randomUUID(),plain=crypto.getRandomValues(new Uint8Array(16384));const encrypted=await encryptVideoSegment(key,streamId,0,plain);
 const manifest={v:2,protocol:'porchday-video-aes256gcm-v2',streamId,key,mime:'video/mp4',size:plain.length,duration:1,width:640,height:480,chunkSize:VIDEO_CHUNK_BYTES,segments:[encrypted.segment]};
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));await writeFile(join(directory,'cipher.bin'),encrypted.bytes);await writeFile(join(directory,'plain.bin'),plain);
 await writeFile(join(directory,'main.swift'),`import Foundation
let dir=URL(fileURLWithPath:CommandLine.arguments[1])
let manifest=try SegmentedVideoCrypto.decode(Data(contentsOf:dir.appendingPathComponent("manifest.json")))
let plain=try Data(contentsOf:dir.appendingPathComponent("plain.bin"))
let decrypted=try SegmentedVideoCrypto.decrypt(Data(contentsOf:dir.appendingPathComponent("cipher.bin")),manifest:manifest,index:0)
precondition(decrypted==plain)
let (bytes,segment)=try SegmentedVideoCrypto.encrypt(plain,key:manifest.key,stream:manifest.streamId,index:0)
var result=manifest;result.segments=[segment]
try bytes.write(to:dir.appendingPathComponent("native.bin"))
try JSONEncoder().encode(result).write(to:dir.appendingPathComponent("native.json"))
`);
 execFileSync('swiftc',['-swift-version','6',resolve('apps/ios/Porchday/SegmentedVideoCrypto.swift'),join(directory,'main.swift'),'-o',join(directory,'check')],{stdio:'pipe'});execFileSync(join(directory,'check'),[directory],{stdio:'pipe'});
 const native=JSON.parse(await readFile(join(directory,'native.json'),'utf8'));assert.deepEqual(await decryptVideoSegment(native,0,new Uint8Array(await readFile(join(directory,'native.bin')))),plain);console.log('WebCrypto and CryptoKit video segment interoperability passed in both directions.');
}finally{await rm(directory,{recursive:true,force:true});}
