import {MessageChannel} from 'node:worker_threads';
import {expect,test,vi} from 'vitest';
import {createCommitDrillClient,serveCommitDrillJournal,type DrillChannel} from './commit-drill-ipc';

function pair(){
 const {port1,port2}=new MessageChannel();
 const adapter=(port:typeof port1):DrillChannel=>({send:message=>port.postMessage(message),subscribe:receive=>{port.on('message',receive);return()=>{port.off('message',receive);};}});
 return{parent:adapter(port1),child:adapter(port2),close(){port1.close();port2.close();}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));

test('journal round trip serializes values without exposing parent capability',async()=>{
 const p=pair(),put=vi.fn(async()=>({etag:'next'})),failed=vi.fn();
 const server=serveCommitDrillJournal(p.parent,{get:async()=>({etag:'before',text:async()=>'synthetic'}),put},failed),client=createCommitDrillClient(p.child);
 try{const result=await client.store.get('control.json');expect(await result!.text()).toBe('synthetic');expect(result!.etag).toBe('before');
  expect(await client.store.put('owned','value',{onlyIf:{etagDoesNotMatch:'*'}})).toEqual({etag:'next'});expect(put).toHaveBeenCalledExactlyOnceWith('owned','value',{onlyIf:{etagDoesNotMatch:'*'}});expect(failed).not.toHaveBeenCalled();
 }finally{client.close();server.close();p.close();}
});

test.each([
 {type:'journal',id:2,method:'get',key:'control.json'},
 {type:'journal',id:1,method:'get',key:'control.json',value:'unexpected'},
 {type:'journal',id:1,method:'put',key:'control.json'},
 {type:'journal',id:1,method:'get',key:'control.json',secret:'unexpected'},
 {type:'journal',id:1,method:'put',key:'control.json',value:'x'.repeat(70001)},
])('invalid packet is refused before store I/O',async message=>{
 const p=pair(),get=vi.fn(),put=vi.fn(),failed=vi.fn(),server=serveCommitDrillJournal(p.parent,{get,put},failed);
 try{p.child.send(message);await tick();expect(failed).toHaveBeenCalledTimes(1);expect(get).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();p.child.send({type:'journal',id:1,method:'get',key:'control.json'});await tick();expect(get).not.toHaveBeenCalled();}
 finally{server.close();p.close();}
});

test('private store errors produce only a fixed failed reply and close the client',async()=>{
 const p=pair(),replies:unknown[]=[],off=p.child.subscribe(m=>replies.push(m)),get=vi.fn(async()=>{throw Error('private bearer and URL');});
 const server=serveCommitDrillJournal(p.parent,{get,put:vi.fn()},()=>{}),client=createCommitDrillClient(p.child);
 try{await expect(client.store.get('control.json')).rejects.toThrow('DRILL_IPC_RECONCILIATION_REQUIRED');await expect(client.store.get('control.json')).rejects.toThrow('DRILL_IPC_CLOSED');expect(get).toHaveBeenCalledTimes(1);expect(replies).toEqual([{type:'journal-result',id:1,ok:false}]);}
 finally{off();client.close();server.close();p.close();}
});

test('lost response times out without retry and a late response cannot reopen the client',async()=>{
 const sent:unknown[]=[],handlers=new Set<(value:unknown)=>void>();const client=createCommitDrillClient({send:m=>{sent.push(m);},subscribe:f=>{handlers.add(f);return()=>{handlers.delete(f);};}},100);
 await expect(client.store.get('control.json')).rejects.toThrow('RECONCILIATION_REQUIRED');expect(sent).toHaveLength(1);expect(handlers.size).toBe(0);
 for(const f of handlers)f({type:'journal-result',id:1,ok:true,value:null});await expect(client.store.get('control.json')).rejects.toThrow('CLOSED');expect(sent).toHaveLength(1);
});

test('concurrent and repeated requests cannot reach a second parent write',async()=>{
 const p=pair();let finish!:(value:null)=>void;const put=vi.fn(()=>new Promise<null>(resolve=>{finish=resolve;})),failed=vi.fn(),server=serveCommitDrillJournal(p.parent,{get:vi.fn(),put},failed);
 try{p.child.send({type:'journal',id:1,method:'put',key:'owned',value:'value'});await tick();p.child.send({type:'journal',id:2,method:'put',key:'owned',value:'value'});await tick();expect(failed).toHaveBeenCalledTimes(1);finish(null);await tick();expect(put).toHaveBeenCalledTimes(1);}
 finally{server.close();p.close();}
});
