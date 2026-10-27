import postgres from 'postgres';
import {userInfo} from 'node:os';
// Operator CLI for the builder chat allowlist. See design/builder-chat.md.
const [action,raw]=process.argv.slice(2);
const handle=raw?.replace(/^@/,'').toLowerCase();
if(!['add','remove','list'].includes(action)||(action!=='list'&&!/^[a-z0-9_]{3,24}$/.test(handle??''))||!process.env.DATABASE_MIGRATION_URL)
 throw new Error('Usage: builder-chat-access.ts add|remove <handle> | list, with DATABASE_MIGRATION_URL set');
const operator=(process.env.OPERATOR||userInfo().username).slice(0,254);
const db=postgres(process.env.DATABASE_MIGRATION_URL,{max:1,prepare:false,ssl:process.env.PG_LOCAL==='true'?false:'verify-full',onnotice:()=>{}});
try{
 if(action==='list'){
  const rows=await db`SELECT p.handle,a.enabled_by,a.enabled_at,a.disclosure_version FROM app.builder_chat_access a JOIN app.profiles p USING(member_id) ORDER BY p.handle`;
  if(!rows.length)console.log('The builder chat allowlist is empty.');
  for(const r of rows)console.log(`@${r.handle}  added by ${r.enabled_by} at ${new Date(r.enabled_at).toISOString()}  ${r.disclosure_version?'notice accepted':'notice not yet accepted'}`);
 }else{
  const [member]=await db`SELECT m.id,m.status FROM app.profiles p JOIN app.members m ON m.id=p.member_id WHERE p.handle=${handle!}`;
  if(!member)throw new Error('No member has the handle @'+handle);
  if(action==='add'){
   if(member.status!=='active')throw new Error('@'+handle+' is not an active member ('+member.status+').');
   const added=await db.begin(async tx=>{
    const rows=await tx`INSERT INTO app.builder_chat_access(member_id,enabled_by) VALUES(${member.id},${operator}) ON CONFLICT DO NOTHING RETURNING member_id`;
    if(rows.length)await tx`INSERT INTO app.builder_chat_audit(member_id,event,detail) VALUES(${member.id},'access_added',${tx.json({by:operator})})`;
    return rows.length>0;
   });
   console.log(added?'Added @'+handle+' to builder chat. They see it after accepting the notice.':'@'+handle+' was already on the allowlist.');
  }else{
   // Removal takes effect on the member's next request, within a few seconds.
   const removed=await db.begin(async tx=>{
    const rows=await tx`DELETE FROM app.builder_chat_access WHERE member_id=${member.id} RETURNING member_id`;
    if(rows.length)await tx`INSERT INTO app.builder_chat_audit(member_id,event,detail) VALUES(${member.id},'access_removed',${tx.json({by:operator})})`;
    await tx`UPDATE app.builder_chat_messages SET status='failed',progress=NULL,completed_at=now() WHERE member_id=${member.id} AND status='queued'`;
    return rows.length>0;
   });
   console.log(removed?'Removed @'+handle+' from builder chat. Their queued message, if any, was cancelled.':'@'+handle+' was not on the allowlist.');
  }
 }
}finally{await db.end();}
