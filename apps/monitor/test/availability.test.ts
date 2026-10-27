import {describe,it,expect} from 'vitest';
import {recordAvailability,availabilitySummary,WINDOW_MINUTES} from '../src/availability';
describe('rolling protected-readiness history',()=>{
 it('counts each failed minute even before an alert and never invents warmup history',()=>{
  let history=recordAvailability(undefined,100,true);history=recordAvailability(history,101,false);
  expect(availabilitySummary(history,101)).toMatchObject({status:'collecting',expected_minutes:2,passed_minutes:1,failed_minutes:1,unknown_minutes:0,conservative_pass_percent:50});
  expect(recordAvailability(history,101,true)).toEqual(history);
 });
 it('counts missed schedules and stale monitoring as unknown, not success',()=>{
  const history=recordAvailability(recordAvailability(undefined,100,true),103,true);
  expect(availabilitySummary(history,105)).toMatchObject({expected_minutes:6,passed_minutes:2,failed_minutes:0,unknown_minutes:4});
  expect(availabilitySummary(history,103)).toMatchObject({expected_minutes:4,unknown_minutes:2});
 });
 it('retains only the actual rolling 30-day window, including a prolonged monitor outage',()=>{
  const history=recordAvailability(recordAvailability(undefined,100,false),100+WINDOW_MINUTES,true);
  expect(history.samples.length).toBe(WINDOW_MINUTES);
  expect(availabilitySummary(history,100+WINDOW_MINUTES)).toMatchObject({status:'complete_window',passed_minutes:1,failed_minutes:0,unknown_minutes:WINDOW_MINUTES-1});
  expect(availabilitySummary(history,100+2*WINDOW_MINUTES)).toMatchObject({passed_minutes:0,failed_minutes:0,unknown_minutes:WINDOW_MINUTES,conservative_pass_percent:0});
 });
 it('does not invent a healthy result for missing, malformed or future history',()=>{
  expect(availabilitySummary(undefined)).toEqual({status:'unavailable'});
  expect(availabilitySummary({v:1,firstTick:2,lastTick:3,samples:'1'})).toEqual({status:'unavailable'});
  expect(availabilitySummary(recordAvailability(undefined,100,true),99)).toEqual({status:'unavailable'});
 });
 it('represents the 99.9% minute budget conservatively and without alert deduplication',()=>{
  const samples='2'.repeat(43)+'1'.repeat(WINDOW_MINUTES-43);
  expect(availabilitySummary({v:1,firstTick:0,lastTick:WINDOW_MINUTES-1,samples},WINDOW_MINUTES-1)).toMatchObject({status:'complete_window',failed_minutes:43,conservative_pass_percent:99.9,observed_percent:100});
 });
});
