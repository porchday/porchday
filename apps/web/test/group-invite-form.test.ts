import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {groupInviteChoices,GroupInviteForm} from '../src/GroupInviteForm';

describe('group connection picker',()=>{
 it('offers accepted connections from either side, excluding members, pending requests and unavailable handles',()=>{
  const data={items:[
   {member_a:'me',member_b:'z'}, {member_a:'a',member_b:'me'},
   {member_a:'me',member_b:'joined'}, {member_a:'me',member_b:'hidden'},
  ],requests:[{sender:'me',recipient:'pending'}],handles:[
   {id:'me',handle:'self'}, {id:'z',handle:'zoe'}, {id:'a',handle:'amy'},
   {id:'joined',handle:'already_here'}, {id:'pending',handle:'not_accepted'},
  ]};
  expect(groupInviteChoices(data,'me',[{member_id:'joined'}])).toEqual([{id:'a',handle:'amy'},{id:'z',handle:'zoe'}]);
 });
 it('starts with a labelled connection selector and offers manual entry as an alternative',()=>{
  const html=renderToStaticMarkup(createElement(GroupInviteForm,{memberId:'me',members:[],onInvite:async()=>{}}));
  expect(html).toContain('Invite a connection');
  expect(html).toContain('Loading connections');
  expect(html).toContain('Use an exact handle instead');
  expect(html).toMatch(/<select[^>]*disabled/);
 });
});
