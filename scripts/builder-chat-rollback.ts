import {execFileSync} from 'node:child_process';
// Reverts every commit made for one builder chat message, newest first.
// Commits are found by their "Builder-Chat-Message: <id>" trailer; pass
// --commit <hash> (repeatable) to add commits shown in the staff view that
// lack the trailer. Nothing is pushed without --push.
const args=process.argv.slice(2);
const id=args.find(a=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a));
const extra=args.flatMap((a,i)=>a==='--commit'&&args[i+1]?[args[i+1]]:[]);
if(!id||extra.some(h=>!/^[0-9a-f]{7,40}$/.test(h)))throw new Error('Usage: builder-chat-rollback.ts <message-id> [--commit <hash>]... [--push] [--dry-run]');
const git=(...a:string[])=>execFileSync('git',a,{encoding:'utf8'}).trim();
if(git('status','--porcelain','--untracked-files=no'))throw new Error('Commit or stash local changes before rolling back.');
const tagged=git('log','--format=%H','--fixed-strings','--grep','Builder-Chat-Message: '+id).split('\n').filter(Boolean);
const expanded=extra.map(h=>git('rev-parse','--verify',h+'^{commit}'));
const reverted=new Set(git('log','--format=%B','--fixed-strings','--grep','This reverts commit').match(/This reverts commit [0-9a-f]{40}/g)?.map(l=>l.slice(-40))??[]);
// Newest first, in history order, so each revert applies cleanly.
const order=git('rev-list','HEAD').split('\n');
const commits=[...new Set([...tagged,...expanded])].filter(h=>!reverted.has(h)).sort((a,b)=>order.indexOf(a)-order.indexOf(b));
if(expanded.some(h=>!order.includes(h)))throw new Error('A --commit hash is not part of the current branch.');
if(!commits.length){console.log('No unreverted commits found for builder chat message '+id+'. Check the staff view for its commit hashes and pass them with --commit.');process.exit(0);}
console.log('Commits for builder chat message '+id+', newest first:');
for(const h of commits)console.log('  '+git('log','-1','--format=%h %s',h));
if(args.includes('--dry-run'))process.exit(0);
for(const h of commits){
 const parents=git('rev-list','--parents','-n','1',h).split(' ').length-1;
 try{execFileSync('git',['revert','--no-edit',...(parents>1?['-m','1']:[]),h],{stdio:'inherit'});}
 catch{throw new Error('git revert stopped on '+h.slice(0,12)+'. Resolve the conflict, run "git revert --continue", then run this command again for the remaining commits.');}
}
console.log('Reverted '+commits.length+' commit(s). Run the tests before pushing.');
if(args.includes('--push')){execFileSync('git',['push'],{stdio:'inherit'});console.log('Pushed. The next hourly deploy ships the revert.');}
else console.log('Not pushed. Push with "git push" after the tests pass; the next hourly deploy ships the revert.');
