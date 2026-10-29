import {expect,it,vi} from 'vitest';
import {executeActivationManifest,type ActivationManifest} from './release-activation-cli';
it.each(['staging','production'])('rejects %s monitor plans at the application entry point before reads or writes',async environment=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('unexpected network'));
 try{
  const input={version:1,plan:{worker:'porchday-monitor-'+environment},review:{}} as ActivationManifest;
  await expect(executeActivationManifest(input,{},new AbortController().signal)).rejects.toThrow('DEPLOYMENT_TARGET_INVALID');
  expect(fetch).not.toHaveBeenCalled();
 }finally{fetch.mockRestore();}
});
