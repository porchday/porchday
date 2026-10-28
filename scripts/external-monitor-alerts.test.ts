import {describe,expect,it} from 'vitest';
import {advance,alertBody,initialState} from './external-monitor-alerts';
import type {Observation} from './external-monitor-probe';
const at=Date.parse('2026-10-28T21:00:00Z');
const observation=(offset:number,healthy:boolean):Observation=>({v:1,at:new Date(at+offset).toISOString(),environment:'production',healthy,checks:[{name:'protected_readiness',ok:healthy}],durationMs:1,scope:'login_authorized_reads_logout_and_readiness'});
describe('external monitor alert transitions',()=>{
 it('alerts once for an outage, then only after two consecutive successful checks',()=>{
  let state=advance(initialState(),observation(0,false),'outage');
  state=advance(state,observation(20000,false),'repeat');
  state=advance(state,observation(40000,true),'first-good');
  expect(state.pending.map(e=>e.id)).toEqual(['outage']);
  state=advance(state,observation(60000,true),'recovery');
  expect(state.pending.map(e=>e.id)).toEqual(['outage','recovery']);
  state=advance(state,observation(80000,true),'more-good');
  expect(state.pending).toHaveLength(2);
 });
 it('preserves an undelivered outage and recovery across JSON persistence',()=>{
  let state=advance(initialState(),observation(0,false),'outage');
  state=advance(JSON.parse(JSON.stringify(state)),observation(20000,true),'first');
  state=advance(state,observation(40000,true),'recovery');
  expect(state.pending.map(e=>e.kind)).toEqual(['outage','recovery']);
 });
 it('does not count monitoring gaps as recovery or accept older observations',()=>{
  let state=advance(initialState(),observation(0,false),'outage');
  state=advance(state,observation(20000,true),'first');
  state=advance(state,observation(100000,true),'after-gap');
  expect(state.incident).toBe(true);expect(state.healthyStreak).toBe(1);
  expect(advance(state,observation(0,true),'old')).toBe(state);
 });
 it('retains the outage when a partial recovery fails again',()=>{
  let state=advance(initialState(),observation(0,false),'outage');
  state=advance(state,observation(20000,true),'first');
  state=advance(state,observation(40000,false),'failed-again');
  expect(state.healthyStreak).toBe(0);expect(state.pending).toHaveLength(1);
 });
 it('rejects arbitrary response data from public notifications',()=>{
  expect(()=>alertBody({id:'one',kind:'outage',at:new Date(at).toISOString(),failedChecks:['sensitive member details']},'operator-mac')).toThrow();
  expect(()=>advance(initialState(),{...observation(0,false),checks:[{name:'sensitive member details',ok:false}]},'one')).toThrow();
 });
 it('marks drills explicitly and mentions both verified owners',()=>{
  const body=alertBody({id:'drill',kind:'outage',at:new Date(at).toISOString(),failedChecks:['login']},'operator-mac',true);
  expect(body).toContain('@andyk @bobbyhwilder');expect(body).toContain('Notification drill');expect(body).toContain('<!-- porchday-external-monitor:operator-mac:drill -->');
 });
});
