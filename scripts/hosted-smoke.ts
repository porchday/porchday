/** Hosted staging only. No operator credentials, SQL fixtures, mail-token bypass, or browser automation. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import {
  generateDeviceKeys,
  unlockPrivateKey,
  encryptObject,
  decryptObject,
  createReactionSecret,
  reactionTag,
  type ContentContext,
  type EncryptedEnvelope,
  type UnlockedPrivateKey,
} from "../packages/crypto/src/index.js";
import {
  check,
  readPrivate,
  writePrivate,
  SmokeClient,
  SmokeError,
  stagingOrigin,
  verificationTarget,
} from "./hosted-smoke-support.js";

type Keys = Awaited<ReturnType<typeof generateDeviceKeys>>;
type Account = {
  email: string;
  inviteCode: string;
  password: string;
  handle: string;
  id?: string;
  signedUp?: boolean;
  deleted?: boolean;
  device?: { id: string; keys: Keys; recovery: Keys; enrolled?: boolean };
};
type State = {
  v: 1;
  synthetic: true;
  origin: string;
  run: string;
  accounts: Account[];
  socialStarted?: boolean;
  socialPassed?: boolean;
  interop?: {
    webPostId: string;
    webMediaId: string;
    nativePostId: string;
    nativeMediaId: string;
    expectedPostText: string;
    expectedMediaSHA256: string;
    nativeText: string;
    expiresAt: string;
    prepared?: boolean;
    passed?: boolean;
  };
};
type Person = { account: Account; api: SmokeClient; key: UnlockedPrivateKey };
const directory = "artifacts/private/hosted-smoke/";
const statePath = directory + "state.json";
const phase = process.argv[2];
const allowed = [
  "init",
  "public",
  "signup",
  "verify",
  "social",
  "interop-prepare",
  "interop-check",
  "cleanup",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function progress(step: string) {
  console.log(JSON.stringify({ phase, step }));
}
async function state(): Promise<State> {
  const value = await readPrivate<State>(statePath);
  check(
    value.v === 1 &&
      value.synthetic === true &&
      value.origin === stagingOrigin &&
      /^[a-f0-9]{10}$/.test(value.run),
    "SYNTHETIC_STATE_REQUIRED",
  );
  check(
    value.accounts.length === 3 &&
      new Set(value.accounts.map((a) => a.email)).size === 3,
    "THREE_DISTINCT_TEST_ACCOUNTS_REQUIRED",
  );
  for (const a of value.accounts)
    check(
      a.handle.startsWith("qa_" + value.run + "_") &&
        !!a.email &&
        a.password.length >= 32,
      "SYNTHETIC_ACCOUNT_INVALID",
    );
  return value;
}
const persist = (value: State) => writePrivate(statePath, value);

async function initialize() {
  const input = await readPrivate<{
    synthetic: boolean;
    origin: string;
    accounts: { email: string; inviteCode: string }[];
  }>(directory + "input.json");
  check(
    input.synthetic === true &&
      input.origin === stagingOrigin &&
      input.accounts.length === 3,
    "SYNTHETIC_STAGING_INPUT_REQUIRED",
  );
  const run = randomBytes(5).toString("hex");
  const accounts = input.accounts.map((a, index) => {
    const email = a.email.trim().toLowerCase();
    check(
      /^[^\s@]+\+porchday-[^\s@]+@[^\s@]+$/.test(email) &&
        a.inviteCode.length >= 24,
      "SYNTHETIC_MAIL_ALIAS_AND_INVITE_REQUIRED",
    );
    return {
      email,
      inviteCode: a.inviteCode,
      handle: `qa_${run}_${index}`,
      password: randomBytes(36).toString("base64url"),
    };
  });
  check(
    new Set(accounts.map((a) => a.email)).size === 3,
    "THREE_DISTINCT_TEST_ACCOUNTS_REQUIRED",
  );
  await writePrivate(
    statePath,
    {
      v: 1,
      synthetic: true,
      origin: stagingOrigin,
      run,
      accounts,
    } satisfies State,
    true,
  );
}

async function publicChecks() {
  const api = new SmokeClient();
  const home = await api.request("/");
  check(
    home.status === 200 &&
      home.headers.get("content-type")?.includes("text/html"),
    "PUBLIC_HTML_MISSING",
  );
  check(
    home.headers
      .get("content-security-policy")
      ?.includes("default-src 'self'") &&
      home.headers
        .get("content-security-policy")
        ?.includes("frame-ancestors 'none'"),
    "CSP_MISSING",
  );
  check(
    home.headers.get("referrer-policy") === "no-referrer",
    "REFERRER_POLICY_MISSING",
  );
  const html = await home.text();
  check(
    html.includes("Porchday") && /\/assets\/[^"']+\.js/.test(html),
    "CLIENT_ENTRY_MISSING",
  );
  const scriptPaths = [
    ...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+\.(?:js|css))"/g),
  ].map((match) => match[1]);
  check(scriptPaths.length > 0, "CLIENT_ASSETS_MISSING");
  for (const path of scriptPaths) {
    const response = await api.request(path);
    check(
      response.status === 200 &&
        !response.headers.get("content-type")?.includes("text/html"),
      "CLIENT_ASSET_NOT_SERVED",
    );
    await response.arrayBuffer();
  }
  const health = await api.json("/health");
  check(
    health.service === "porchday" && health.environment === "staging",
    "STAGING_HEALTH_MISMATCH",
  );
  check(
    (await api.request("/api/v1/me")).status === 401,
    "UNAUTHENTICATED_MEMBER_ACCESS",
  );
  check(
    (await api.request("/api/operations/health")).status === 401,
    "OPERATIONS_HEALTH_UNPROTECTED",
  );
  for (const route of [
    "/api/staff/recovery/cases",
    "/api/staff/moderation/reports",
  ]) {
    check(
      [401, 403, 302].includes((await api.request(route)).status),
      "STAFF_ROUTE_UNPROTECTED",
    );
  }
  const manifest = await api.json("/manifest.webmanifest");
  check(
    manifest.start_url === "/app" &&
      manifest.scope === "/" &&
      manifest.display === "standalone",
    "PWA_MANIFEST_INVALID",
  );
  for (const icon of manifest.icons) {
    check(
      ["/icon-192.png", "/icon-512.png"].includes(icon.src),
      "PWA_ICON_UNEXPECTED",
    );
    const response = await api.request(icon.src);
    check(
      response.status === 200 &&
        response.headers.get("content-type")?.includes("image/png"),
      "PWA_ICON_MISSING",
    );
    await response.arrayBuffer();
  }
  const worker = await api.request("/sw.js");
  check(
    worker.status === 200 &&
      /javascript/.test(worker.headers.get("content-type") || ""),
    "PWA_WORKER_MISSING",
  );
  check(
    !(worker.headers.get("cache-control") || "").includes("immutable"),
    "PWA_WORKER_IMMUTABLE",
  );
  await worker.text();
  check(
    (await api.request("/third-party-notices.txt")).status === 200,
    "LICENSE_NOTICES_MISSING",
  );
  progress("public-delivery-and-protection-passed");
}

async function signup(s: State) {
  for (const a of s.accounts) {
    if (a.signedUp) continue;
    const api = new SmokeClient();
    const data = await api.json("/api/auth/sign-up/email", "POST", {
      email: a.email,
      password: a.password,
      handle: a.handle,
      name: a.handle,
      inviteCode: a.inviteCode,
      adult: true,
      acceptedRules: true,
    });
    check(uuid.test(data.user?.id), "SIGNUP_ID_MISSING");
    a.id = data.user.id;
    a.signedUp = true;
    await persist(s);
    check(
      (await api.request("/api/v1/me")).status === 401,
      "UNVERIFIED_SESSION_GRANTED",
    );
    // An unverified sign-in intentionally sends another verification message.
    // Local auth tests cover that denial; avoid duplicating the owner's mail here.
  }
  progress("waiting-for-real-mailbox-verification");
}

async function verify() {
  // These links must come from delivered mailbox messages, never SQL/outbox reads.
  const input = await readPrivate<{ source: string; links: string[] }>(
    directory + "verification-links.json",
  );
  check(
    input.source === "delivered-mailbox" && input.links.length === 3,
    "DELIVERED_MAILBOX_LINKS_REQUIRED",
  );
  for (const link of input.links) {
    const path = verificationTarget(link),
      api = new SmokeClient();
    const response = await api.request(path);
    check(response.status === 302, "VERIFICATION_FAILED");
    const location = new URL(
      response.headers.get("location") || "",
      stagingOrigin,
    );
    check(
      location.origin === stagingOrigin &&
        location.pathname === "/login" &&
        !location.searchParams.has("error"),
      "VERIFICATION_CALLBACK_FAILED",
    );
    const repeated = await api.request(path);
    check(
      repeated.status >= 400 && repeated.status < 500,
      "EMAIL_LINK_REPLAY_ALLOWED",
    );
  }
  progress("delivered-email-links-verified");
}

async function login(a: Account): Promise<SmokeClient> {
  check(!a.deleted, "ACCOUNT_ALREADY_DELETED");
  const api = new SmokeClient();
  await api.json("/api/auth/sign-in/email", "POST", {
    email: a.email,
    password: a.password,
  });
  const session = await api.json("/api/auth/get-session");
  check(
    session?.user?.email?.toLowerCase() === a.email &&
      session?.user?.emailVerified === true,
    "VERIFIED_IDENTITY_MISMATCH",
  );
  const me = await api.json("/api/v1/me");
  check(
    uuid.test(me.id) &&
      me.handle === a.handle &&
      (!a.id || me.id === a.id) &&
      me.status === "active",
    "MEMBER_IDENTITY_MISMATCH",
  );
  a.id = me.id;
  return api;
}

async function enroll(s: State, a: Account, api: SmokeClient): Promise<Person> {
  if (!a.device) {
    const id = randomUUID(),
      keys = await generateDeviceKeys(a.id!, id);
    const recovery = await generateDeviceKeys(
      a.id!,
      "recovery",
      keys.recoverySecret,
    );
    a.device = { id, keys, recovery };
    await persist(s);
  }
  const d = a.device;
  if (!d.enrolled) {
    await api.json(
      "/api/v1/devices",
      "POST",
      {
        id: d.id,
        public_key: d.keys.publicKey,
        fingerprint: d.keys.fingerprint,
        authorization: { type: "initial" },
        recovery_public_key: d.recovery.publicKey,
        backup: {
          v: 1,
          devices: [
            {
              id: d.id,
              public_key: d.keys.publicKey,
              fingerprint: d.keys.fingerprint,
              encrypted_private_key: d.keys.encryptedPrivateKey,
            },
          ],
          recovery: {
            public_key: d.recovery.publicKey,
            fingerprint: d.recovery.fingerprint,
            encrypted_private_key: d.recovery.encryptedPrivateKey,
          },
        },
      },
      201,
    );
    d.enrolled = true;
    await persist(s);
  }
  return {
    account: a,
    api,
    key: await unlockPrivateKey(
      d.keys.encryptedPrivateKey,
      d.keys.recoverySecret,
    ),
  };
}

async function seal(
  p: Person,
  payload: unknown,
  context: Partial<ContentContext> = {},
  postId?: string,
) {
  const query = new URLSearchParams({
    audience: context.audience || "connections",
  });
  if (context.groupId) query.set("group_id", context.groupId);
  if (postId) query.set("post_id", postId);
  const audience = await p.api.json("/api/v1/audiences?" + query);
  check(!audience.pending_members?.length, "AUDIENCE_KEYS_NOT_READY");
  return encryptObject({
    payload,
    signingKey: p.key,
    context: {
      id: randomUUID(),
      kind: "post",
      authorId: p.account.id!,
      authorDeviceId: p.account.device!.id,
      audience: "connections",
      parentId: null,
      groupId: null,
      epoch: audience.epoch,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revision: 1,
      ...context,
    },
    recipients: audience.devices.map((d: any) => ({
      memberId: d.member_id,
      deviceId: d.id,
      publicKey: d.public_key,
    })),
  });
}
const decrypt = (
  recipient: Person,
  author: Person,
  envelope: EncryptedEnvelope,
) =>
  decryptObject<Record<string, any>>({
    envelope,
    expectedContext: envelope.context,
    privateKey: recipient.key,
    authorPublicKey: author.account.device!.keys.publicKey,
  });
async function connect(a: Person, b: Person) {
  const request = await a.api.json(
    "/api/v1/connections/requests",
    "POST",
    { handle: b.account.handle, kind: "friend" },
    201,
  );
  await b.api.json(
    "/api/v1/connections/requests/" + request.id + "/accept",
    "POST",
    {},
  );
}
async function publish(
  p: Person,
  envelope: EncryptedEnvelope,
  media: string[] = [],
) {
  await p.api.json(
    "/api/v1/posts",
    "POST",
    { envelope, media_ids: media },
    201,
  );
  return envelope.context.id;
}

async function social(s: State) {
  check(!s.socialStarted, "SOCIAL_RUN_ALREADY_STARTED_USE_CLEANUP");
  // Finish every mailbox/identity check before touching keys or relationships.
  const sessions: SmokeClient[] = [];
  for (const account of s.accounts) sessions.push(await login(account));
  await persist(s);
  s.socialStarted = true;
  await persist(s);
  const people: Person[] = [];
  for (let i = 0; i < s.accounts.length; i++)
    people.push(await enroll(s, s.accounts[i], sessions[i]));
  const [a, b, c] = people;
  await connect(a, b);
  const oldPayload = {
    text: "Synthetic hosted check: historical recipients",
    reactionSecret: createReactionSecret(),
  };
  const oldPost = await seal(a, oldPayload),
    oldId = await publish(a, oldPost);
  check(
    (
      await decrypt(
        b,
        a,
        (await b.api.json("/api/v1/posts/" + oldId)).post.envelope,
      )
    ).text === oldPayload.text,
    "FRIEND_DECRYPTION_FAILED",
  );
  check(
    (await c.api.request("/api/v1/posts/" + oldId)).status === 404,
    "STRANGER_POST_VISIBLE",
  );
  let forbiddenDecryption = false;
  try {
    await decrypt(c, a, oldPost);
  } catch {
    forbiddenDecryption = true;
  }
  check(forbiddenDecryption, "UNINTENDED_RECIPIENT_DECRYPTED");
  await connect(a, c);
  check(
    (await c.api.request("/api/v1/posts/" + oldId)).status === 404,
    "NEW_FRIEND_HISTORICAL_ACCESS",
  );
  progress("recipient-isolation-and-history-passed");

  const profilePayload = {
    displayName: "Synthetic Porchday QA",
    bio: "Disposable staging fixture",
    interests: "Friends and photos",
    theme: "scrapbook",
    accent: "#27574a",
  };
  await a.api.json("/api/v1/profiles/me", "PUT", {
    envelope: await seal(a, profilePayload, {
      id: a.account.id,
      kind: "profile",
    }),
  });
  const profile = await b.api.json("/api/v1/profiles/member/" + a.account.id);
  check(
    (await decrypt(b, a, profile.envelope)).theme === profilePayload.theme,
    "ENCRYPTED_PROFILE_FAILED",
  );

  const photoId = randomUUID();
  const postPayload = {
    text: "Synthetic shared photo",
    reactionSecret: createReactionSecret(),
    media: [
      {
        id: photoId,
        mime: "image/jpeg",
        alt: "Synthetic sample",
        width: 16,
        height: 16,
      },
    ],
  };
  const postEnvelope = await seal(a, postPayload),
    postId = postEnvelope.context.id;
  const photoBytes = await readFile(
    new URL(
      "../docs/archive/sample/photos/77777777-7777-4777-8777-777777777777.jpg",
      import.meta.url,
    ),
  );
  const photo = await seal(
    a,
    {
      mime: "image/jpeg",
      bytes: photoBytes.toString("base64"),
      alt: "Synthetic sample",
      width: 16,
      height: 16,
    },
    { id: photoId, kind: "media", parentId: postId },
  );
  const encodedPhoto = new TextEncoder().encode(JSON.stringify(photo));
  const reservation = await a.api.json(
    "/api/v1/media",
    "POST",
    { id: photo.context.id, envelope: photo, byte_size: encodedPhoto.length },
    201,
  );
  check(
    (await a.api.request(reservation.upload_url, "PUT", encodedPhoto))
      .status === 200,
    "ENCRYPTED_MEDIA_UPLOAD_FAILED",
  );
  await publish(a, postEnvelope, [photo.context.id]);
  const fetchedPhoto = await b.api.json<EncryptedEnvelope>(
    "/api/v1/media/" + photo.context.id + "/bytes",
  );
  check(
    (await decrypt(b, a, fetchedPhoto)).bytes === photoBytes.toString("base64"),
    "ENCRYPTED_MEDIA_ROUNDTRIP_FAILED",
  );
  const anonymous = new SmokeClient();
  check(
    (await anonymous.request("/api/v1/media/" + photo.context.id + "/bytes"))
      .status === 401,
    "PUBLIC_MEDIA_ACCESS",
  );

  const commentPayload = {
    text: "Comment from someone outside your own friend list",
    reactionSecret: createReactionSecret(),
  };
  const comment = await seal(
    c,
    commentPayload,
    { kind: "comment", parentId: postId },
    postId,
  );
  await c.api.json(
    "/api/v1/posts/" + postId + "/comments",
    "POST",
    { envelope: comment, parent_expires_at: null },
    201,
  );
  const detail = await b.api.json("/api/v1/posts/" + postId);
  const seen = detail.comments.find(
    (row: any) => row.id === comment.context.id,
  );
  check(
    seen && (await decrypt(b, c, seen.envelope)).text === commentPayload.text,
    "NONFRIEND_CONTEXTUAL_COMMENT_FAILED",
  );
  for (const [kind, targetId, secret] of [
    ["posts", postId, postPayload.reactionSecret],
    ["comments", comment.context.id, commentPayload.reactionSecret],
  ] as const) {
    const tags: string[] = [];
    for (const emoji of ["like", "heart"]) {
      const tag = await reactionTag({
        secret,
        targetId,
        memberId: b.account.id!,
        emoji,
      });
      tags.push(tag);
      const envelope = await seal(
        b,
        { emoji },
        { id: tag, kind: "reaction", parentId: targetId },
        postId,
      );
      for (let n = 0; n < 2; n++)
        await b.api.json(
          `/api/v1/${kind}/${targetId}/reactions/${tag}`,
          "PUT",
          { envelope },
        );
    }
    const response = await b.api.json("/api/v1/posts/" + postId);
    const rows =
      kind === "posts" ? response.reactions : response.comment_reactions;
    check(
      rows.filter((row: any) => row.member_id === b.account.id).length === 2,
      "MULTI_REACTION_IDEMPOTENCE_FAILED",
    );
    for (const row of rows)
      check(
        ["like", "heart"].includes((await decrypt(a, b, row.envelope)).emoji),
        "REACTION_DECRYPTION_FAILED",
      );
    await b.api.json(
      `/api/v1/${kind}/${targetId}/reactions/${tags[0]}`,
      "DELETE",
    );
    const after = await b.api.json("/api/v1/posts/" + postId);
    check(
      (kind === "posts" ? after.reactions : after.comment_reactions).length ===
        1,
      "INDEPENDENT_REACTION_REMOVAL_FAILED",
    );
  }
  const feed = await b.api.json("/api/v1/feed");
  const feedIds = feed.items.map((row: any) => row.id);
  check(
    feedIds.includes(postId) &&
      feedIds.includes(oldId) &&
      feedIds.indexOf(postId) < feedIds.indexOf(oldId) &&
      new Set(feedIds).size === feedIds.length,
    "CHRONOLOGICAL_FEED_FAILED",
  );
  progress("profile-photo-contextual-comments-and-reactions-passed");

  const groupEnvelope = await seal(
    a,
    {
      name: "Synthetic private group",
      description: "Disposable staging fixture",
    },
    { kind: "group", audience: "only_me" },
  );
  const groupId = groupEnvelope.context.id;
  await a.api.json("/api/v1/groups", "POST", { envelope: groupEnvelope }, 201);
  const invitation = await a.api.json(
    "/api/v1/groups/" + groupId + "/invitations",
    "POST",
    { handle: b.account.handle },
    201,
  );
  await b.api.json(
    "/api/v1/group-invitations/" + invitation.id + "/accept",
    "POST",
    {},
  );
  const groupPost = await seal(
    a,
    { text: "Private group fixture", reactionSecret: createReactionSecret() },
    { audience: "group", groupId },
  );
  await publish(a, groupPost);
  check(
    (
      await decrypt(
        b,
        a,
        (await b.api.json("/api/v1/posts/" + groupPost.context.id)).post
          .envelope,
      )
    ).text === "Private group fixture",
    "GROUP_CONTENT_FAILED",
  );
  check(
    (await c.api.request("/api/v1/posts/" + groupPost.context.id)).status ===
      404,
    "GROUP_OUTSIDER_ACCESS",
  );
  await a.api.json(
    `/api/v1/groups/${groupId}/members/${b.account.id}`,
    "DELETE",
  );
  check(
    (await b.api.request("/api/v1/posts/" + groupPost.context.id)).status ===
      404,
    "REMOVED_GROUP_MEMBER_ACCESS",
  );
  await a.api.json("/api/v1/groups/" + groupId, "DELETE");

  const exportJob = await a.api.json("/api/v1/exports", "POST", {}, 201);
  const exported = await a.api.json(
    `/api/v1/exports/${exportJob.id}?section=posts`,
  );
  const own = exported.posts.find((row: any) => row.id === postId);
  check(
    own && exported.posts.every((row: any) => row.author_id === a.account.id),
    "EXPORT_OWNERSHIP_FAILED",
  );
  const plain = await decrypt(a, a, own.envelope);
  check(plain.text === postPayload.text, "EXPORT_DECRYPTION_FAILED");
  // This focused check imports text only. Full multipart/photo ZIP import is browser QA.
  const imported = await seal(
    a,
    { ...plain, media: [], provenance: { sourceId: postId } },
    { audience: "only_me" },
  );
  const importBody = {
    id: randomUUID(),
    posts: [
      {
        envelope: imported,
        source_id: "hosted-smoke:" + postId,
        media_ids: [],
      },
    ],
  };
  check(
    (await a.api.json("/api/v1/imports", "POST", importBody, 201)).imported
      .length === 1,
    "IMPORT_FAILED",
  );
  check(
    (await a.api.json("/api/v1/imports", "POST", importBody, 201)).imported
      .length === 0,
    "IMPORT_RETRY_DUPLICATED",
  );
  check(
    (await b.api.request("/api/v1/posts/" + imported.context.id)).status ===
      404,
    "IMPORTED_PRIVATE_JOURNAL_VISIBLE",
  );
  await a.api.json(`/api/v1/exports/${exportJob.id}/validate`, "POST", {
    items: [
      {
        kind: "post",
        id: own.export_id,
        revision: own.envelope.context.revision,
        expires_at: own.expires_at,
      },
    ],
  });
  await a.api.json("/api/v1/posts/" + postId, "DELETE");
  check(
    (
      await a.api.request(`/api/v1/exports/${exportJob.id}/validate`, "POST", {
        items: [
          {
            kind: "post",
            id: own.export_id,
            revision: own.envelope.context.revision,
            expires_at: own.expires_at,
          },
        ],
      })
    ).status === 409,
    "DELETED_EXPORT_STILL_VALID",
  );
  check(
    (await b.api.request("/api/v1/media/" + photo.context.id + "/bytes"))
      .status === 404,
    "DELETED_PHOTO_STILL_ACCESSIBLE",
  );
  progress("groups-and-portability-api-passed");

  const expiry = new Date(Date.now() + 20_000).toISOString();
  const timed = await seal(
    a,
    {
      text: "This synthetic post expires",
      reactionSecret: createReactionSecret(),
    },
    { expiresAt: expiry },
  );
  await publish(a, timed);
  const reply = await seal(
    b,
    {
      text: "Inherits the reviewed deadline",
      reactionSecret: createReactionSecret(),
    },
    { kind: "comment", parentId: timed.context.id, expiresAt: expiry },
    timed.context.id,
  );
  check(
    (
      await b.api.request(
        "/api/v1/posts/" + timed.context.id + "/comments",
        "POST",
        { envelope: reply, parent_expires_at: null },
      )
    ).status === 409,
    "STALE_DEADLINE_ACK_ACCEPTED",
  );
  await b.api.json(
    "/api/v1/posts/" + timed.context.id + "/comments",
    "POST",
    { envelope: reply, parent_expires_at: expiry },
    201,
  );
  await wait(Math.max(0, Date.parse(expiry) - Date.now()) + 500);
  check(
    (await b.api.request("/api/v1/posts/" + timed.context.id)).status === 404,
    "EXPIRED_POST_STILL_VISIBLE",
  );
  const afterExpiry = await b.api.json("/api/v1/feed");
  check(
    !afterExpiry.items.some((row: any) => row.id === timed.context.id),
    "EXPIRED_POST_IN_FEED",
  );

  await a.api.json("/api/v1/blocks/" + b.account.id, "PUT", {});
  check(
    (await b.api.request("/api/v1/posts/" + oldId)).status === 404,
    "BLOCKED_MEMBER_ACCESS",
  );
  for (const p of people) {
    const oldCookie = p.api.cookieHeader();
    await p.api.json("/api/auth/sign-out", "POST", {});
    check(
      (await p.api.request("/api/v1/me", "GET", undefined, oldCookie))
        .status === 401,
      "REVOKED_SESSION_ACCESS",
    );
  }
  s.socialPassed = true;
  await persist(s);
  progress("expiry-block-and-session-revocation-passed");
}

async function cleanup(s: State) {
  let failures = 0;
  for (const account of s.accounts) {
    if (account.deleted) continue;
    try {
      const api = await login(account);
      const groups = await api.json("/api/v1/owned-groups");
      for (const group of groups.items)
        await api.json("/api/v1/groups/" + group.id, "DELETE");
      await api.json("/api/v1/account", "DELETE", { confirm: "DELETE" });
      check(
        (await api.request("/api/v1/me")).status === 401,
        "DELETED_ACCOUNT_SESSION_LIVE",
      );
      account.deleted = true;
      await persist(s);
    } catch {
      failures++;
    }
  }
  check(failures === 0, "SYNTHETIC_ACCOUNT_CLEANUP_REQUIRES_ATTENTION");
  progress("synthetic-account-deletion-requested");
}

async function prepareInterop(s: State) {
  check(
    s.socialPassed && !s.interop,
    "FINISHED_SOCIAL_RUN_AND_NEW_INTEROP_REQUIRED",
  );
  const a = s.accounts[0],
    c = s.accounts[2];
  check(a.device?.enrolled && c.device?.enrolled, "INTEROP_DEVICES_REQUIRED");
  const api = await login(a);
  try {
    const author = await enroll(s, a, api);
    const bytes = await readFile(
      new URL(
        "../docs/archive/sample/photos/77777777-7777-4777-8777-777777777777.jpg",
        import.meta.url,
      ),
    );
    const fixture: NonNullable<State["interop"]> = {
      webPostId: randomUUID(),
      webMediaId: randomUUID(),
      nativePostId: randomUUID(),
      nativeMediaId: randomUUID(),
      expectedPostText: "Synthetic web-to-native interoperability " + s.run,
      expectedMediaSHA256: createHash("sha256").update(bytes).digest("hex"),
      nativeText: "Synthetic native-to-web interoperability " + s.run,
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    };
    s.interop = fixture;
    await persist(s);
    const photo = await seal(
      author,
      {
        mime: "image/jpeg",
        bytes: bytes.toString("base64"),
        alt: "Synthetic interoperability gradient",
        width: 16,
        height: 16,
      },
      {
        id: fixture.webMediaId,
        kind: "media",
        parentId: fixture.webPostId,
        expiresAt: fixture.expiresAt,
      },
    );
    const post = await seal(
      author,
      {
        text: fixture.expectedPostText,
        reactionSecret: createReactionSecret(),
        media: [
          {
            id: fixture.webMediaId,
            mime: "image/jpeg",
            width: 16,
            height: 16,
            alt: "Synthetic interoperability gradient",
          },
        ],
      },
      {
        id: fixture.webPostId,
        expiresAt: fixture.expiresAt,
      },
    );
    check(
      post.recipients.some(
        (recipient) =>
          recipient.memberId === c.id && recipient.deviceId === c.device!.id,
      ),
      "NATIVE_RECIPIENT_MISSING",
    );
    const encoded = new TextEncoder().encode(JSON.stringify(photo));
    const reservation = await api.json(
      "/api/v1/media",
      "POST",
      { id: fixture.webMediaId, envelope: photo, byte_size: encoded.length },
      201,
    );
    check(
      (await api.request(reservation.upload_url, "PUT", encoded)).status ===
        200,
      "INTEROP_MEDIA_UPLOAD_FAILED",
    );
    await publish(author, post, [fixture.webMediaId]);
    // Native tests recover C's old key, enroll a fresh authorized native device,
    // and publish with that new signing key. Handoff never enters Git or stdout.
    await writePrivate(
      directory + "native-interop.json",
      {
        v: 1,
        synthetic: true,
        origin: stagingOrigin,
        run: s.run,
        email: c.email,
        password: c.password,
        memberId: c.id,
        recoverySecret: c.device.keys.recoverySecret,
        ...fixture,
      },
      true,
    );
    fixture.prepared = true;
    await persist(s);
    progress("private-native-handoff-ready");
  } finally {
    await api.json("/api/auth/sign-out", "POST", {});
  }
}

async function checkInterop(s: State) {
  const fixture = s.interop;
  check(
    fixture?.prepared && Date.parse(fixture.expiresAt) > Date.now(),
    "LIVE_PREPARED_INTEROP_REQUIRED",
  );
  const a = s.accounts[0],
    c = s.accounts[2];
  const api = await login(a);
  try {
    const recipient = await enroll(s, a, api);
    const detail = await api.json("/api/v1/posts/" + fixture.nativePostId);
    const post: EncryptedEnvelope = detail.post.envelope;
    check(
      post.context.id === fixture.nativePostId &&
        post.context.authorId === c.id &&
        post.context.expiresAt === fixture.expiresAt,
      "NATIVE_POST_CONTEXT_MISMATCH",
    );
    check(
      post.context.authorDeviceId !== c.device?.id,
      "FRESH_NATIVE_DEVICE_REQUIRED",
    );
    const device = await api.json(
      "/api/v1/devices/" + post.context.authorDeviceId,
    );
    check(
      device.member_id === c.id && !device.revoked_at,
      "NATIVE_AUTHOR_DEVICE_MISMATCH",
    );
    const payload = await decryptObject<Record<string, any>>({
      envelope: post,
      expectedContext: post.context,
      privateKey: recipient.key,
      authorPublicKey: device.public_key,
    });
    check(
      payload.text === fixture.nativeText &&
        payload.media?.some((media: any) => media.id === fixture.nativeMediaId),
      "NATIVE_POST_DECRYPTION_FAILED",
    );
    const media = await api.json<EncryptedEnvelope>(
      "/api/v1/media/" + fixture.nativeMediaId + "/bytes",
    );
    check(
      media.context.id === fixture.nativeMediaId &&
        media.context.parentId === fixture.nativePostId &&
        media.context.authorId === c.id &&
        media.context.authorDeviceId === post.context.authorDeviceId &&
        media.context.expiresAt === fixture.expiresAt,
      "NATIVE_MEDIA_CONTEXT_MISMATCH",
    );
    const photo = await decryptObject<Record<string, any>>({
      envelope: media,
      expectedContext: media.context,
      privateKey: recipient.key,
      authorPublicKey: device.public_key,
    });
    check(
      photo.mime === "image/jpeg" &&
        typeof photo.bytes === "string" &&
        createHash("sha256")
          .update(Buffer.from(photo.bytes, "base64"))
          .digest("hex") === fixture.expectedMediaSHA256,
      "NATIVE_MEDIA_DECRYPTION_FAILED",
    );
    fixture.passed = true;
    await persist(s);
    progress("native-post-and-photo-decrypted-by-web-crypto");
  } finally {
    await api.json("/api/auth/sign-out", "POST", {});
  }
}

async function main() {
  check(allowed.includes(phase), "KNOWN_PHASE_REQUIRED");
  if (!["init", "public"].includes(phase))
    check(process.argv.includes("--run"), "EXPLICIT_RUN_REQUIRED");
  if (phase === "init") await initialize();
  else if (phase === "public") await publicChecks();
  else if (phase === "verify") await verify();
  else {
    const s = await state();
    if (phase === "signup") await signup(s);
    else if (phase === "social") await social(s);
    else if (phase === "interop-prepare") await prepareInterop(s);
    else if (phase === "interop-check") await checkInterop(s);
    else await cleanup(s);
  }
  console.log(
    JSON.stringify({
      phase,
      passed: true,
      browserQA: false,
      physicalObjectDeletionVerified: false,
    }),
  );
}
main().catch((error) => {
  // Never emit HTTP bodies, raw errors/stacks/URLs, emails, cookies or credentials.
  console.error(
    JSON.stringify({
      phase: allowed.includes(phase) ? phase : "invalid",
      passed: false,
      code: error instanceof SmokeError ? error.message : "HOSTED_SMOKE_FAILED",
    }),
  );
  process.exitCode = 1;
});
