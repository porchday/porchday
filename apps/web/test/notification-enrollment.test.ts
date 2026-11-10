import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('@porchday/crypto',()=>({signStatement:vi.fn(async(statement:unknown)=>({statement,signature:'test'})),verifyStatement:vi.fn()}));
vi.mock('../src/api',()=>({post:vi.fn(async()=>({ok:true})),del:vi.fn(),request:vi.fn()}));
vi.mock('../src/native-shell',()=>({isNativeShell:()=>false,nativeCall:vi.fn()}));
vi.mock('../src/notification-preview-store',()=>({clearPreviewKeys:vi.fn(),previewGeneration:vi.fn(()=>1),savePreviewKey:vi.fn(),storedPreviewKeys:vi.fn(async()=>[{identity:{memberId:'member',deviceId:'device',keyId:'key'},privateKey:'private'}])}));
import {post} from '../src/api';
import {previewGeneration} from '../src/notification-preview-store';
import {enrollContentPreviews,type PreviewEnrollmentReceipt} from '../src/notification-previews';
const vault={member:{id:'member'},device:{id:'device'},privateKey:'key'} as unknown as Parameters<typeof enrollContentPreviews>[0];
let values:Map<string,string>;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100000);vi.clearAllMocks();values=new Map([['porchday-push-subscription',JSON.stringify({memberId:'member',id:'subscription'})]]);vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)||null,get length(){return values.size;},key:(i:number)=>[...values.keys()][i]});vi.mocked(post).mockResolvedValue({ok:true});vi.mocked(previewGeneration).mockReturnValue(1);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('notification enrollment receipts',()=>{
 it('suppresses minute repeats but repairs at the bounded deadline',async()=>{const receipt:PreviewEnrollmentReceipt={};for(let i=0;i<15;i++){await enrollContentPreviews(vault,()=>true,receipt);vi.advanceTimersByTime(60000);}expect(post).toHaveBeenCalledTimes(1);await enrollContentPreviews(vault,()=>true,receipt);expect(post).toHaveBeenCalledTimes(2);});
 it('does not remember failed requests or inactive late completions',async()=>{const receipt:PreviewEnrollmentReceipt={};vi.mocked(post).mockRejectedValueOnce(Error('offline'));await expect(enrollContentPreviews(vault,()=>true,receipt)).rejects.toThrow('offline');expect(receipt.key).toBeUndefined();let active=true;vi.mocked(post).mockImplementationOnce(async()=>{active=false;return{ok:true};});await enrollContentPreviews(vault,()=>active,receipt);expect(receipt.key).toBeUndefined();await enrollContentPreviews(vault,()=>true,receipt);expect(post).toHaveBeenCalledTimes(3);});
 it('registers immediately after subscription, generation, preference or session changes',async()=>{const receipt:PreviewEnrollmentReceipt={};await enrollContentPreviews(vault,()=>true,receipt);values.set('porchday-push-subscription',JSON.stringify({memberId:'member',id:'replacement'}));await enrollContentPreviews(vault,()=>true,receipt);vi.mocked(previewGeneration).mockReturnValue(2);await enrollContentPreviews(vault,()=>true,receipt);values.set('porchday-notification-content:member','off');await enrollContentPreviews(vault,()=>true,receipt);expect(receipt.key).toBeUndefined();values.delete('porchday-notification-content:member');await enrollContentPreviews(vault,()=>true,receipt);await enrollContentPreviews(vault,()=>true,{});expect(post).toHaveBeenCalledTimes(5);});
});
