import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;
let admin: Sql, db: Sql, database: string;
const devices = new Map<string,string>();
const actor = (who: string, run: (sql: TransactionSql) => Promise<unknown>) => db.begin(async sql => {
  await sql`set local role porchday_social`;
  await sql`select set_config('app.member_id',${who},true)`;
  return run(sql);
});
async function member() {
  const id = randomUUID();
  await db`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`;
  const device=randomUUID(); devices.set(id,device);
  await db`insert into app.profiles(member_id,handle) values(${id},${"u_"+id.replaceAll("-","").slice(0,20)})`;
  await db`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${device},${id},${"synthetic".repeat(30)},${randomUUID().replaceAll("-","")+"aabbccdd"},'{}')`;
  return id;
}
function envelope(album: string, author: string, revision = 1) {
  return { context: {id:album, authorId:author, authorDeviceId:devices.get(author), kind:"album",revision}, ciphertext:"synthetic SQL fixture; not crypto evidence" };
}
async function create(owner: string) {
  const id = randomUUID();
  await actor(owner, sql => sql`select app.create_album(${id},${sql.json(envelope(id,owner))})`);
  return id;
}
async function change(owner: string, album: string, member: string, role: string | null, revision: number) {
  return actor(owner, sql => sql`select app.change_album_member(${album},${member},${role},${sql.json(envelope(album,owner,revision+1))},${revision})`);
}
async function photo(owner:string) {
  const id=randomUUID();
  await actor(owner,sql=>sql`select app.create_photo(${id},'2026-10-31'::date)`);
  return id;
}
async function grant(owner:string,p:string,readers:string[],album:string|null=null,audience=album?"album":"connections") {
  const id=randomUUID(), media=randomUUID();
  const recipients=[...new Set([owner,...readers])].sort().map(memberId=>({memberId,deviceId:devices.get(memberId)}));
  const context={id,kind:"photo",authorId:owner,authorDeviceId:devices.get(owner),parentId:p,groupId:album,audience,expiresAt:null,revision:1};
  const envelope={context,recipients,ciphertext:"SQL fixture only"};
  const mediaEnvelope={context:{...context,id:media,kind:"media"},recipients};
  await db`insert into app.media_assets(id,owner_id,object_key,envelope,byte_size,state) values(${media},${owner},${"synthetic/"+media},${db.json(mediaEnvelope)},100,'ready')`;
  await actor(owner,sql=>sql`select app.add_photo_grant(${id},${p},${album},${sql.json(envelope)},${media})`);
  return {id,media};
}
async function connect(a:string,b:string) {
  await db`insert into app.connections(member_a,member_b,kind) values(${[a,b].sort()[0]},${[a,b].sort()[1]},'friend')`;
}
suite("Independent photo sharing paths",()=>{
  beforeAll(async () => {
    const url = new URL(base!);
    if (!["localhost","127.0.0.1"].includes(url.hostname)) throw Error("Disposable loopback database required");
    admin = postgres(base!, {max:1,prepare:false,onnotice:()=>{}});
    database = "porchday_photo_test_"+randomUUID().replaceAll("-","");
    await admin.unsafe("CREATE DATABASE "+database);
    url.pathname="/"+database;
    db=postgres(url.href,{max:3,prepare:false,onnotice:()=>{}});
    for(const file of (await readdir(new URL("../migrations/",import.meta.url))).filter(n=>n.endsWith(".sql")).sort()) {
      await db.unsafe(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
  },60000);
  afterAll(async()=>{if(db)await db.end();if(admin){if(database)await admin.unsafe("DROP DATABASE IF EXISTS "+database+" WITH (FORCE)");await admin.end();}});

  it("unions direct and two album grants without changing photo identity or the original audience",async()=>{
    const owner=await member(),direct=await member(),reader=await member(),outsider=await member();
    await connect(owner,direct);
    const p=await photo(owner),a=await create(owner),b=await create(owner);
    await change(owner,a,reader,"read",1);await change(owner,b,reader,"read",1);
    const original=await grant(owner,p,[direct]);const first=await grant(owner,p,[reader],a);const second=await grant(owner,p,[reader],b);
    expect(await actor(direct,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(1);
    expect(await actor(reader,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(1);
    expect(await actor(outsider,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(0);
    expect(await actor(reader,sql=>sql`select id from app.media_assets where id=${original.media}`)).toHaveLength(0);
    await actor(owner,sql=>sql`select app.remove_photo_grant(${first.id})`);
    expect(await actor(reader,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(1);
    expect(await db`select id from app.media_assets where id=${first.media}`).toHaveLength(0);
    await actor(owner,sql=>sql`select app.delete_album(${b})`);
    expect(await actor(reader,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(0);
    expect(await actor(direct,sql=>sql`select id from app.media_assets where id=${original.media}`)).toHaveLength(1);
    expect(await db`select id from app.photos where id=${p}`).toHaveLength(1);
    expect(await db`select id from app.media_assets where id=${second.media}`).toHaveLength(0);
  });
  it("enforces contribution/ownership boundaries and current membership",async()=>{
    const owner=await member(),admin=await member(),reader=await member(),a=await create(admin);
    await change(admin,a,owner,"read",1);await change(admin,a,reader,"read",2);
    const p=await photo(owner);
    await expect(grant(owner,p,[admin,reader],a)).rejects.toThrow(/FORBIDDEN/);
    await change(admin,a,owner,"add",3);
    const added=await grant(owner,p,[admin,reader],a);
    await expect(actor(reader,sql=>sql`select app.remove_photo_grant(${added.id})`)).rejects.toThrow(/FORBIDDEN/);
    await expect(actor(admin,sql=>sql`select app.delete_photo(${p})`)).rejects.toThrow(/NOT_FOUND/);
    await actor(reader,sql=>sql`select app.leave_album(${a})`);
    expect(await actor(reader,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(0);
    await actor(admin,sql=>sql`select app.remove_photo_grant(${added.id})`);
    expect(await db`select id from app.photos where id=${p}`).toHaveLength(1);
    expect(await db`select * from app.deletion_ledger where kind='photo_grants' and object_id=${added.id}`).toHaveLength(1);
  });
  it("denies expired/blocked reads and cleans up every path on photo deletion",async()=>{
    const owner=await member(),reader=await member();await connect(owner,reader);
    const p=await photo(owner),g=await grant(owner,p,[reader]);
    await db`insert into app.blocks(actor,target) values(${reader},${owner})`;
    expect(await actor(reader,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(0);
    await db`delete from app.blocks where actor=${reader} and target=${owner}`;
    expect(await actor(reader,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(0);
    await db`update app.photos set expires_at=now()-interval '1 second' where id=${p}`;
    expect(await actor(owner,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(0);
    expect(await actor(owner,sql=>sql`select id from app.media_assets where id=${g.media}`)).toHaveLength(0);
    await actor(owner,sql=>sql`select app.delete_photo(${p})`);
    expect(await db`select id from app.media_assets where id=${g.media}`).toHaveLength(0);
    await expect(actor(owner,sql=>sql`select app.create_photo(${p},'2026-10-31'::date)`)).rejects.toThrow(/CONTENT_DELETED/);
  });
  it("does not revive direct photo access after reconnecting, while retaining a separate album path",async()=>{
    const owner=await member(),reader=await member();await connect(owner,reader);
    const p=await photo(owner),a=await create(owner);await change(owner,a,reader,"read",1);
    const direct=await grant(owner,p,[reader]),inAlbum=await grant(owner,p,[reader],a);
    await db`delete from app.connections where member_a=${[owner,reader].sort()[0]} and member_b=${[owner,reader].sort()[1]}`;
    await connect(owner,reader);
    expect(await actor(reader,sql=>sql`select id from app.photo_grants where id=${direct.id}`)).toHaveLength(0);
    expect(await actor(reader,sql=>sql`select id from app.photo_grants where id=${inAlbum.id}`)).toHaveLength(1);
    await db`delete from app.photo_grant_recipients where grant_id=${inAlbum.id} and member_id=${reader}`;
    const decision=await db`select sequence,id,occurred_at,decision from app.safety_journal where decision->>'action'='photo_recipient_remove' and decision->>'grant'=${inAlbum.id} and decision->>'member'=${reader}`;
    expect(decision).toHaveLength(1);
    await db`insert into app.photo_grant_recipients(grant_id,member_id) values(${inAlbum.id},${reader})`;
    await db`update app.safety_journal_state set restore_quarantined=true where id`;
    await db`select app.replay_safety_batch(${db.json(decision as any)})`;
    await db`update app.safety_journal_state set restore_quarantined=false where id`;
    expect(await actor(reader,sql=>sql`select id from app.photos where id=${p}`)).toHaveLength(0);
    // Replaying the restrictive decision is idempotent.
    await db`update app.safety_journal_state set restore_quarantined=true where id`;
    await db`select app.replay_safety_batch(${db.json(decision as any)})`;
    await db`update app.safety_journal_state set restore_quarantined=false where id`;
    expect(await actor(reader,sql=>sql`select id from app.media_assets where id=${inAlbum.media}`)).toHaveLength(0);
  });
  it("stores date-only values and rejects invalid dates, direct table mutation and metadata/attachment swaps",async()=>{
    const owner=await member(),p=await photo(owner);
    expect(await actor(owner,sql=>sql`select photo_date::text as day from app.photos where id=${p}`)).toMatchObject([{day:"2026-10-31"}]);
    await expect(actor(owner,sql=>sql`select app.create_photo(${randomUUID()},'2026-02-30'::date)`)).rejects.toThrow();
    await expect(actor(owner,sql=>sql`update app.photos set photo_date='2000-01-01' where id=${p}`)).rejects.toThrow(/permission denied/);
    await expect(actor(owner,sql=>sql`select app.add_photo_grant(${randomUUID()},${p},NULL,${sql.json({context:{}})},${randomUUID()})`)).rejects.toThrow(/ENVELOPE_CONTEXT/);
  });
});
