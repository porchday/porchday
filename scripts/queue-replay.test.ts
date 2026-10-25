import {expect,test,vi} from 'vitest';
import {argumentsForReplay,decodeJob,replayOne} from './queue-replay';
const message=(value:unknown)=>({body:Buffer.from(JSON.stringify(value)).toString('base64'),lease_id:'private-lease',metadata:{'CF-Content-Type':'json'}});
test('accepts only current bounded job contracts and requires explicit bounded mutation arguments',()=>{
 for(const kind of ['expiry','media_backup_start'])expect(decodeJob(message({kind})).job).toEqual({kind});
 expect(decodeJob(message({kind:'media_backup',id:'00000000-0000-4000-8000-000000000001'})).job.kind).toBe('media_backup');
 for(const value of [{kind:'unknown'},{kind:'expiry',secret:'private'},{kind:'media_backup',id:'private'}])expect(()=>decodeJob(message(value))).toThrow('QUEUE_MESSAGE_INVALID');
 expect(()=>decodeJob({...message({kind:'expiry'}),metadata:{'CF-Content-Type':'v8'}})).toThrow();
 expect(()=>argumentsForReplay(['staging'])).toThrow();expect(()=>argumentsForReplay(['staging','--replay','--limit','11'])).toThrow();expect(argumentsForReplay(['staging','--replay','--limit','1'])).toEqual({environment:'staging',limit:1});
});
test('only acknowledges after accepted republish and retains message after uncertain send or invalid payload',async()=>{
 const call=vi.fn().mockResolvedValueOnce({messages:[message({kind:'expiry'})]}).mockRejectedValueOnce(Error('uncertain send'));
 await expect(replayOne(call,'source','destination')).rejects.toThrow();expect(call).toHaveBeenCalledTimes(2);expect(call.mock.calls.some(([path])=>path.endsWith('/ack'))).toBe(false);
 call.mockReset().mockResolvedValueOnce({messages:[message({kind:'unknown'})]});await expect(replayOne(call,'source','destination')).rejects.toThrow();expect(call).toHaveBeenCalledTimes(1);
 call.mockReset().mockResolvedValueOnce({messages:[message({kind:'expiry'})]}).mockResolvedValueOnce({}).mockResolvedValueOnce({ackCount:1,retryCount:0});
 expect(await replayOne(call,'source','destination')).toBe(true);expect(call.mock.calls.map(x=>x[0])).toEqual(['/queues/source/messages/pull','/queues/destination/messages','/queues/source/messages/ack']);
 expect(call.mock.calls[1][2]).toEqual({body:{kind:'expiry'},content_type:'json'});
});
test('empty or unconfirmed acknowledgement is not represented as successful cleanup',async()=>{
 const call=vi.fn().mockResolvedValueOnce({messages:[]});expect(await replayOne(call,'source','destination')).toBe(false);
 call.mockReset().mockResolvedValueOnce({messages:[message({kind:'expiry'})]}).mockResolvedValueOnce({}).mockResolvedValueOnce({ackCount:0,retryCount:0});await expect(replayOne(call,'source','destination')).rejects.toThrow('QUEUE_ACK_UNCONFIRMED');
});
