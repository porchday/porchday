import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const script=new URL('./builder-chat-rollback.ts',import.meta.url).pathname;
const id='8c21a0e4-1b2c-4d5e-8f90-123456789abc',other='11111111-2222-4333-8444-555555555555';
let repo:string;
const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
const rollback=(...args:string[])=>{
 try{return {code:0,out:execFileSync(process.execPath,[script,...args],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']})};}
 catch(error){const e=error as {status:number;stdout:string;stderr:string};return {code:e.status,out:e.stdout+e.stderr};}
};
const commit=(file:string,text:string,message:string)=>{writeFileSync(join(repo,file),text);git('add',file);git('commit','-q','-m',message);return git('rev-parse','HEAD');};

describe('builder chat rollback command',()=>{
 beforeAll(()=>{
  repo=mkdtempSync(join(tmpdir(),'porchday-rollback-'));
  git('init','-q');git('config','user.email','builder@example.test');git('config','user.name','Builder');
  commit('footer.txt','original\n','Base');
 });
 afterAll(()=>rmSync(repo,{recursive:true,force:true}));

 it('reverts only the commits for one message, newest first, and leaves other work in place',()=>{
  commit('footer.txt','changed by chat\n',`Change the footer\n\nBuilder-Chat-Message: ${id}`);
  commit('other.txt','unrelated\n',`Other request\n\nBuilder-Chat-Message: ${other}`);
  commit('footer.txt','changed by chat twice\n',`Refine the footer\n\nBuilder-Chat-Message: ${id}`);
  const dry=rollback(id,'--dry-run');
  expect(dry.code).toBe(0);
  expect(dry.out.indexOf('Refine the footer')).toBeLessThan(dry.out.indexOf('Change the footer'));
  expect(dry.out).not.toContain('Other request');
  expect(git('log','-1','--format=%s')).toBe('Refine the footer');
  const result=rollback(id);
  expect(result.code).toBe(0);
  expect(result.out).toContain('Reverted 2 commit(s)');
  expect(result.out).toContain('Not pushed');
  expect(readFileSync(join(repo,'footer.txt'),'utf8')).toBe('original\n');
  expect(readFileSync(join(repo,'other.txt'),'utf8')).toBe('unrelated\n');
  // Running it again finds nothing left to revert.
  expect(rollback(id).out).toContain('No unreverted commits');
 });

 it('adds commits named with --commit and refuses a dirty checkout or a hash from another branch',()=>{
  const untagged=commit('notes.txt','note\n','Codex forgot the trailer');
  expect(rollback(other,'--commit',untagged.slice(0,10)).out).toContain('Reverted 2 commit(s)');
  expect(()=>readFileSync(join(repo,'notes.txt'),'utf8')).toThrow();
  writeFileSync(join(repo,'footer.txt'),'local edit\n');
  expect(rollback(id).out).toContain('Commit or stash local changes');
  git('checkout','--','footer.txt');
  expect(rollback(id,'--commit','deadbeef').code).not.toBe(0);
  expect(rollback('not-an-id').out).toContain('Usage');
 });
});
