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
) {
  const { data: snapshot } = await call(
    p.id,
    "/audiences?audience=" + (override.audience ?? "only_me"),
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
      epoch: snapshot.epoch,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revision,
      ...override,
    },
    recipients: snapshot.devices.map((d: any) => ({
      memberId: d.member_id,
      deviceId: d.id,
      publicKey: d.public_key,
    })),
  });
}
suite("Encrypted calendar and child permissions", () => {
  beforeAll(async () => {
    const url = new URL(base!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      throw Error("Disposable loopback database required");
    admin = postgres(base!, { max: 1, prepare: false, onnotice: () => {} });
    name = "porchday_calendar_test_" + randomUUID().replaceAll("-", "");
    role = "calendar_test_" + randomUUID().replaceAll("-", "");
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

  async function connect(a: string, b: string) {
    await db`insert into app.connections(member_a,member_b,kind,kind_a,kind_b,history_a,history_b) values(${[a, b].sort()[0]},${[a, b].sort()[1]},'friend','friend','friend','full','full')`;
  }
  async function child(
    p: Awaited<ReturnType<typeof person>>,
    delegates: string[] = [],
    id = randomUUID(),
    revision = 1,
  ) {
    const envelope = await seal(p, { name: "Synthetic child" }, revision, {
        id,
        audience: "connections",
      }),
      private_envelope = await seal(p, { birthday: "2020-02-29" }, revision, {
        id,
      });
    return { id, body: { envelope, private_envelope, delegates } };
  }
  it("encrypts child details, exposes names only to connections, and never exposes birthdays or editing rights to delegates", async () => {
    const a = await person(),
      b = await person(),
      stranger = await person();
    await connect(a.id, b.id);
    const c = await child(a, [b.id]);
    expect((await call(a.id, "/children/" + c.id, "PUT", c.body)).status).toBe(
      200,
    );
    const exported = await call(a.id, "/exports", "POST");
    expect(exported.status).toBe(201);
    const page = await call(
      a.id,
      "/exports/" + exported.data.id + "?section=profile",
    );
    expect(page.data.profile.children[0]).toMatchObject({
      id: c.id,
      private_envelope: c.body.private_envelope,
    });
    const otherExport = await call(b.id, "/exports", "POST");
    expect(
      (await call(b.id, "/exports/" + otherExport.data.id + "?section=profile"))
        .data.profile.children,
    ).toEqual([]);
    const seen = (await call(b.id, "/children")).data.items.find(
      (r: any) => r.id === c.id,
    );
    expect(seen.private_envelope).toBeNull();
    expect(
      await decryptObject({
        envelope: seen.envelope,
        expectedContext: seen.envelope.context,
        privateKey: b.key,
        authorPublicKey: a.keys.publicKey,
      }),
    ).toEqual({ name: "Synthetic child" });
    await expect(
      decryptObject({
        envelope: c.body.private_envelope,
        expectedContext: c.body.private_envelope.context,
        privateKey: b.key,
        authorPublicKey: a.keys.publicKey,
      }),
    ).rejects.toThrow();
    expect((await call(stranger.id, "/children")).data.items).toEqual([]);
    expect((await call(b.id, "/children/" + c.id, "DELETE")).status).toBe(404);
    expect(
      await withMember(
        env,
        b.id,
        (tx) => tx`select * from app.child_private_details`,
      ),
    ).toHaveLength(0);
    expect(
      (
        await withMember(
          env,
          b.id,
          (tx) =>
            tx`update app.child_profiles set delegates='{}' where id=${c.id}`,
        )
      ).count,
    ).toBe(0);
    expect((await call(a.id, "/children/" + c.id, "PUT", c.body)).status).toBe(
      409,
    );
  });
  it("permits delegated posts with adult attribution, rejects revoked permission, and does not restore delegation after reconnecting", async () => {
    const a = await person(),
      b = await person();
    await connect(a.id, b.id);
    const c = await child(a, [b.id]);
    expect((await call(a.id, "/children/" + c.id, "PUT", c.body)).status).toBe(
      200,
    );
    const envelope = await seal(b, { text: "A moment" }, 1, {
      id: randomUUID(),
      kind: "post",
      audience: "connections",
    });
    const response = await call(b.id, "/posts", "POST", {
      envelope,
      on_behalf_of: c.id,
    });
    expect(response).toMatchObject({ status: 201 });
    expect(
      (await call(b.id, "/posts/" + envelope.context.id)).data.post,
    ).toMatchObject({ author_id: b.id, on_behalf_of: c.id });
    expect(
      (await call(b.id, "/posts", "POST", { envelope, on_behalf_of: c.id }))
        .status,
    ).toBe(201);
    expect(
      (await call(b.id, "/posts", "POST", { envelope, on_behalf_of: null }))
        .status,
    ).toBe(409);
    const updated = await child(a, [], c.id, 2);
    expect(
      (await call(a.id, "/children/" + c.id, "PUT", updated.body)).status,
    ).toBe(200);
    const denied = await seal(b, { text: "Not permitted" }, 1, {
      id: randomUUID(),
      kind: "post",
      audience: "connections",
    });
    expect(
      (
        await call(b.id, "/posts", "POST", {
          envelope: denied,
          on_behalf_of: c.id,
        })
      ).status,
    ).toBe(403);
    const restored = await child(a, [b.id], c.id, 3);
    expect(
      (await call(a.id, "/children/" + c.id, "PUT", restored.body)).status,
    ).toBe(200);
    await db`delete from app.connections where member_a=${[a.id, b.id].sort()[0]} and member_b=${[a.id, b.id].sort()[1]}`;
    await connect(a.id, b.id);
    expect(
      (await db`select delegates from app.child_profiles where id=${c.id}`)[0]
        .delegates,
    ).toEqual([]);
    const again = await seal(b, { text: "Still not permitted" }, 1, {
      id: randomUUID(),
      kind: "post",
      audience: "connections",
    });
    expect(
      (
        await call(b.id, "/posts", "POST", {
          envelope: again,
          on_behalf_of: c.id,
        })
      ).status,
    ).toBe(403);
  });
  it("keeps month reads bounded, honors visibility/blocks, and makes highlights personal with no extra access", async () => {
    const a = await person(),
      b = await person();
    await connect(a.id, b.id);
    const envelope = await seal(a, { text: "Moment", tags: [] }, 1, {
      id: randomUUID(),
      kind: "post",
      audience: "connections",
    });
    expect((await call(a.id, "/posts", "POST", { envelope })).status).toBe(201);
    const d = new Date(),
      start = new Date(d.getFullYear(), d.getMonth(), 1).toISOString(),
      end = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString(),
      range = "?" + new URLSearchParams({ start, end });
    expect(
      (await call(b.id, "/calendar" + range)).data.items.map((p: any) => p.id),
    ).toContain(envelope.context.id);
    expect(
      (
        await call(
          b.id,
          "/calendar?start=2020-01-01T00:00:00Z&end=2026-01-01T00:00:00Z",
        )
      ).status,
    ).toBe(400);
    const day = d.toLocaleDateString("en-CA"),
      choice = { post_id: envelope.context.id, media_id: null };
    expect(
      (await call(b.id, "/calendar/highlights/" + day, "PUT", choice)).status,
    ).toBe(200);
    const dates =
      "?start=" +
      new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString("en-CA") +
      "&end=" +
      new Date(d.getFullYear(), d.getMonth() + 1, 1).toLocaleDateString(
        "en-CA",
      );
    expect(
      (await call(a.id, "/calendar/highlights" + dates)).data.items,
    ).toEqual([]);
    expect(
      (await call(b.id, "/calendar/highlights" + dates)).data.items,
    ).toHaveLength(1);
    await db`insert into app.blocks(actor,target) values(${a.id},${b.id})`;
    expect((await call(b.id, "/calendar" + range)).data.items).toEqual([]);
    expect(
      (await call(b.id, "/calendar/highlights" + dates)).data.items,
    ).toEqual([]);
    expect(
      (await call(b.id, "/calendar/highlights/" + day, "PUT", choice)).status,
    ).toBe(404);
  });
  it("serializes concurrent parent changes and retains revocation and deletion evidence for restore", async () => {
    const a = await person(),
      b = await person();
    await connect(a.id, b.id);
    const c = await child(a, [b.id]);
    expect((await call(a.id, "/children/" + c.id, "PUT", c.body)).status).toBe(
      200,
    );
    const updates = await Promise.all([
      child(a, [], c.id, 2),
      child(a, [], c.id, 2),
    ]);
    expect(
      (
        await Promise.all(
          updates.map((u) => call(a.id, "/children/" + c.id, "PUT", u.body)),
        )
      )
        .map((r) => r.status)
        .sort(),
    ).toEqual([200, 409]);
    const events =
      await db`select sequence::text,id,occurred_at,decision from app.safety_journal where decision->>'id'=${c.id}`;
    expect(
      events.some(
        (r) =>
          r.decision.action === "child_delegate" && r.decision.member === b.id,
      ),
    ).toBe(true);
    expect((await call(a.id, "/children/" + c.id, "DELETE")).status).toBe(200);
    expect(
      await db`select * from app.child_private_details where child_id=${c.id}`,
    ).toHaveLength(0);
    const deleted =
      await db`select sequence::text,id,occurred_at,decision from app.safety_journal where decision->>'id'=${c.id} and decision->>'action'='delete'`;
    expect(deleted).toHaveLength(1);
    expect((await call(a.id, "/children/" + c.id, "PUT", c.body)).status).toBe(
      409,
    );
    // Simulate a stale restored child and replay the original revocation then deletion.
    await db`delete from app.deletion_ledger where kind='child_profiles' and object_id=${c.id}`;
    await db`insert into app.child_profiles(id,owner_id,envelope,revision,delegates) values(${c.id},${a.id},${db.json(c.body.envelope)},1,array[${b.id}]::uuid[])`;
    await db`update app.safety_journal_state set restore_quarantined=true where id`;
    try {
      await db`select app.replay_safety_batch(${db.json(events.filter((r) => r.decision.action === "child_delegate"))})`;
      expect(
        (await db`select delegates from app.child_profiles where id=${c.id}`)[0]
          .delegates,
      ).toEqual([]);
      await db`select app.replay_safety_batch(${db.json(deleted)})`;
      expect(
        await db`select * from app.child_profiles where id=${c.id}`,
      ).toHaveLength(0);
    } finally {
      await db`update app.safety_journal_state set restore_quarantined=false where id`;
    }
  });
});
