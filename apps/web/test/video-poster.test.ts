import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const fake=vi.hoisted(()=>({frame:vi.fn(),dispose:vi.fn()}));
vi.mock('mediabunny',()=>({ALL_FORMATS:[],BlobSource:class{},Input:class{getPrimaryVideoTrack=async()=>({getFirstTimestamp:async()=>0,getDisplayWidth:async()=>1920,getDisplayHeight:async()=>1080});dispose=fake.dispose},CanvasSink:class{getCanvas=fake.frame}}));
import {videoPoster} from '../src/video-poster';
beforeEach(()=>{vi.useFakeTimers();fake.frame.mockReset();fake.dispose.mockReset();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('optional video thumbnail',()=>{
 it('does not wait indefinitely for a decoder and disposes its input',async()=>{
  fake.frame.mockImplementation(()=>new Promise(()=>{}));const result=videoPoster(new File(['x'],'video.mp4'),new AbortController().signal);
  await vi.advanceTimersByTimeAsync(3000);expect(await result).toBe('');expect(fake.dispose).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it('does not turn thumbnail codec failure into upload failure',async()=>{
  fake.frame.mockRejectedValue(new Error('decoder unavailable'));
  expect(await videoPoster(new File(['x'],'video.mp4'),new AbortController().signal)).toBe('');expect(fake.dispose).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it('still honors cancellation while a thumbnail is stalled',async()=>{
  fake.frame.mockImplementation(()=>new Promise(()=>{}));const controller=new AbortController();const result=videoPoster(new File(['x'],'video.mp4'),controller.signal);
  const rejected=expect(result).rejects.toMatchObject({name:'AbortError'});await vi.advanceTimersByTimeAsync(0);controller.abort();await rejected;expect(fake.dispose).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it('extracts a frame without creating a hidden video element',async()=>{
  fake.frame.mockResolvedValue({canvas:{width:320,height:180}});const draw=vi.fn();const create=vi.fn(()=>({width:0,height:0,getContext:()=>({drawImage:draw}),toDataURL:()=> 'data:image/jpeg;base64,thumbnail'}));vi.stubGlobal('document',{createElement:create});
  expect(await videoPoster(new File(['x'],'video.mp4'),new AbortController().signal)).toBe('thumbnail');expect(create).toHaveBeenCalledExactlyOnceWith('canvas');expect(draw).toHaveBeenCalledTimes(1);expect(fake.dispose).toHaveBeenCalledTimes(1);
 });
});
