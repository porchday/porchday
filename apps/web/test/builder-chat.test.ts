import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {builderStatus,queueDetails,Disclosure,Exchange,type BuilderMessage,type BuilderState} from '../src/BuilderChat';
import {StaffBuilderChat} from '../src/StaffBuilderChat';

const message=(overrides:Partial<BuilderMessage>={}):BuilderMessage=>({id:'m1',body:'Add a footer link',status:'answered',progress:null,reply:'Done.',commits:[],created_at:'2026-10-27T12:00:00Z',completed_at:'2026-10-27T12:01:00Z',...overrides});
const state=(overrides:Partial<BuilderState>={}):BuilderState=>({paused:false,online:true,disclosure:{version:1,accepted:true},ahead:0,sent_today:0,limits:{message_length:2000,daily_messages:100},messages:[],...overrides});

describe('builder chat status line',()=>{
 it('explains the current blocker and the known wait without claiming an ETA',()=>{
  const waiting=state({messages:[message({status:'queued'})],activity:'request_file'});
  expect(builderStatus(waiting)).toContain('request-file task');
  expect(builderStatus({...waiting,activity:'chat'})).toContain('another builder-chat message');
  expect(builderStatus({...waiting,activity:'other_work'})).toContain('another builder task');
  expect(builderStatus({...waiting,online:false})).toContain('offline');
  expect(builderStatus({...waiting,paused:true})).toContain('paused');
  expect(queueDetails(waiting,Date.parse('2026-10-27T12:03:00Z'))).toContain('Position 1 in the chat queue · Waiting 3 minutes');
  expect(queueDetails({...waiting,ahead:2},Date.parse('2026-10-27T12:00:30Z'))).toContain('Position 3 in the chat queue · Waiting less than a minute');
  expect(queueDetails(state())).toBeNull();
 });
 it('describes each conversation state in plain words',()=>{
  expect(builderStatus(state())).toBe('Codex is online.');
  expect(builderStatus(state({online:false}))).toContain('Codex is offline right now. You can send a message');
  expect(builderStatus(state({paused:true}))).toBe('Builder chat is paused by the Porchday team.');
  expect(builderStatus(state({messages:[message({status:'queued'})],ahead:2}))).toBe('Waiting for Codex. 2 messages ahead of yours.');
  expect(builderStatus(state({messages:[message({status:'queued'})],ahead:1}))).toBe('Waiting for Codex. 1 message ahead of yours.');
  expect(builderStatus(state({messages:[message({status:'queued'})],online:false}))).toContain('Your message will be answered when Codex is back');
  expect(builderStatus(state({messages:[message({status:'working',progress:'testing'})]}))).toBe('Codex is running tests.');
  // A turn already running continues during a pause.
  expect(builderStatus(state({paused:true,messages:[message({status:'working',progress:'editing'})]}))).toBe('Codex is editing files.');
 });
});

describe('builder chat page parts',()=>{
 it('renders replies as plain text with commit links and outcomes',()=>{
  const html=renderToStaticMarkup(createElement('ol',null,
   createElement(Exchange,{message:message({reply:'<b>not markup</b>',commits:['4c7ef31abcde']})}),
   createElement(Exchange,{message:message({id:'m2',status:'timed_out',reply:''})}),
   createElement(Exchange,{message:message({id:'m3',status:'working',progress:'committing',reply:''})})));
  expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;');
  expect(html).toContain('href="https://github.com/porchday/porchday/commit/4c7ef31abcde"');
  expect(html).toContain('Codex ran out of time on this request.');
  expect(html).toContain('Codex is committing a change.');
  expect(html).toContain('aria-busy="true"');
 });
 it('shows the disclosure facts before the first message',()=>{
  const html=renderToStaticMarkup(createElement(Disclosure,{version:1,onAccepted:async()=>{}}));
  for(const fact of ['OpenAI Codex','not encrypted','within about an hour','passwords, recovery codes','kept for 90 days'])expect(html).toContain(fact);
  expect(html).toMatch(/<button[^>]*disabled/);
 });
 it('staff view renders without a member session',()=>{
  expect(renderToStaticMarkup(createElement(StaffBuilderChat))).toContain('Builder chat');
 });
});
