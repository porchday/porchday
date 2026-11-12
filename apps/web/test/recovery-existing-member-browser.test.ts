import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import {generateDeviceKeys,unlockPrivateKey,encryptObject} from '@porchday/crypto';

it.each(['chromium','webkit'] as const)('%s preserves existing-device and original-secret access when new recovery is unavailable',async engine=>{
  const id=crypto.randomUUID(),deviceId=crypto.randomUUID();
  const keys=await generateDeviceKeys(id,deviceId),authority=await generateDeviceKeys(id,'recovery',keys.recoverySecret);
  const key=await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret);
  const device={id:deviceId,member_id:id,public_key:keys.publicKey,fingerprint:keys.fingerprint,name:'Existing device'};
  const context={id:crypto.randomUUID(),kind:'post' as const,authorId:id,authorDeviceId:deviceId,audience:'only_me' as const,parentId:null,groupId:null,epoch:1,createdAt:new Date().toISOString(),expiresAt:null,revision:1};
  const envelope=await encryptObject({context,payload:{text:'Existing encrypted history remains readable'},signingKey:key,recipients:[{memberId:id,deviceId,publicKey:keys.publicKey}]});
  const backup={v:1,devices:[{id:deviceId,public_key:keys.publicKey,fingerprint:keys.fingerprint,encrypted_private_key:keys.encryptedPrivateKey}],recovery:{public_key:authority.publicKey,fingerprint:authority.fingerprint,encrypted_private_key:authority.encryptedPrivateKey}};
  const member={id,handle:'existing',status:'active',startup_devices:[device],recovery_setup_required:false,envelope};
  const fixture={member,device,armor:key.armor(),envelope};
  const bundle=await build({stdin:{contents:`
    import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
    import {VaultProvider,useVault} from './apps/web/src/vault';
    import {rememberDevice} from '@porchday/crypto/browser';import {importRecoveryPrivateKey} from '@porchday/crypto/recovery';
    const f=window.fixture;
    if(!sessionStorage.getItem('fixture-initialized')){
      localStorage.setItem('porchday-device:'+f.member.id,f.device.id);
      if(location.pathname==='/remembered')await rememberDevice({memberId:f.member.id,deviceId:f.device.id,fingerprint:f.device.fingerprint},await importRecoveryPrivateKey(f.armor,f.device.fingerprint));
      sessionStorage.setItem('fixture-initialized','true');
    }
    function Content(){const vault=useVault(),[text,setText]=useState('');useEffect(()=>{vault.open({envelope:f.envelope}).then(value=>setText(value.text));},[]);return <><p>{text}</p><button>Share post</button></>;}
    createRoot(document.getElementById('root')).render(<VaultProvider member={f.member} onAccountDeleted={async()=>{}}><Content/></VaultProvider>);
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'esm',write:false,define:{'process.env.NODE_ENV':'"production"'}});
  const browser=await(engine==='chromium'?chromium:webkit).launch();
  try{for(const mode of ['remembered','saved-secret']){
    const context=await browser.newContext(),page=await context.newPage();
    const recoveryReads:string[]=[],mutations:string[]=[];
    await page.route('http://127.0.0.1:43196/**',async route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(path==='/module.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
      if(path.startsWith('/api/')){
        if(req.method()!=='GET')mutations.push(path);
        if(path.startsWith('/api/v1/key-recovery')){recoveryReads.push(path);return route.fulfill({status:503,json:{error:{code:'UNAVAILABLE'}}});}
        if(path==='/api/v1/keys/backup')return route.fulfill({json:{envelope:backup}});
        if(path==='/api/v1/me')return route.fulfill({json:member});
        if(path==='/api/v1/devices')return route.fulfill({json:{items:[device]}});
        return route.fulfill({json:{items:[]}});
      }
      return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script>window.fixture='+JSON.stringify(fixture).replaceAll('<','\\u003c')+'</script><script type="module" src="/module.js"></script>'});
    });
    await page.goto('http://127.0.0.1:43196/'+mode);
    if(mode==='saved-secret'){
      await page.getByLabel('Encryption recovery secret',{exact:true}).fill(keys.recoverySecret);
      await page.getByRole('checkbox',{name:/Remember this private device/}).check();
      await page.getByRole('button',{name:'Unlock',exact:true}).click();
    }
    await page.getByText('Existing encrypted history remains readable',{exact:true}).waitFor();
    await expect.poll(()=>recoveryReads.length).toBeGreaterThan(0);
    expect(await page.getByRole('button',{name:'Share post',exact:true}).isEnabled()).toBe(true);
    expect(await page.getByRole('heading',{name:'Protect your access'}).count()).toBe(0);
    expect(mutations.filter(path=>path.startsWith('/api/v1/key-recovery')||path==='/api/v1/devices')).toEqual([]);
    await page.reload();await page.getByText('Existing encrypted history remains readable',{exact:true}).waitFor();
    expect(await page.getByRole('heading',{name:'Protect your access'}).count()).toBe(0);
    await context.close();
  }}finally{await browser.close();}
});
