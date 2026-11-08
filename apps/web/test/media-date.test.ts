import {describe,it,expect} from 'vitest';
import {captureDay,photoCaptureDate} from '../src/media-date';

// A minimal JPEG APP1 EXIF block with an ExifIFD DateTimeOriginal value.
function photo(date:string){
 const text=new TextEncoder().encode(date+'\0'),tiff=new Uint8Array(44+text.length),v=new DataView(tiff.buffer);
 tiff.set([0x49,0x49,42,0,8,0,0,0]);v.setUint16(8,1,true);v.setUint16(10,0x8769,true);v.setUint16(12,4,true);v.setUint32(14,1,true);v.setUint32(18,26,true);
 v.setUint16(26,1,true);v.setUint16(28,0x9003,true);v.setUint16(30,2,true);v.setUint32(32,text.length,true);v.setUint32(36,44,true);tiff.set(text,44);
 const data=new Uint8Array(tiff.length+14);data.set([255,216,255,225,(tiff.length+8)>>8,(tiff.length+8)&255,69,120,105,102,0,0]);data.set(tiff,12);data.set([255,217],data.length-2);
 return data;
}
describe('original capture dates',()=>{
 it('keeps the recorded calendar day without timezone shifting',()=>{
  expect(captureDay('2020:01:02 00:05:00')).toBe('2020-01-02');
  expect(captureDay('2020-01-02T00:05:00+14:00')).toBe('2020-01-02');
 });
 it('rejects invalid dates instead of silently substituting today',()=>{
  for(const value of ['2023:02:29 12:00:00','0000:01:01 00:00:00','2020:13:01 00:00:00',undefined,''])expect(captureDay(value)).toBeUndefined();
  expect(captureDay('2024:02:29 12:00:00')).toBe('2024-02-29');
 });
 it('reads the actual EXIF creation value before normalization',async()=>{
  // exifr accepts a typed array in Node and a Blob in browsers.
  expect(await photoCaptureDate(photo('2017:06:13 23:15:00') as unknown as Blob)).toBe('2017-06-13');
 });
 it('leaves a missing date blank, never using the file modification date',async()=>{
  expect(await photoCaptureDate(new Uint8Array([1,2,3]) as unknown as Blob)).toBe('');
 });
});
