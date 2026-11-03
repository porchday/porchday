import type { Hono } from "hono";
import { z } from "zod";
import type { EncryptedEnvelope } from "@porchday/crypto";
import type { Db } from "./db.js";
import { envelopeSchema } from "./social-contract.js";
import type { RouteDependencies, SocialContext } from "./social-media.js";
import type { Env, Variables } from "./types.js";
interface Dependencies extends RouteDependencies {
  body<T>(
    c: SocialContext,
    schema: z.ZodType<T>,
    maxBytes?: number,
  ): Promise<T>;
  writeAllowed(db: Db): Promise<void>;
  checkEnvelope(
    db: Db,
    member: string,
    envelope: EncryptedEnvelope,
    kind: string,
    options?: { allowPast?: boolean },
  ): Promise<unknown>;
}
const uuid = z.string().uuid();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
  );
export function registerCalendarRoutes(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
  { tx, body, fail, id, writeAllowed, checkEnvelope }: Dependencies,
) {
  app.get("/children", async (c) =>
    c.json(
      await tx(c, async (db) => {
        const after = c.req.query("after")
          ? uuid.parse(c.req.query("after"))
          : null;
        const own =
          await db`select c.*,to_jsonb(c.delegates) as delegates,d.envelope as private_envelope from app.child_profiles c left join app.child_private_details d on d.child_id=c.id where c.owner_id=${c.get("memberId")} order by c.id limit 20`;
        const others =
          await db`select c.*,to_jsonb(c.delegates) as delegates,null::jsonb as private_envelope from app.child_profiles c where c.owner_id<>${c.get("memberId")} ${after ? db`and c.id>${after}::uuid` : db``} order by c.id limit 21`;
        const rows = [...own, ...others.slice(0, 20)];
        return {
          next_id: others.length > 20 ? others[19].id : null,
          items: rows.map((row) => ({
            ...row,
            can_post:
              row.owner_id === c.get("memberId") ||
              row.delegates.includes(c.get("memberId")),
            delegates: row.owner_id === c.get("memberId") ? row.delegates : [],
          })),
        };
      }),
    ),
  );
  app.put("/children/:id", async (c) => {
    const child = id(c.req.param("id")),
      member = c.get("memberId");
    const b = await body(
      c,
      z
        .object({
          envelope: envelopeSchema,
          private_envelope: envelopeSchema,
          delegates: z.array(uuid).max(30),
        })
        .strict(),
    );
    for (const [envelope, audience] of [
      [b.envelope, "connections"],
      [b.private_envelope, "only_me"],
    ] as const) {
      const e = envelope.context;
      if (
        e.id !== child ||
        e.audience !== audience ||
        e.groupId !== null ||
        e.parentId !== null ||
        e.expiresAt !== null
      )
        fail("ENVELOPE_CONTEXT");
    }
    return c.json(
      await tx(c, async (db) => {
        await writeAllowed(db);
        await checkEnvelope(db, member, b.envelope, "profile", {
          allowPast: true,
        });
        await checkEnvelope(db, member, b.private_envelope, "profile", {
          allowPast: true,
        });
        const [old] =
          await db`select owner_id,revision from app.child_profiles where id=${child} for update`;
        if (old && old.owner_id !== member) fail("FORBIDDEN", 403);
        const revision = (old?.revision ?? 0) + 1;
        if (
          b.envelope.context.revision !== revision ||
          b.private_envelope.context.revision !== revision
        )
          fail("REVISION_CHANGED", 409);
        const delegates = [...new Set(b.delegates)];
        for (const delegate of delegates) {
          const [r] =
            await db`select app.connected(${member}::uuid,${delegate}::uuid) as ok`;
          if (!r.ok) fail("FORBIDDEN", 403);
        }
        if (old)
          await db`update app.child_profiles set envelope=${db.json(b.envelope)},revision=${revision},delegates=array(select jsonb_array_elements_text(${db.json(delegates)}))::uuid[] where id=${child}`;
        else {
          const [count] =
            await db`select count(*)::int as n from app.child_profiles where owner_id=${member}`;
          if (count.n >= 20) fail("CHILD_LIMIT", 409);
          await db`insert into app.child_profiles(id,owner_id,envelope,revision,delegates) values(${child},${member},${db.json(b.envelope)},${revision},array(select jsonb_array_elements_text(${db.json(delegates)}))::uuid[])`;
        }
        await db`insert into app.child_private_details(child_id,owner_id,envelope) values(${child},${member},${db.json(b.private_envelope)}) on conflict(child_id) do update set envelope=excluded.envelope`;
        return { ok: true, revision };
      }),
    );
  });
  app.delete("/children/:id", async (c) =>
    c.json(
      await tx(c, async (db) => {
        await writeAllowed(db);
        await db`select app.lock_epoch()`;
        const rows =
          await db`delete from app.child_profiles where id=${id(c.req.param("id"))} and owner_id=${c.get("memberId")} returning id`;
        if (!rows.length) fail("NOT_FOUND", 404);
        return { ok: true };
      }),
    ),
  );
  app.get("/calendar", async (c) => {
    const start = z
        .string()
        .datetime({ offset: true })
        .parse(c.req.query("start")),
      end = z.string().datetime({ offset: true }).parse(c.req.query("end"));
    if (
      Date.parse(end) <= Date.parse(start) ||
      Date.parse(end) - Date.parse(start) > 32 * 86400000
    )
      fail("INVALID_RANGE");
    const afterAt = c.req.query("after_at"),
      afterId = c.req.query("after_id");
    if (afterAt) z.string().datetime({ offset: true }).parse(afterAt);
    if (afterId) uuid.parse(afterId);
    if (Boolean(afterAt) !== Boolean(afterId)) fail("INVALID_CURSOR");
    return c.json(
      await tx(c, async (db) => {
        const rows =
          await db`select p.*,app.author_category(p.author_id) as author_category,h.handle as author_handle from app.posts p left join lateral app.member_handles(array[p.author_id]) h on true
    where p.group_id is null and p.created_at>=${start}::timestamptz and p.created_at<${end}::timestamptz

    and not exists(select from app.mutes where target=p.author_id)
    ${afterAt ? db`and(p.created_at,p.id)<(${afterAt}::timestamptz,${afterId!}::uuid)` : db``}
    order by p.created_at desc,p.id desc limit 51`;
        const items = rows.slice(0, 50),
          last = items.at(-1);
        return {
          items,
          next:
            rows.length > 50 && last
              ? { at: new Date(last.created_at).toISOString(), id: last.id }
              : null,
        };
      }),
    );
  });
  app.get("/calendar/highlights", async (c) =>
    c.json(
      await tx(c, async (db) => ({
        items:
          await db`select day::text,post_id,media_id from app.calendar_highlights where member_id=${c.get("memberId")} and day>=${day.parse(c.req.query("start"))}::date and day<${day.parse(c.req.query("end"))}::date`,
      })),
    ),
  );
  app.put("/calendar/highlights/:day", async (c) => {
    const date = day.parse(c.req.param("day")),
      b = await body(c, z.object({ post_id: uuid, media_id: uuid.nullable() }));
    return c.json(
      await tx(c, async (db) => {
        await writeAllowed(db);
        const [p] = await db`select id from app.posts where id=${b.post_id}`;
        if (!p) fail("NOT_FOUND", 404);
        if (b.media_id) {
          const [m] =
            await db`select id from app.media_assets where post_id=${b.post_id} and id=${b.media_id}`;
          if (!m) fail("NOT_FOUND", 404);
        }
        await db`insert into app.calendar_highlights(member_id,day,post_id,media_id) values(${c.get("memberId")},${date}::date,${b.post_id},${b.media_id}) on conflict(member_id,day) do update set post_id=excluded.post_id,media_id=excluded.media_id`;
        return { ok: true };
      }),
    );
  });
  app.delete("/calendar/highlights/:day", async (c) =>
    c.json(
      await tx(c, async (db) => {
        await writeAllowed(db);
        await db`delete from app.calendar_highlights where member_id=${c.get("memberId")} and day=${day.parse(c.req.param("day"))}::date`;
        return { ok: true };
      }),
    ),
  );
}
