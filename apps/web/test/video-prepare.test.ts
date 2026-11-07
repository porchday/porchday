import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {inspectVideo,validatePreparedVideo} from '../src/video-prepare';
const fixture=(name:string)=>new File([readFileSync(new URL('./fixtures/'+name,import.meta.url))],name);
describe('alternate iPhone audio source tracks',()=>{
 it('accepts the compatibility AAC track after an unsupported spatial track',async()=>{
  const info=await inspectVideo(fixture('synthetic-alternate-audio.mov'));
  expect(info.audio).toBe(true);expect(info.alternateAudioTracks).toBe(1);
  expect(info.width).toBe(160);expect(info.height).toBe(120);
 });
 it('keeps prepared output validation strict',async()=>{
  await expect(validatePreparedVideo(fixture('synthetic-alternate-audio.mov'))).rejects.toThrow('only one audio track');
  await expect(validatePreparedVideo(fixture('synthetic-video.mp4'))).resolves.toMatchObject({audio:true,width:160,height:120});
 });
 it('does not silently drop sound when every source audio track is unsupported',async()=>{
  const bytes=readFileSync(new URL('./fixtures/synthetic-alternate-audio.mov',import.meta.url));
  const unknown=Buffer.from(bytes.toString('latin1').replaceAll('mp4a','apac').replaceAll('esds','free'),'latin1');
  await expect(inspectVideo(new File([unknown],'unsupported.mov'))).rejects.toThrow('without losing picture or sound');
 });
});
