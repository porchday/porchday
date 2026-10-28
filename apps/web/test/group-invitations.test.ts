import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GroupInvitationList} from '../src/Community';

describe('owner group invitation list',()=>{
 it('names both parties and distinguishes pending, accepted and expired invitations',()=>{
  const html=renderToStaticMarkup(createElement(GroupInvitationList,{invitations:[
   {id:'1',recipient_handle:'guest',inviter_handle:'host',expires_at:'2999-01-01'},
   {id:'2',recipient_handle:'joined',inviter_handle:'host',accepted_at:'2026-01-01',expires_at:'2026-01-02'},
   {id:'3',recipient_handle:null,inviter_handle:null,expires_at:'2020-01-01'},
  ]}));
  for(const text of ['@guest','@host','Invited by','Pending','Accepted','Expired','Unavailable member'])expect(html).toContain(text);
 });
 it('explains an empty invitation list',()=>{
  expect(renderToStaticMarkup(createElement(GroupInvitationList,{invitations:[]}))).toContain('No group invitations yet.');
 });
});
