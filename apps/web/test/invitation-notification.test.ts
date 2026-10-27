import {describe,it,expect} from 'vitest';
import {invitationHandle,notificationPath} from '../src/invitation-notification';
describe('invited member connection navigation',()=>{
 it('opens a prefilled form without creating a connection or accepting history choices',()=>{
  expect(notificationPath({kind:'invitation_joined',actor_handle:'new_member'})).toBe('/app/connections?handle=new_member');
  expect(invitationHandle('new_member')).toBe('new_member');
 });
 it('refuses malformed deep-link handles and preserves other notification destinations',()=>{
  for(const value of [null,{},'../settings','someone&admin=true','UPPER','x','x'.repeat(25),'person\n'])expect(invitationHandle(value)).toBeNull();
  expect(notificationPath({kind:'invitation_joined',actor_handle:'../settings'})).toBe('/app/connections');
  expect(notificationPath({kind:'comment',post_id:'post'})).toBe('/app/post/post');
  expect(notificationPath({kind:'group_invitation',group_id:'group'})).toBe('/app/groups/group');
 });
});
