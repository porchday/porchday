import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  generateDeviceKeys,
  unlockPrivateKey,
  encryptObject,
  decryptObject,
  type ContentContext,
} from "@porchday/crypto";
import { createSocialRoutes } from "../src/social";
import { withMember } from "../src/db";
import type { Env, Variables } from "../src/types";

const base = process.env.TEST_DATABASE_URL,
  suite = base ? describe : describe.skip;
let admin: Sql, db: Sql, name: string, role: string, env: Env;
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", async (c, next) => {
  c.set("memberId", c.req.header("x-member")!);
  c.set("authTime", Date.now());
  await next();
});
app.route("/", createSocialRoutes());
async function call(
  member: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await app.request(
    "https://local.test" + path,
    {
      method,
      headers: { "x-member": member, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
  return { status: response.status, data: (await response.json()) as any };
}
async function person() {
  const id = randomUUID(),
    deviceId = randomUUID(),
    keys = await generateDeviceKeys(id, deviceId);
  await db`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`;
  await db`insert into app.profiles(member_id,handle) values(${id},${"e_" + id.replaceAll("-", "").slice(0, 20)})`;
  await db`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${deviceId},${id},${keys.publicKey},${keys.fingerprint},'{"type":"initial"}'::jsonb)`;
  return {
    id,
    deviceId,
    keys,
    key: await unlockPrivateKey(keys.encryptedPrivateKey, keys.recoverySecret),
  };
}
async function seal(
  p: Awaited<ReturnType<typeof person>>,
  payload: unknown,
  revision = 1,
  override: Partial<ContentContext> = {},
  change?: {memberId:string;role:string|null},
) {
  const { data: snapshot } = await call(
    p.id,
    override.audience === "album" ? `/albums/${override.groupId}/audience${change?"?"+new URLSearchParams({member_id:change.memberId,role:change.role??"remove"}):""}` : "/audiences?audience=" + (override.audience ?? "only_me"),
  );
  return encryptObject({
    payload,
    signingKey: p.key,
    context: {
      id: p.id,
      kind: "profile",
      authorId: p.id,
      authorDeviceId: p.deviceId,
      audience: "only_me",
      parentId: null,
      groupId: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revision,
      ...override,
      epoch: snapshot.epoch,
    },
    recipients: snapshot.devices.map((d: any) => ({
      memberId: d.member_id,
      deviceId: d.id,
      publicKey: d.public_key,
    })),
  });
}
suite("Encrypted social album API", () => {
  beforeAll(async () => {
    const url = new URL(base!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      throw Error("Disposable loopback database required");
    admin = postgres(base!, { max: 1, prepare: false, onnotice: () => {} });
    name = "porchday_album_http_test_" + randomUUID().replaceAll("-", "");
    role = "album_http_test_" + randomUUID().replaceAll("-", "");
    await admin.unsafe("CREATE DATABASE " + name);
    url.pathname = "/" + name;
    db = postgres(url.href, { max: 1, prepare: false, onnotice: () => {} });
    for (const file of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await db.unsafe(
        await readFile(
          new URL("../migrations/" + file, import.meta.url),
          "utf8",
        ),
      );
    await admin.unsafe(
      "CREATE ROLE " +
        role +
        " LOGIN PASSWORD 'synthetic-calendar-local' IN ROLE porchday_social",
    );
    url.username = role;
    url.password = "synthetic-calendar-local";
    env = { HYPERDRIVE_SOCIAL: { connectionString: url.href } } as Env;
  }, 60000);
  afterAll(async () => {
    if (db) await db.end();
    if (admin) {
      if (name)
        await admin.unsafe("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
      if (role) await admin.unsafe("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });

  async function create(owner: Awaited<ReturnType<typeof person>>) {
    const id=randomUUID();
    const envelope=await seal(owner,{name:"Weekend outside"},1,{id,kind:"album"});
    expect((await call(owner.id,"/albums","POST",{envelope})).status).toBe(201);
    return {id,envelope};
  }
  it("encrypts for the exact proposed membership, preserves existing readers, and denies outsiders",async()=>{
    const owner=await person(), reader=await person(), contributor=await person(), outsider=await person();
    const album=await create(owner);
    expect((await call(outsider.id,`/albums/${album.id}`)).status).toBe(404);
    expect((await call(outsider.id,`/albums/${album.id}/audience`)).status).toBe(404);
    const first=await seal(owner,{name:"Weekend outside"},2,{...album.envelope.context,kind:"album",audience:"album",groupId:album.id,revision:2},{memberId:reader.id,role:"read"});
    expect((await call(owner.id,`/albums/${album.id}/members/${reader.id}`,"PUT",{role:"read",expected_revision:1,envelope:first})).status).toBe(200);
    const read=await call(reader.id,`/albums/${album.id}`);
    expect(read.status).toBe(200);expect(read.data.album.role).toBe("read");
    expect((await decryptObject<any>({envelope:read.data.album.envelope,expectedContext:first.context,privateKey:reader.key,authorPublicKey:owner.keys.publicKey})).name).toBe("Weekend outside");
    await expect(decryptObject({envelope:first,expectedContext:first.context,privateKey:outsider.key,authorPublicKey:owner.keys.publicKey})).rejects.toThrow();
    const query=`?member_id=${outsider.id}&role=admin`;
    expect((await call(reader.id,`/albums/${album.id}/audience${query}`)).status).toBe(403);
    const next=await seal(owner,{name:"Weekend outside"},3,{...first.context,revision:3},{memberId:contributor.id,role:"add"});
    // Swapping the proposed target would give the wrong recipient the album key.
    expect((await call(owner.id,`/albums/${album.id}/members/${outsider.id}`,"PUT",{role:"add",expected_revision:2,envelope:next})).status).toBe(409);
    expect((await call(owner.id,`/albums/${album.id}/members/${contributor.id}`,"PUT",{role:"add",expected_revision:2,envelope:next})).status).toBe(200);
    const result=await call(reader.id,`/albums/${album.id}`);
    expect(result.data.members).toHaveLength(3);
    expect((await decryptObject<any>({envelope:result.data.album.envelope,expectedContext:next.context,privateKey:reader.key,authorPublicKey:owner.keys.publicKey})).name).toBe("Weekend outside");
    expect((await call(contributor.id,`/albums/${album.id}/members/${reader.id}`,"PUT",{role:"admin",expected_revision:2,envelope:next})).status).toBe(403);
    expect((await call(reader.id,`/albums/${album.id}/leave`,"POST")).status).toBe(200);
    expect((await call(reader.id,`/albums/${album.id}`)).status).toBe(404);
    expect((await call(reader.id,"/albums")).data.items).toHaveLength(0);
  });
  it("lets a second administrator rename metadata with their own retained signing identity",async()=>{
    const owner=await person(), admin=await person(), album=await create(owner);
    const shared=await seal(owner,{name:"Original"},2,{...album.envelope.context,audience:"album",groupId:album.id,revision:2},{memberId:admin.id,role:"admin"});
    expect((await call(owner.id,`/albums/${album.id}/members/${admin.id}`,"PUT",{role:"admin",expected_revision:1,envelope:shared})).status).toBe(200);
    const edited=await seal(admin,{name:"Renamed by collaborator"},3,{...shared.context,authorId:admin.id,authorDeviceId:admin.deviceId,revision:3});
    expect((await call(admin.id,`/albums/${album.id}`,"PUT",{expected_revision:2,envelope:edited})).status).toBe(200);
    const result=await call(owner.id,`/albums/${album.id}`);
    expect(result.data.album.author_key.member_id).toBe(admin.id);
    expect((await decryptObject<any>({envelope:result.data.album.envelope,expectedContext:edited.context,privateKey:owner.key,authorPublicKey:result.data.album.author_key.public_key})).name).toBe("Renamed by collaborator");
    expect((await call(owner.id,`/albums/${album.id}`,"PUT",{expected_revision:2,envelope:edited})).status).toBe(409);
  });
  it("rejects stale snapshots, unknown keys, unexpected contexts and stale revisions",async()=>{
    const owner=await person(), reader=await person(), album=await create(owner);
    const next=await seal(owner,{name:"Private album"},2,{...album.envelope.context,audience:"album",groupId:album.id,revision:2},{memberId:reader.id,role:"read"});
    const route=`/albums/${album.id}/members/${reader.id}`;
    await db`update app.directory_epoch set epoch=epoch+1 where id`;
    expect((await call(owner.id,route,"PUT",{role:"read",expected_revision:1,envelope:next})).status).toBe(409);
    const fresh=await seal(owner,{name:"Private album"},2,{...next.context},{memberId:reader.id,role:"read"});
    expect((await call(owner.id,route,"PUT",{role:"read",expected_revision:7,envelope:fresh})).status).toBe(409);
    const invalid={...fresh,context:{...fresh.context,parentId:randomUUID()}};
    expect((await call(owner.id,route,"PUT",{role:"read",expected_revision:1,envelope:invalid})).status).toBe(400);
    await db`update app.device_keys set revoked_at=now() where id=${owner.deviceId}`;
    expect((await call(owner.id,route,"PUT",{role:"read",expected_revision:1,envelope:fresh})).status).toBe(403);
    expect((await call(reader.id,`/albums/${album.id}`)).status).toBe(404);
  });
  it("retains metadata signature verification after ownership transfer and original-author deletion",async()=>{
    const owner=await person(), successor=await person(), album=await create(owner);
    const envelope=await seal(owner,{name:"Kept album"},2,{...album.envelope.context,audience:"album",groupId:album.id,revision:2},{memberId:successor.id,role:"admin"});
    expect((await call(owner.id,`/albums/${album.id}/members/${successor.id}`,"PUT",{role:"admin",expected_revision:1,envelope})).status).toBe(200);
    expect((await call(owner.id,`/albums/${album.id}/transfer`,"POST",{member_id:successor.id})).status).toBe(200);
    // Account deletion is simulated at SQL here, not claimed as full HTTP acceptance.
    await db`delete from app.members where id=${owner.id}`;
    const result=await call(successor.id,`/albums/${album.id}`);
    expect(result.status).toBe(200);
    expect(result.data.album.author_key.member_id).toBe(owner.id);
    expect((await decryptObject<any>({envelope:result.data.album.envelope,expectedContext:envelope.context,privateKey:successor.key,authorPublicKey:result.data.album.author_key.public_key})).name).toBe("Kept album");
  });
});
