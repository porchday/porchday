import {afterEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {assembleReleaseAssets,type AssetBuild} from './release-assets.ts';
const roots:string[]=[];
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-release-assets-')));roots.push(root);return root;}
function build(root:string,name:string,contents:Record<string,string>):AssetBuild {
 const directory=join(root,name);mkdirSync(directory);const files:Record<string,string>={};
 for(const [path,body] of Object.entries(contents)){mkdirSync(dirname(join(directory,path)),{recursive:true});writeFileSync(join(directory,path),body);files[path]=sha(body);}
 return{directory,source:sha(name).slice(0,40),files};
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('release asset continuity',()=>{
 it('runs the native CLI and refuses to replace its earlier artifact',()=>{
  const root=fixture(),candidate=build(root,'new',{'index.html':'new','assets/new.js':'module'}),plan=join(root,'plan.json'),output=join(root,'output');
  writeFileSync(plan,JSON.stringify({candidate,retained:[]}));
  const args=['scripts/release-assets.ts',plan,output],first=spawnSync(process.execPath,args,{encoding:'utf8'});
  expect(first.status,first.stderr).toBe(0);expect(JSON.parse(first.stdout).files).toEqual(candidate.files);
  const second=spawnSync(process.execPath,args,{encoding:'utf8'});expect(second.status).toBe(1);expect(second.stderr.trim()).toBe('RELEASE_ASSET_ASSEMBLY_FAILED');
 });
 it('retains old module dependencies while keeping the new shell and service worker',()=>{
  const root=fixture(),old=build(root,'old',{'index.html':'old shell','sw.js':'old worker','assets/index-old.js':'import "./react-old.js";','assets/react-old.js':'old react','assets/crypto-v1/module.mjs':'old crypto','icon-192-0123456789abcdef.png':'old icon'});
  const candidate=build(root,'new',{'index.html':'new shell','sw.js':'new worker','assets/index-new.js':'new app'}),output=join(root,'output');
  const result=assembleReleaseAssets({candidate,retained:[old]},output);
  expect(readFileSync(join(output,'index.html'),'utf8')).toBe('new shell');expect(readFileSync(join(output,'sw.js'),'utf8')).toBe('new worker');
  expect(readFileSync(join(output,'assets/react-old.js'),'utf8')).toBe('old react');
  expect(result.retainedPaths).toEqual(['assets/crypto-v1/module.mjs','assets/index-old.js','assets/react-old.js','icon-192-0123456789abcdef.png']);
  for(const [path,digest] of Object.entries(result.files))expect(createHash('sha256').update(readFileSync(join(output,path))).digest('hex')).toBe(digest);
 });
 it('prepares a rollback shell that still serves assets seen during the candidate rollout',()=>{
  const root=fixture(),old=build(root,'old',{'index.html':'old','assets/old.js':'old module'}),candidate=build(root,'new',{'index.html':'new','assets/new.js':'new module'});
  const output=join(root,'rollback');assembleReleaseAssets({candidate:old,retained:[candidate]},output);
  expect(readFileSync(join(output,'index.html'),'utf8')).toBe('old');expect(readFileSync(join(output,'assets/new.js'),'utf8')).toBe('new module');
 });
 it('rejects a reused immutable URL with different bytes before publishing anything',()=>{
  const root=fixture(),old=build(root,'old',{'assets/shared.js':'old'}),candidate=build(root,'new',{'assets/shared.js':'new'}),output=join(root,'output');
  expect(()=>assembleReleaseAssets({candidate,retained:[old]},output)).toThrow('IMMUTABLE_ASSET_CONFLICT');expect(existsSync(output)).toBe(false);
 });
 it('rejects tampered retained bytes and does not silently omit a missing dependency',()=>{
  const root=fixture(),old=build(root,'old',{'assets/old.js':'old'}),candidate=build(root,'new',{'index.html':'new'}),output=join(root,'output');
  writeFileSync(join(old.directory,'assets/old.js'),'tampered');expect(()=>assembleReleaseAssets({candidate,retained:[old]},output)).toThrow('ASSET_HASH_MISMATCH');
  rmSync(join(old.directory,'assets/old.js'));expect(()=>assembleReleaseAssets({candidate,retained:[old]},output)).toThrow();expect(existsSync(output)).toBe(false);
 });
 it('rejects traversal and symlink file or directory inputs',()=>{
  const root=fixture(),candidate=build(root,'new',{'assets/new.js':'new'}),output=join(root,'output');
  expect(()=>assembleReleaseAssets({candidate:{...candidate,files:{'../private':sha('secret')}},retained:[]},output)).toThrow('INVALID_ASSET_MANIFEST');
  rmSync(join(candidate.directory,'assets/new.js'));writeFileSync(join(root,'outside'),'new');symlinkSync(join(root,'outside'),join(candidate.directory,'assets/new.js'));
  expect(()=>assembleReleaseAssets({candidate,retained:[]},output)).toThrow('INVALID_ASSET_FILE');
  rmSync(join(candidate.directory,'assets'),{recursive:true});mkdirSync(join(root,'outside-dir'));writeFileSync(join(root,'outside-dir/new.js'),'new');symlinkSync(join(root,'outside-dir'),join(candidate.directory,'assets'));
  expect(()=>assembleReleaseAssets({candidate,retained:[]},output)).toThrow('ASSET_PARENT_SYMLINK');
 });
 it('deduplicates identical content and never replaces an existing package',()=>{
  const root=fixture(),old=build(root,'old',{'assets/react.js':'react'}),candidate=build(root,'new',{'index.html':'new','assets/react.js':'react'}),output=join(root,'output');
  const result=assembleReleaseAssets({candidate,retained:[old]},output);expect(result.totalBytes).toBe(8);expect(result.retainedPaths).toEqual([]);
  expect(()=>assembleReleaseAssets({candidate,retained:[old]},join(candidate.directory,'output'))).toThrow('ASSET_OUTPUT_OVERLAPS_INPUT');
  expect(()=>assembleReleaseAssets({candidate,retained:[old]},output)).toThrow('ASSET_OUTPUT_EXISTS');expect(readFileSync(join(output,'index.html'),'utf8')).toBe('new');
 });
});
