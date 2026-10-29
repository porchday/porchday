import {beforeEach,expect,it,vi} from 'vitest';
import {builderChatAvailable} from '../src/BuilderChat';
import {get} from '../src/api';
vi.mock('../src/api',async original=>({...await original<typeof import('../src/api')>(),get:vi.fn()}));
beforeEach(()=>vi.mocked(get).mockReset());
it('uses either explicit bootstrap decision without fetching conversation state',async()=>{
 expect(await builderChatAvailable({builder_chat_available:true})).toBe(true);
 expect(await builderChatAvailable({builder_chat_available:false})).toBe(false);
 expect(get).not.toHaveBeenCalled();
});
it('preserves discovery against older servers, without caching another member decision',async()=>{
 vi.mocked(get).mockResolvedValueOnce({});expect(await builderChatAvailable({})).toBe(true);
 vi.mocked(get).mockRejectedValueOnce(Error('unavailable'));expect(await builderChatAvailable()).toBe(false);
 expect(get).toHaveBeenCalledTimes(2);expect(get).toHaveBeenCalledWith('/builder-chat');
});
it('does not trust malformed flags as access',async()=>{
 vi.mocked(get).mockRejectedValueOnce(Error('denied'));
 expect(await builderChatAvailable({builder_chat_available:'true'} as any)).toBe(false);
 expect(get).toHaveBeenCalledOnce();
});
