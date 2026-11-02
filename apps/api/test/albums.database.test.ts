import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;
let admin: Sql, db: Sql, database: string;
const actor = (who: string, run: (sql: TransactionSql) => Promise<unknown>) => db.begin(async sql => {
  await sql`set local role porchday_social`;
  await sql`select set_config('app.member_id',${who},true)`;
  return run(sql);
});
async function member() {
  const id = randomUUID();
  await db`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`;
  return id;
}
function envelope(album: string, author: string, revision = 1) {
  return { context: {id:album, authorId:author, kind:"album",revision}, ciphertext:"synthetic SQL fixture; not crypto evidence" };
}
async function create(owner: string) {
  const id = randomUUID();
  await actor(owner, sql => sql`select app.create_album(${id},${sql.json(envelope(id,owner))})`);
  return id;
}
async function change(owner: string, album: string, member: string, role: string | null, revision: number) {
  return actor(owner, sql => sql`select app.change_album_member(${album},${member},${role},${sql.json(envelope(album,owner,revision+1))},${revision})`);
}
suite("Social album database authorization and restore", () => {
  beforeAll(async () => {
    const url = new URL(base!);
    if (!["localhost","127.0.0.1"].includes(url.hostname)) throw Error("Disposable loopback database required");
    admin = postgres(base!, {max:1,prepare:false,onnotice:()=>{}});
    database = "porchday_album_test_"+randomUUID().replaceAll("-","");
    await admin.unsafe("CREATE DATABASE "+database);
    url.pathname="/"+database;
    db=postgres(url.href,{max:3,prepare:false,onnotice:()=>{}});
    for(const file of (await readdir(new URL("../migrations/",import.meta.url))).filter(n=>n.endsWith(".sql")).sort()) {
      await db.unsafe(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
  },60000);
  afterAll(async()=>{if(db)await db.end();if(admin){if(database)await admin.unsafe("DROP DATABASE IF EXISTS "+database+" WITH (FORCE)");await admin.end();}});
  it("isolates albums and membership from outsiders and disallows direct runtime table mutations",async()=>{
    const owner=await member(), outsider=await member(), album=await create(owner);
    expect(await actor(owner,sql=>sql`select id from app.albums where id=${album}`)).toHaveLength(1);
    expect(await actor(outsider,sql=>sql`select id from app.albums where id=${album}`)).toHaveLength(0);
    expect(await actor(outsider,sql=>sql`select * from app.album_members where album_id=${album}`)).toHaveLength(0);
    await expect(actor(outsider,sql=>sql`insert into app.album_members(album_id,member_id,role) values(${album},${outsider},'admin')`)).rejects.toThrow(/permission denied/);
  });
  it("preserves owner administration, admits readers/contributors, and rejects unauthorized role changes",async()=>{
    const owner=await member(), reader=await member(), contributor=await member(), album=await create(owner);
    await change(owner,album,reader,"read",1);
    await change(owner,album,contributor,"add",2);
    expect(await actor(reader,sql=>sql`select app.album_role(${album}) as role`)).toMatchObject([{role:"read"}]);
    expect(await actor(contributor,sql=>sql`select app.album_role(${album}) as role`)).toMatchObject([{role:"add"}]);
    await expect(change(reader,album,reader,"admin",3)).rejects.toThrow(/FORBIDDEN/);
    await expect(change(contributor,album,reader,"admin",3)).rejects.toThrow(/FORBIDDEN/);
    await expect(change(owner,album,owner,"read",3)).rejects.toThrow(/ALBUM_OWNER_REQUIRED/);
    await expect(actor(owner,sql=>sql`select app.leave_album(${album})`)).rejects.toThrow(/ALBUM_OWNER_REQUIRED/);
    await change(owner,album,contributor,"admin",3);
    await change(contributor,album,reader,"add",4);
    await expect(change(owner,album,reader,"read",4)).rejects.toThrow(/REVISION_CHANGED/);
    await actor(owner,sql=>sql`select app.transfer_album(${album},${contributor})`);
    await actor(owner,sql=>sql`select app.leave_album(${album})`);
    expect(await actor(owner,sql=>sql`select * from app.albums where id=${album}`)).toHaveLength(0);
    await actor(reader,sql=>sql`select app.leave_album(${album})`);
    expect(await actor(reader,sql=>sql`select * from app.album_members where album_id=${album}`)).toHaveLength(0);
  });
  it("denies restricted writes and blocked membership, and retains a deletion tombstone",async()=>{
    const owner=await member(), reader=await member(), album=await create(owner);
    await db`insert into app.blocks(actor,target) values(${owner},${reader})`;
    await expect(change(owner,album,reader,"read",1)).rejects.toThrow(/ACCOUNT_UNAVAILABLE/);
    await db`update app.members set status='restricted' where id=${owner}`;
    await expect(actor(owner,sql=>sql`select app.delete_album(${album})`)).rejects.toThrow(/FORBIDDEN/);
    await db`update app.members set status='active' where id=${owner}`;
    await actor(owner,sql=>sql`select app.delete_album(${album})`);
    expect(await db`select * from app.deletion_ledger where kind='albums' and object_id=${album}`).toHaveLength(1);
    await expect(actor(owner,sql=>sql`select app.create_album(${album},${sql.json(envelope(album,owner))})`)).rejects.toThrow(/CONTENT_DELETED/);
  });
  it("restricts prospective audiences to admins and preserves the owner",async()=>{
    const owner=await member(), reader=await member(), outsider=await member(), album=await create(owner);
    await change(owner,album,reader,"read",1);
    const members=await actor(owner,sql=>sql`select member_id from app.album_audience_members(${album},${outsider},'add')`);
    expect((members as {member_id:string}[]).map(m=>m.member_id).sort()).toEqual([owner,reader,outsider].sort());
    await expect(actor(reader,sql=>sql`select * from app.album_audience_members(${album},${outsider},'read')`)).rejects.toThrow(/FORBIDDEN/);
    await expect(actor(outsider,sql=>sql`select * from app.album_audience_members(${album})`)).rejects.toThrow(/NOT_FOUND/);
    await expect(actor(owner,sql=>sql`select * from app.album_audience_members(${album},${owner},null)`)).rejects.toThrow(/ALBUM_OWNER_REQUIRED/);
    expect(await actor(owner,sql=>sql`select member_id from app.album_audience_members(${album},${reader},null)`)).toMatchObject([{member_id:owner}]);
    await db`insert into app.blocks(actor,target) values(${reader},${owner})`;
    expect(await actor(reader,sql=>sql`select * from app.albums where id=${album}`)).toHaveLength(0);
    await expect(actor(owner,sql=>sql`select * from app.album_audience_members(${album})`)).rejects.toThrow(/ALBUM_AUDIENCE_BLOCKED/);
  });
  it("replays removals and downgrades without restoring an older permission",async()=>{
    const owner=await member(), reader=await member(), album=await create(owner);
    await change(owner,album,reader,"admin",1);
    await change(owner,album,reader,"read",2);
    const events=await db`select sequence,id,occurred_at,decision from app.safety_journal where decision->>'action'='album_role' and decision->>'album'=${album}`;
    expect(events).toHaveLength(1);
    // Simulate an older restored membership before applying its durable denial.
    await db`update app.album_members set role='admin' where album_id=${album} and member_id=${reader}`;
    await db`update app.safety_journal_state set restore_quarantined=true where id`;
    await db`select app.replay_safety_batch(${db.json(events as any)})`;
    expect(await db`select role from app.album_members where album_id=${album} and member_id=${reader}`).toMatchObject([{role:"read"}]);
    await db`update app.safety_journal_state set restore_quarantined=false where id`;
    await change(owner,album,reader,null,3);
    const removals=await db`select sequence,id,occurred_at,decision from app.safety_journal where decision->>'action'='album_member_remove' and decision->>'album'=${album}`;
    await db`insert into app.album_members(album_id,member_id,role) values(${album},${reader},'read')`;
    await db`update app.safety_journal_state set restore_quarantined=true where id`;
    await db`select app.replay_safety_batch(${db.json(removals as any)})`;
    expect(await db`select role from app.album_members where album_id=${album} and member_id=${reader}`).toHaveLength(0);
    await db`update app.safety_journal_state set restore_quarantined=false where id`;
  });
});
