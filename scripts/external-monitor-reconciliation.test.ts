import {describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sessionReconciliation} from './external-monitor-reconciliation';
const cookie='__Secure-better-auth.session_token=synthetic-private-token';
describe('durable synthetic session reconciliation',()=>{
 it('survives restart, checks only the old cookie, and retires only after 401',async()=>{
  const d=mkdtempSync(join(tmpdir(),'reconcile-'));
  try{
   const first=sessionReconciliation(d);first.capture(cookie);
   expect(statSync(join(d,'pending-sessions.json')).mode&0o077).toBe(0);
   let status=200;const calls:RequestInit[]=[];
   const fetcher=(async (_url,init)=>{calls.push(init!);return new Response('{}',{status});}) as typeof fetch;
   await sessionReconciliation(d,{fetch:fetcher}).reconcile();
   expect(JSON.parse(readFileSync(join(d,'pending-sessions.json'),'utf8'))).toHaveLength(1);
   status=401;await sessionReconciliation(d,{fetch:fetcher}).reconcile();
   expect(JSON.parse(readFileSync(join(d,'pending-sessions.json'),'utf8'))).toEqual([]);
   expect(calls.every(c=>!c.method&&c.redirect==='manual'&&c.headers&&new Headers(c.headers).get('Cookie')===cookie)).toBe(true);
   const history=readFileSync(join(d,'session-reconciliation.jsonl'),'utf8');expect(history).toContain('still_authorized');expect(history).toContain('rejected');expect(history).not.toContain(cookie);
  }finally{rmSync(d,{recursive:true,force:true});}
 });
 it('retains uncertain reads and never interprets retention expiry as revocation',async()=>{
  const d=mkdtempSync(join(tmpdir(),'reconcile-'));let now=1000,calls=0;
  try{
   const options={now:()=>now,fetch:(async()=>{calls++;throw Error('secret');}) as typeof fetch};
   sessionReconciliation(d,options).capture(cookie);await sessionReconciliation(d,options).reconcile();
   expect(JSON.parse(readFileSync(join(d,'pending-sessions.json'),'utf8'))).toHaveLength(1);
   now+=7*86400000;await sessionReconciliation(d,options).reconcile();expect(calls).toBe(1);
   const history=readFileSync(join(d,'session-reconciliation.jsonl'),'utf8');expect(history).toContain('retention_expired_unconfirmed');expect(history).not.toContain('secret');expect(history).not.toContain('rejected');
  }finally{rmSync(d,{recursive:true,force:true});}
 });
});
