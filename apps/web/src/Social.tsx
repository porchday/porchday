import React, { useEffect, useRef, useState } from "react";
import {
  bytesToBase64,
  base64ToBytes,
  createReactionSecret,
  reactionTag,
  signStatement,
  type Audience,
  type EncryptedEnvelope,
} from "@porchday/crypto";
import {
  get,
  post,
  patch,
  del,
  request,
  items,
  deadline,
  localDate,
  relativeDate,
  remaining,
  message,
  unexpired,
  accessLost,
  type SocialObject,
  type Content,
  type MediaPayload,
  type Json,
} from "./api";
import {
  Alert,
  Avatar,
  Button,
  Empty,
  Field,
  Icon,
  Loading,
  Modal,
  useAction,
} from "./ui";
import { useVault } from "./vault";
import { reshareDeadline, resharePayload } from "./reshare";
import { jpegDimensions, validatedPhoto } from "./photo-safety";
import { preservedPhotoDeadline } from "./archive";
const CATALOG = [
  ["like", "👍", "Like"],
  ["love", "❤️", "Love"],
  ["laugh", "😄", "Laugh"],
  ["celebrate", "🎉", "Celebrate"],
  ["care", "🤗", "Care"],
  ["sunshine", "☀️", "Sunshine"],
] as const;
export function TimerSelect({
  value,
  onChange,
  parent = null,
}: {
  value: string;
  onChange: (v: string) => void;
  parent?: string | null;
}) {
  const custom = value === "custom" || value.startsWith("custom:");
  function toLocal(iso: string) {
    const date = new Date(iso);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  return (
    <div className="timer-control">
      <label className="inline-select">
        <Icon name="clock" size={17} />
        <span className="sr-only">Expiration</span>
        <select
          value={custom ? "custom" : value}
          onChange={(e) => onChange(e.target.value)}
        >
          {parent ? (
            <option value="inherit">Same expiration as parent</option>
          ) : (
            <option value="">No timer</option>
          )}
          {[
            [3600, "1 hour"],
            [86400, "24 hours"],
            [604800, "7 days"],
            [2592000, "30 days"],
          ]
            .filter(
              ([seconds]) =>
                !parent ||
                Date.now() + Number(seconds) * 1000 <
                  new Date(parent).getTime(),
            )
            .map(([seconds, label]) => (
              <option key={seconds} value={seconds}>
                {parent ? "Shorter: " : ""}
                {label}
              </option>
            ))}
          <option value="custom">Choose a time…</option>
        </select>
      </label>
      {custom && (
        <input
          aria-label="Custom expiration date and time"
          className="custom-time"
          type="datetime-local"
          required
          min={toLocal(new Date(Date.now() + 60000).toISOString())}
          max={parent ? toLocal(parent) : undefined}
          value={value.startsWith("custom:") ? toLocal(value.slice(7)) : ""}
          onChange={(e) => {
            if (e.target.value)
              onChange("custom:" + new Date(e.target.value).toISOString());
          }}
        />
      )}
    </div>
  );
}
export function ExpiryWarning({
  expiry,
  reply = false,
  fromPost = false,
}: {
  expiry: string | null;
  reply?: boolean;
  fromPost?: boolean;
}) {
  return expiry ? (
    <div className="timer-warning">
      <Icon name="clock" size={19} />
      <span>
        This {reply ? "reply" : "comment"} will be deleted with the{" "}
        {reply ? "comment" : "post"} on <strong>{localDate(expiry)}</strong> (
        {remaining(expiry)}). You can make its timeout shorter.
        {fromPost && " This deadline is inherited from the original post."}
      </span>
    </div>
  ) : null;
}
function readObjectURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read this photo."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}
export async function preparePhoto(file: File, maxDimension = 2400) {
  if (file.size > 20 * 1024 * 1024)
    throw new Error("Each source photo must be 20 MB or smaller.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("Choose a JPEG, PNG, or WebP photo.");
  if (file.type === "image/jpeg")
    jpegDimensions(new Uint8Array(await file.arrayBuffer()), 65535);
  const bitmap = await createImageBitmap(file);
  if (
    bitmap.width * bitmap.height > 40_000_000 ||
    !bitmap.width ||
    !bitmap.height
  ) {
    bitmap.close();
    throw new Error("This photo exceeds the 40-megapixel safety limit.");
  }
  const ratio = Math.min(
    1,
    maxDimension / Math.max(bitmap.width, bitmap.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * ratio);
  canvas.height = Math.round(bitmap.height * ratio);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b ? resolve(b) : reject(new Error("Could not process this photo.")),
      "image/jpeg",
      0.85,
    ),
  );
  return {
    blob,
    width: canvas.width,
    height: canvas.height,
    preview: await readObjectURL(blob),
  };
}
type PendingPhoto = {
  id: string;
  name: string;
  alt: string;
  blob: Blob;
  width: number;
  height: number;
  preview: string;
};
export function Composer({
  onPosted,
  groupId,
}: {
  onPosted: () => void;
  groupId?: string;
}) {
  const vault = useVault();
  const [text, setText] = useState("");
  const [audience, setAudience] = useState<Audience>(
    groupId ? "group" : "connections",
  );
  const [timer, setTimer] = useState("");
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const action = useAction();
  async function selectPhotos(files: FileList | null) {
    if (!files) return;
    await action.run(async () => {
      if (files.length + photos.length > 10)
        throw new Error("You can share up to 10 photos in a post.");
      const next: PendingPhoto[] = [];
      for (const file of Array.from(files)) {
        const prepared = await preparePhoto(file);
        next.push({
          id: crypto.randomUUID(),
          name: file.name,
          alt: "",
          ...prepared,
        });
      }
      setPhotos([...photos, ...next]);
    });
    if (input.current) input.current.value = "";
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && !photos.length) return;
    await action.run(async () => {
      const id = crypto.randomUUID();
      const expiresAt = deadline(timer);
      const createdAt = new Date().toISOString();
      const media: MediaPayload[] = [];
      for (const photo of photos) {
        const meta = {
          id: crypto.randomUUID(),
          alt: photo.alt,
          mime: "image/jpeg",
          name: photo.name,
          width: photo.width,
          height: photo.height,
        };
        const envelope = await vault.seal(
          {
            bytes: bytesToBase64(
              new Uint8Array(await photo.blob.arrayBuffer()),
            ),
            ...meta,
          },
          {
            id: meta.id,
            kind: "media",
            audience,
            parentId: id,
            groupId: groupId || null,
            createdAt,
            expiresAt,
          },
        );
        const bytes = new TextEncoder().encode(JSON.stringify(envelope));
        const upload = await post("/media", {
          id: meta.id,
          envelope,
          byte_size: bytes.length,
        });
        await request(upload.upload_url, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Blob([bytes]),
        });
        media.push(meta);
      }
      const envelope = await vault.seal(
        { text: text.trim(), media, reactionSecret: createReactionSecret() },
        {
          id,
          kind: "post",
          audience,
          groupId: groupId || null,
          createdAt,
          expiresAt,
        },
      );
      await post("/posts", { envelope, media_ids: media.map((p) => p.id) });
      setText("");
      setPhotos([]);
      setTimer("");
      onPosted();
    }, "Post shared.");
  }
  if (vault.member.status === "restricted") return null;
  return (
    <form
      className="composer panel"
      data-unsaved-draft={Boolean(text.trim() || photos.length) || undefined}
      onSubmit={submit}
    >
      <div className="composer-start">
        <Avatar name={vault.member.handle} />
        <label className="sr-only" htmlFor="post-text">
          Write a post
        </label>
        <textarea
          id="post-text"
          rows={3}
          maxLength={5000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a post…"
        />
      </div>
      {photos.length > 0 && (
        <div className="photo-editor">
          {photos.map((photo) => (
            <div className="photo-draft" key={photo.id}>
              <img src={photo.preview} alt="Photo preview" />
              <Field
                label="Photo description"
                value={photo.alt}
                onChange={(e) =>
                  setPhotos(
                    photos.map((p) =>
                      p.id === photo.id ? { ...p, alt: e.target.value } : p,
                    ),
                  )
                }
                maxLength={1000}
                placeholder="Describe this photo for everyone"
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${photo.name}`}
                onClick={() =>
                  setPhotos(photos.filter((p) => p.id !== photo.id))
                }
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      )}
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
      <div className="composer-controls">
        <div className="composer-tools">
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => selectPhotos(e.target.files)}
          />
          <button
            type="button"
            className="text-button"
            onClick={() => input.current?.click()}
          >
            <Icon name="photo" size={18} />
            <span>Photos</span>
          </button>
          <TimerSelect value={timer} onChange={setTimer} />
        </div>
        <Button
          variant="primary compact"
          type="submit"
          busy={action.busy}
          disabled={!text.trim() && !photos.length}
        >
          Share <Icon name="arrow" size={16} />
        </Button>
      </div>
      <div className="composer-privacy">
        <Icon name="lock" size={13} />
        {groupId ? (
          <span>Encrypted for this group</span>
        ) : (
          <label>
            Share with{" "}
            <select
              aria-label="Post audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value as Audience)}
            >
              <option value="connections">Friends & family</option>
              <option value="friends">Friends only</option>
              <option value="family">Family only</option>
              <option value="only_me">Only me</option>
            </select>
          </label>
        )}
        {audience === "friends" && <span>Excludes family connections</span>}
        {timer && <span>· disappears {localDate(deadline(timer)!)}</span>}
        <span className="character-count">{text.length}/5,000</span>
      </div>
    </form>
  );
}
export function Feed({
  wallId,
  groupId,
  singleId,
  canModerate = false,
}: {
  wallId?: string;
  groupId?: string;
  singleId?: string;
  canModerate?: boolean;
}) {
  const [rows, setRows] = useState<SocialObject[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const loadVersion = useRef(0);
  const action = useAction();
  const endpoint = singleId
    ? `/posts/${singleId}`
    : groupId
      ? `/groups/${groupId}/posts`
      : wallId
        ? `/walls/${wallId}`
        : "/feed";
  async function load(more = false) {
    const attempt = ++loadVersion.current;
    await action.run(async () => {
      let r: Json;
      try {
        r = await get(
          `${endpoint}${more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
      } catch (e) {
        if (attempt === loadVersion.current && accessLost(e)) {
          setRows([]);
          setCursor(null);
          setLoaded(true);
        }
        throw e;
      }
      if (attempt !== loadVersion.current) return;
      const next = singleId ? [r.post] : items<SocialObject>(r);
      setRows((old) =>
        more
          ? [...old, ...next.filter((n) => !old.some((o) => o.id === n.id))]
          : next,
      );
      setCursor(r.next_cursor || null);
      setLoaded(true);
    });
  }
  useEffect(() => {
    load();
    return () => {
      loadVersion.current++;
    };
  }, [endpoint, version]);
  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 1000);
    const visible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
    };
  }, [endpoint]);
  const refresh = () => setVersion((v) => v + 1);
  return (
    <>
      {!wallId && !singleId && (
        <Composer onPosted={refresh} groupId={groupId} />
      )}
      <div className="feed-heading">
        <span>
          {groupId
            ? "Group posts"
            : singleId
              ? "Post"
              : "Posts"}
        </span>
        <button className="text-button" onClick={() => load()}>
          <Icon name="clock" size={14} />
          Newest first
        </button>
      </div>
      <Alert>{action.error}</Alert>
      {!loaded && action.busy ? (
        <Loading />
      ) : (
        rows
          .filter(unexpired)
          .map((row) => (
            <PostCard
              key={row.id + ":" + row.envelope.context.revision}
              row={row}
              onChange={refresh}
              expanded={!!singleId}
              canModerate={canModerate}
            />
          ))
      )}
      {loaded && !rows.filter(unexpired).length && (
        <div className="panel">
          <Empty
            icon=""
            title={
              singleId
                ? "Post unavailable"
                : "No posts yet"
            }
            action={
              !groupId && !singleId ? (
                <a className="button outline compact" href="/app/connections">
                  Find a friend <Icon name="arrow" size={16} />
                </a>
              ) : undefined
            }
          >
            {singleId
              ? "It may have expired, been removed, or no longer be shared with you."
              : "Posts from your connections appear here in chronological order."}
          </Empty>
        </div>
      )}
      {cursor && (
        <Button
          variant="outline full"
          busy={action.busy}
          onClick={() => load(true)}
        >
          Load more posts
        </Button>
      )}
      {loaded && rows.length > 0 && !cursor && (
        <div className="caught-up">
          <Icon name="check" size={20} />
          <p>
            No more posts.
          </p>
        </div>
      )}
    </>
  );
}
export function PostCard({
  row,
  onChange,
  expanded = false,
  canModerate = false,
}: {
  row: SocialObject;
  onChange: () => void;
  expanded?: boolean;
  canModerate?: boolean;
}) {
  const vault = useVault();
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState("");
  const [showComments, setShowComments] = useState(expanded);
  const [showReport, setShowReport] = useState(false);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const [reshare, setReshare] = useState(false);
  const [menu, setMenu] = useState(false);
  const [edit, setEdit] = useState(false);
  const [editText, setEditText] = useState("");
  const [editTimer, setEditTimer] = useState("inherit");
  const [details, setDetails] = useState<Json | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const action = useAction();
  useEffect(() => {
    let alive = true;
    vault
      .open(row)
      .then((c) => {
        if (alive) {
          setContent(c);
          setEditText(String(c.text || ""));
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [row.id, row.envelope.ciphertext]);
  async function loadDetails() {
    try {
      const d = await get(`/posts/${row.id}`);
      setDetails(d);
    } catch (e) {
      if (accessLost(e)) {
        setUnavailable(true);
        setContent(null);
        setDetails(null);
      }
      throw e;
    }
  }
  useEffect(() => {
    loadDetails().catch(() => {});
  }, [row.id]);
  const expiry = row.effective_expires_at || row.expires_at;
  const own = row.author_id === vault.member.id;
  async function remove() {
    if (
      !confirm("Delete this post and all its comments, reactions, and photos?")
    )
      return;
    await action.run(async () => {
      await del(`/posts/${row.id}`);
      onChange();
    });
  }
  async function saveEdit() {
    await action.run(async () => {
      const envelope = await vault.seal(
        { ...content, text: editText },
        {
          ...row.envelope.context,
          authorDeviceId: vault.device.id,
          expiresAt: deadline(editTimer, row.expires_at),
          revision: row.envelope.context.revision + 1,
        },
        row.id,
      );
      const lifecycle = await signStatement(
        {
          purpose: "porchday-lifecycle",
          id: row.id,
          revision: envelope.context.revision,
          expiresAt: envelope.context.expiresAt,
        },
        vault.privateKey,
      );
      await request(`/posts/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ envelope, lifecycle }),
      });
      setEdit(false);
      onChange();
    });
  }
  if (unavailable)
    return (
      <div className="panel">
        <Alert>This post is no longer available.</Alert>
      </div>
    );
  return (
    <article className="post-card panel">
      <header className="post-heading">
        <a href={`/app/wall/${row.author_id}`} className="post-author">
          <Avatar name={row.author_handle || row.author_id} />
          <div>
            <strong>
              {row.author_id === vault.member.id
                ? `@${vault.member.handle}`
                : row.author_handle
                  ? `@${row.author_handle}`
                  : "A connection"}
            </strong>
            <span>
              <time dateTime={row.created_at} title={localDate(row.created_at)}>
                {relativeDate(row.created_at)}
              </time>{" "}
              · <Icon name="lock" size={11} />
              {row.audience === "only_me"
                ? "Only me"
                : row.group_id
                  ? "Group"
                  : row.audience === "family"
                    ? "Family"
                    : row.audience === "friends"
                      ? "Friends only"
                      : "Friends & family"}
            </span>
          </div>
        </a>
        <div className="post-menu">
          <button
            ref={optionsButton}
            className="icon-button"
            onClick={() => setMenu(!menu)}
            aria-label="Post options"
            aria-expanded={menu}
          >
            <Icon name="more" />
          </button>
          {menu && (
            <div className="dropdown-menu">
              {own && vault.member.status !== "restricted" && (
                <>
                  <button
                    onClick={() => {
                      setEdit(true);
                      setMenu(false);
                    }}
                  >
                    <Icon name="edit" size={16} />
                    Edit text
                  </button>
                  {content && (
                    <button
                      onClick={() => {
                        setReshare(true);
                        setMenu(false);
                      }}
                    >
                      <Icon name="arrow" size={16} />
                      Share as a new post
                    </button>
                  )}
                </>
              )}
              {(own || canModerate) && vault.member.status !== "restricted" && (
                <button onClick={remove}>
                  <Icon name="trash" size={16} />
                  {own ? "Delete post" : "Remove group post"}
                </button>
              )}
              <button
                onClick={() => {
                  setShowReport(true);
                  setMenu(false);
                }}
              >
                <Icon name="shield" size={16} />
                Report a concern
              </button>
              <a href={`/app/post/${row.id}`}>
                <Icon name="external" size={16} />
                Open post
              </a>
            </div>
          )}
        </div>
      </header>
      {expiry && (
        <div className="expiry-chip">
          <Icon name="clock" size={13} />
          Disappears {localDate(expiry)}
          <span>· {remaining(expiry)}</span>
        </div>
      )}
      {error ? (
        <div className="encrypted-unavailable">
          <Icon name="lock" />
          <p>{error}</p>
        </div>
      ) : !content ? (
        <Loading text="Loading post…" />
      ) : edit ? (
        <div className="form-stack">
          <label className="field">
            <span>Edit your post</span>
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              maxLength={5000}
              rows={5}
            />
          </label>
          <TimerSelect
            value={editTimer}
            onChange={setEditTimer}
            parent={row.expires_at}
          />
          <p className="small-copy">
            You can add or shorten a timer. Existing deadlines cannot be
            extended or removed.
          </p>
          <div className="button-row">
            <Button
              variant="primary compact"
              busy={action.busy}
              onClick={saveEdit}
            >
              Save changes
            </Button>
            <Button variant="quiet compact" onClick={() => setEdit(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ReshareProvenance content={content} />
          <p className="post-text">{content.text}</p>
          {content.media && (
            <div
              className={`post-photos photos-${Math.min(content.media.length, 3)}`}
            >
              {content.media.map((media) => (
                <EncryptedPhoto key={media.id} media={media} />
              ))}
            </div>
          )}
        </>
      )}
      <Alert>{action.error}</Alert>
      <div className="post-actions">
        <Reactions
          target={row}
          payload={content}
          reactions={details?.reactions || []}
          reload={loadDetails}
        />
        <button
          className="text-button comment-toggle"
          onClick={() => {
            setShowComments(!showComments);
            if (!details) loadDetails();
          }}
        >
          <Icon name="comment" size={18} />
          {details?.comments?.length || row.comment_count || ""}{" "}
          <span>Comment</span>
        </button>
      </div>
      {showComments && (
        <Comments
          postRow={row}
          initial={details?.comments}
          onChange={loadDetails}
          canModerate={canModerate}
        />
      )}{" "}
      {showReport && (
        <ReportDialog
          row={row}
          content={content}
          returnFocusRef={optionsButton}
          onClose={() => setShowReport(false)}
        />
      )}{" "}
      {reshare && content && (
        <ReshareDialog
          source={row}
          content={content}
          onClose={() => setReshare(false)}
          onShared={() => {
            setReshare(false);
            onChange();
          }}
        />
      )}
    </article>
  );
}
export function EncryptedPhoto({ media }: { media: MediaPayload }) {
  const vault = useVault();
  const [opened, setOpened] = useState<{ id: string; url: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  const url = opened?.id === media.id ? opened.url : "";
  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setOpened(null);
    setError("");
    fetch(`/api/v1/media/${media.id}/bytes`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("This photo is no longer available.");
        const envelope = (await response.json()) as EncryptedEnvelope;
        const payload = await vault.open({ envelope, id: media.id });
        if (payload.mime !== "image/jpeg" || typeof payload.bytes !== "string")
          throw new Error("Unsupported photo format.");
        const bytes = base64ToBytes(payload.bytes);
        const { blob } = await validatedPhoto(bytes);
        if (!alive) return;
        const expiry = envelope.context.expiresAt
          ? Date.parse(envelope.context.expiresAt)
          : null;
        if (expiry !== null && expiry <= Date.now())
          throw new Error("This photo expired.");
        objectUrl = URL.createObjectURL(blob);
        setOpened({ id: media.id, url: objectUrl });
        const checkExpiry = () => {
          if (expiry === null || !alive) return;
          const remaining = expiry - Date.now();
          if (remaining <= 0) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = "";
            setOpened(null);
            setError("This photo expired.");
          } else
            expiryTimer = setTimeout(
              checkExpiry,
              Math.min(remaining, 2_147_483_647),
            );
        };
        checkExpiry();
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      controller.abort();
      if (expiryTimer) clearTimeout(expiryTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [media.id]);
  return url ? (
    <figure>
      <img
        src={url}
        alt={media.alt || "Shared photo (no description provided)"}
        loading="lazy"
      />
      {media.alt && <figcaption>{media.alt}</figcaption>}
    </figure>
  ) : (
    <div className="photo-placeholder">
      <Icon name={error ? "shield" : "photo"} size={24} />
      <span>{error || "Opening encrypted photo…"}</span>
    </div>
  );
}
export function Reactions({
  target,
  payload,
  reactions,
  reload,
}: {
  target: SocialObject;
  payload: Content | null;
  reactions: Json[];
  reload: () => Promise<void>;
}) {
  const vault = useVault();
  const [picker, setPicker] = useState(false);
  const [decoded, setDecoded] = useState<
    { id: string; emoji: string; memberId: string; tag: string }[]
  >([]);
  const action = useAction();
  useEffect(() => {
    let alive = true;
    Promise.all(
      reactions.map(async (r) => {
        try {
          const c = await vault.open({ envelope: r.envelope });
          const memberId = r.member_id || r.envelope.context.authorId;
          if (
            typeof payload?.reactionSecret !== "string" ||
            !CATALOG.some(([id]) => id === c.emoji)
          )
            return null;
          const expected = await reactionTag({
            secret: payload.reactionSecret,
            targetId: target.id,
            memberId,
            emoji: String(c.emoji),
          });
          if (
            expected !== r.reaction_tag ||
            r.envelope.context.id !== expected ||
            r.envelope.context.parentId !== target.id
          )
            return null;
          return {
            id: r.envelope.context.id,
            emoji: String(c.emoji),
            memberId,
            tag: r.reaction_tag,
          };
        } catch {
          return null;
        }
      }),
    ).then((rs) => {
      if (alive) setDecoded(rs.filter(Boolean) as typeof decoded);
    });
    return () => {
      alive = false;
    };
  }, [JSON.stringify(reactions), payload?.reactionSecret]);
  const isComment = target.envelope.context.kind === "comment";
  const base = isComment
    ? `/comments/${target.id}/reactions`
    : `/posts/${target.id}/reactions`;
  async function toggle(emoji: string) {
    if (!payload || typeof payload.reactionSecret !== "string") return;
    await action.run(async () => {
      const mine = decoded.find(
        (r) => r.emoji === emoji && r.memberId === vault.member.id,
      );
      if (mine) await del(`${base}/${encodeURIComponent(mine.tag)}`);
      else {
        const tag = await reactionTag({
          secret: payload.reactionSecret as string,
          targetId: target.id,
          memberId: vault.member.id,
          emoji,
        });
        const envelope = await vault.seal(
          { emoji },
          {
            id: tag,
            kind: "reaction",
            audience: target.envelope.context.audience,
            parentId: target.id,
            groupId: target.group_id || target.envelope.context.groupId,
            expiresAt: target.effective_expires_at || target.expires_at,
          },
          isComment ? target.post_id : target.id,
        );
        await request(`${base}/${tag}`, {
          method: "PUT",
          body: JSON.stringify({ envelope }),
        });
      }
      await reload();
      setPicker(false);
    });
  }
  return (
    <div className="reaction-area">
      <div className="reaction-chips">
        {CATALOG.map(([id, emoji, label]) => {
          const values = decoded.filter((r) => r.emoji === id);
          const count = new Set(values.map((r) => r.memberId)).size;
          if (!count) return null;
          const selected = values.some((r) => r.memberId === vault.member.id);
          return (
            <button
              key={id}
              className={`reaction-chip ${selected ? "selected" : ""}`}
              aria-label={`${label}, ${count} ${count === 1 ? "person" : "people"}`}
              aria-pressed={selected}
              disabled={action.busy || vault.member.status === "restricted"}
              onClick={() => toggle(id)}
            >
              <span aria-hidden="true">{emoji}</span>
              {count}
            </button>
          );
        })}
        <button
          className="reaction-add"
          onClick={() => setPicker(!picker)}
          disabled={!payload || vault.member.status === "restricted"}
          aria-label="Add a reaction"
          aria-expanded={picker}
        >
          <Icon name="smile" size={18} />
          <Icon name="plus" size={10} />
        </button>
      </div>
      {picker && (
        <div
          className="reaction-picker"
          role="group"
          aria-label="Reaction options"
        >
          {CATALOG.map(([id, emoji, label]) => (
            <button
              key={id}
              title={label}
              aria-label={label}
              disabled={action.busy || vault.member.status === "restricted"}
              onClick={() => toggle(id)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {action.error && <Alert>{action.error}</Alert>}
    </div>
  );
}
export function Comments({
  postRow,
  initial,
  onChange,
  canModerate = false,
}: {
  postRow: SocialObject;
  initial?: SocialObject[];
  onChange: () => Promise<void>;
  canModerate?: boolean;
}) {
  const [comments, setComments] = useState<SocialObject[]>(initial || []);
  const [reactions, setReactions] = useState<Json[]>([]);
  const [reply, setReply] = useState<SocialObject | null>(null);
  const [tick, setTick] = useState(0);
  const action = useAction();
  async function refresh() {
    await action.run(async () => {
      try {
        const r = await get(`/posts/${postRow.id}`);
        setComments(r.comments || []);
        setReactions(r.comment_reactions || r.reactions || []);
      } catch (e) {
        if (accessLost(e)) {
          setComments([]);
          setReactions([]);
          setReply(null);
          await onChange().catch(() => {});
        }
        throw e;
      }
      await onChange();
    });
  }
  useEffect(() => {
    refresh();
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [postRow.id]);
  const visible = comments.filter(unexpired);
  const roots = visible.filter(
    (c) => !c.parent_id || c.parent_id === postRow.id,
  );
  function branch(row: SocialObject, depth = 0): React.ReactNode {
    return (
      <div
        className={`comment-branch depth-${Math.min(depth, 2)}`}
        key={row.id}
      >
        <Comment
          row={row}
          postRow={postRow}
          canModerate={canModerate}
          onReply={() => setReply(row)}
          onChange={refresh}
          reactions={reactions.filter(
            (r) =>
              r.comment_id === row.id ||
              r.envelope?.context.parentId === row.id,
          )}
        />
        {visible
          .filter((c) => c.parent_id === row.id)
          .map((c) => branch(c, depth + 1))}
      </div>
    );
  }
  return (
    <section className="comments" aria-label="Comments">
      <Alert>{action.error}</Alert>
      {roots.map((c) => branch(c))}
      {reply && (
        <div className="reply-context">
          Replying to a comment{" "}
          <button className="text-button" onClick={() => setReply(null)}>
            Cancel
          </button>
        </div>
      )}
      <CommentComposer
        parent={reply || postRow}
        postRow={postRow}
        onPosted={async () => {
          setReply(null);
          await refresh();
        }}
      />
    </section>
  );
}
function Comment({
  row,
  postRow,
  onReply,
  onChange,
  reactions,
  canModerate = false,
}: {
  row: SocialObject;
  postRow: SocialObject;
  onReply: () => void;
  onChange: () => Promise<void>;
  reactions: Json[];
  canModerate?: boolean;
}) {
  const vault = useVault();
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [timer, setTimer] = useState("inherit");
  const action = useAction();
  useEffect(() => {
    vault
      .open(row)
      .then((c) => {
        setContent(c);
        setText(c.text || "");
      })
      .catch((e) => setError(e.message));
  }, [row.envelope.ciphertext]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const expiresAt = deadline(
        timer,
        row.effective_expires_at || row.expires_at,
      );
      const envelope = await vault.seal(
        { ...content, text },
        {
          ...row.envelope.context,
          authorDeviceId: vault.device.id,
          expiresAt,
          revision: row.envelope.context.revision + 1,
        },
        postRow.id,
      );
      const lifecycle = await signStatement(
        {
          purpose: "porchday-lifecycle",
          id: row.id,
          revision: envelope.context.revision,
          expiresAt,
        },
        vault.privateKey,
      );
      await request(`/comments/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ envelope, lifecycle }),
      });
      setEditing(false);
      await onChange();
    });
  }
  return (
    <div className="comment">
      <Avatar name={row.author_handle || row.author_id} size="small" />
      <div className="comment-main">
        {editing ? (
          <form className="form-stack" onSubmit={save}>
            <label className="field">
              <span>Edit your comment</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={5000}
                required
              />
            </label>
            <ExpiryWarning
              expiry={row.effective_expires_at || row.expires_at}
              reply={!!row.parent_id}
              fromPost={row.effective_expires_at === postRow.expires_at}
            />
            <TimerSelect
              value={timer}
              onChange={setTimer}
              parent={row.effective_expires_at || row.expires_at}
            />
            <div className="button-row">
              <Button variant="primary compact" busy={action.busy}>
                Save
              </Button>
              <Button
                type="button"
                variant="quiet compact"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="comment-bubble">
            <div>
              <strong>
                {row.author_id === vault.member.id
                  ? `@${vault.member.handle}`
                  : row.author_handle
                    ? `@${row.author_handle}`
                    : "Member"}
              </strong>
              <time title={localDate(row.created_at)}>
                {relativeDate(row.created_at)}
              </time>
            </div>
            <p>{error || content?.text || "Opening encrypted comment…"}</p>
            {(row.effective_expires_at || row.expires_at) && (
              <small>
                <Icon name="clock" size={11} />
                {remaining(row.effective_expires_at || row.expires_at!)}
              </small>
            )}
          </div>
        )}
        <div className="comment-tools">
          <Reactions
            target={{ ...row, post_id: postRow.id }}
            payload={content}
            reactions={reactions}
            reload={onChange}
          />
          <button
            className="text-button"
            disabled={vault.member.status === "restricted"}
            onClick={onReply}
          >
            Reply
          </button>
          <button className="text-button" onClick={() => setReport(true)}>
            Report
          </button>
          {row.author_id === vault.member.id &&
            vault.member.status !== "restricted" && (
              <button className="text-button" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
          {(row.author_id === vault.member.id ||
            postRow.author_id === vault.member.id ||
            canModerate) &&
            vault.member.status !== "restricted" && (
              <button
                className="text-button"
                disabled={action.busy}
                onClick={() => {
                  if (confirm("Delete this comment and its replies?"))
                    action.run(async () => {
                      await del(`/comments/${row.id}`);
                      await onChange();
                    });
                }}
              >
                Delete
              </button>
            )}
        </div>
        <Alert>{action.error}</Alert>
      </div>
      {report && (
        <ReportDialog
          row={row}
          content={content}
          onClose={() => setReport(false)}
        />
      )}
    </div>
  );
}
function CommentComposer({
  parent,
  postRow,
  onPosted,
}: {
  parent: SocialObject;
  postRow: SocialObject;
  onPosted: () => Promise<void>;
}) {
  const vault = useVault();
  const [text, setText] = useState("");
  const [timer, setTimer] = useState("inherit");
  const [ack, setAck] = useState(
    parent.effective_expires_at || parent.expires_at || postRow.expires_at,
  );
  const action = useAction();
  useEffect(() => {
    setAck(
      parent.effective_expires_at || parent.expires_at || postRow.expires_at,
    );
    setTimer("inherit");
    action.setError("");
  }, [parent.id, parent.expires_at, parent.effective_expires_at]);
  const reply = parent.id !== postRow.id;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      try {
        const expiresAt = deadline(timer === "inherit" ? "" : timer, ack);
        const envelope = await vault.seal(
          { text: text.trim(), reactionSecret: createReactionSecret() },
          {
            kind: "comment",
            audience: postRow.envelope.context.audience,
            parentId: parent.id,
            groupId: postRow.group_id || null,
            expiresAt,
          },
          postRow.id,
        );
        await post(`/posts/${postRow.id}/comments`, {
          envelope,
          parent_expires_at: ack,
        });
        setText("");
        setTimer("inherit");
        await onPosted();
      } catch (e: any) {
        if (
          e.code === "DEADLINE_CHANGED" ||
          e.code === "PARENT_DEADLINE_CHANGED"
        ) {
          setAck(
            e.details?.effective_expires_at || e.details?.expires_at || null,
          );
          throw new Error(
            "The parent’s timer changed. Review the updated deadline below, then submit again.",
          );
        }
        throw e;
      }
    });
  }
  if (vault.member.status === "restricted") return null;
  return (
    <form
      className="comment-composer"
      data-unsaved-draft={Boolean(text.trim()) || undefined}
      onSubmit={submit}
    >
      <ExpiryWarning
        expiry={ack}
        reply={reply}
        fromPost={reply && ack === postRow.expires_at}
      />
      <div className="comment-compose-row">
        <Avatar name={vault.member.handle} size="small" />
        <label className="sr-only" htmlFor={`comment-${parent.id}`}>
          {reply ? "Write a reply" : "Write a comment"}
        </label>
        <textarea
          id={`comment-${parent.id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={5000}
          rows={2}
          placeholder={
            reply ? "Write a reply…" : "Write a comment…"
          }
          required
        />
      </div>
      <Alert>{action.error}</Alert>
      <div className="comment-compose-footer">
        <TimerSelect value={timer} onChange={setTimer} parent={ack} />
        <Button
          variant="primary compact"
          busy={action.busy}
          disabled={!text.trim()}
        >
          {reply ? "Reply" : "Comment"}
          <Icon name="arrow" size={15} />
        </Button>
      </div>
    </form>
  );
}
export function ReportDialog({
  row,
  content,
  onClose,
  returnFocusRef,
}: {
  row: SocialObject;
  content: Content | null;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const vault = useVault();
  const [reason, setReason] = useState("harassment");
  const [description, setDescription] = useState("");
  const [disclose, setDisclose] = useState(false);
  const [done, setDone] = useState(false);
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      let evidence: EncryptedEnvelope | undefined;
      if (disclose) {
        evidence = await vault.seal(
          {
            selectedText: content?.text || "",
            description,
            sourceId: row.id,
            sourceAuthorId: row.author_id,
          },
          { kind: "report", audience: "moderators", parentId: row.id },
        );
      }
      await post("/reports", {
        target_member: row.author_id,
        target_id: row.id,
        reason,
        evidence_envelope: evidence || null,
        evidence_disclosed: !!evidence,
      });
      setDone(true);
    });
  }
  return (
    <Modal title="Tell us what’s wrong" onClose={onClose} returnFocusRef={returnFocusRef}>
      {done ? (
        <>
          <Alert success>
            Your report was received. A moderator can review the information you
            chose to share.
          </Alert>
          <Button variant="primary" autoFocus onClick={onClose}>
            Done
          </Button>
        </>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          <p>
            Reporting shares information with authorized moderators. They cannot
            otherwise read private content.
          </p>
          <label className="field">
            <span>What’s the concern?</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="harassment">Harassment or threats</option>
              <option value="agent">An AI agent or automated account</option>
              <option value="impersonation">Impersonation</option>
              <option value="spam">Spam or commercial promotion</option>
              <option value="safety">Safety or exploitation</option>
              <option value="other">Something else</option>
            </select>
          </label>
          <label className="field">
            <span>Anything else?</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="Do not include passwords, recovery secrets, or other people’s private details."
            />
          </label>
          {
            <label className="check-field">
              <input
                type="checkbox"
                checked={disclose}
                onChange={(e) => setDisclose(e.target.checked)}
              />
              <span>
                Disclose my description and any readable selected text,
                encrypted for moderators.
              </span>
            </label>
          }
          <div className="report-preview">
            <strong>What will be shared</strong>
            <p>
              Category, the content reference, author reference, and your
              reporter identity.
              {!disclose &&
                " Your description is not sent unless you choose to disclose encrypted evidence."}
            </p>
            {disclose && (
              <blockquote>{String(content?.text || "(No text)")}</blockquote>
            )}
            <small>
              Photos, unrelated comments, and other private content are not
              included.
            </small>
          </div>
          <Alert>{action.error}</Alert>
          <Button variant="primary" busy={action.busy}>
            Send report
          </Button>
        </form>
      )}
    </Modal>
  );
}

function ReshareDialog({
  source,
  content,
  onClose,
  onShared,
}: {
  source: SocialObject;
  content: Content;
  onClose: () => void;
  onShared: () => void;
}) {
  const vault = useVault();
  const [text, setText] = useState(String(content.text || ""));
  const [audience, setAudience] = useState<Audience>(
    source.group_id ? "group" : "connections",
  );
  const [timer, setTimer] = useState("inherit");
  const [ack, setAck] = useState(
    source.effective_expires_at || source.expires_at,
  );
  const [reviewed, setReviewed] = useState(false);
  const action = useAction();
  async function share(e: React.FormEvent) {
    e.preventDefault();
    if (!reviewed) return;
    await action.run(async () => {
      try {
        const fresh = (await get(`/posts/${source.id}`)).post as SocialObject;
        const latest = fresh.effective_expires_at || fresh.expires_at;
        if (latest !== ack) {
          setAck(latest);
          setReviewed(false);
          throw new Error(
            "The original timer changed. Review the updated deadline and audience, then confirm again.",
          );
        }
        const expiresAt = reshareDeadline(fresh, timer, vault.member.id);
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const groupId = audience === "group" ? source.group_id || null : null;
        const media: MediaPayload[] = [];
        for (const photo of content.media || []) {
          const response = await fetch(`/api/v1/media/${photo.id}/bytes`, {
            credentials: "same-origin",
            cache: "no-store",
          });
          if (!response.ok)
            throw new Error(
              "An original photo is unavailable. This memory cannot be shared again.",
            );
          const oldEnvelope = (await response.json()) as EncryptedEnvelope;
          const original = await vault.open({
            envelope: oldEnvelope,
            id: photo.id,
          });
          if (
            original.mime !== "image/jpeg" ||
            typeof original.bytes !== "string"
          )
            throw new Error("An original photo has an unsupported format.");
          const bytes = base64ToBytes(original.bytes);
          const { width, height } = await validatedPhoto(bytes);
          const photoExpiresAt = preservedPhotoDeadline(
            oldEnvelope.context.expiresAt,
            expiresAt,
          );
          const item = { ...photo, width, height, id: crypto.randomUUID() };
          const envelope = await vault.seal(
            { ...item, bytes: original.bytes },
            {
              id: item.id,
              kind: "media",
              audience,
              parentId: id,
              groupId,
              createdAt,
              expiresAt: photoExpiresAt,
            },
          );
          const packed = new TextEncoder().encode(JSON.stringify(envelope));
          const upload = await post("/media", {
            id: item.id,
            envelope,
            byte_size: packed.length,
          });
          await request(upload.upload_url, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: new Blob([packed]),
          });
          media.push(item);
        }
        const payload = resharePayload(fresh, content, text, media);
        const envelope = await vault.seal(payload, {
          id,
          kind: "post",
          audience,
          groupId,
          createdAt,
          expiresAt,
        });
        await post(`/posts/${source.id}/reshare`, {
          envelope,
          media_ids: media.map((m) => m.id),
          source_expires_at: ack,
        });
        onShared();
      } catch (e: any) {
        if (
          e.code === "PARENT_DEADLINE_CHANGED" ||
          e.code === "SOURCE_DEADLINE_CHANGED"
        ) {
          setAck(e.details?.expires_at || null);
          setReviewed(false);
          throw new Error(
            "The original timer changed. Review the updated deadline and audience, then confirm again.",
          );
        }
        throw e;
      }
    });
  }
  return (
    <Modal title="Share as a new post" onClose={onClose}>
      <form className="form-stack" onSubmit={share}>
        <p>
          This creates a new post for your selected current audience, including
          eligible people who connected with you later. Only your own text and
          photos are copied. The original comments and reactions stay with the
          original post.
        </p>
        <label className="field">
          <span>Your text</span>
          <textarea
            rows={4}
            maxLength={5000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {!!content.media?.length && (
          <p>
            {content.media.length} of your photos will be encrypted again for
            the new audience.
          </p>
        )}
        <label className="field">
          <span>New post audience</span>
          <select
            value={audience}
            onChange={(e) => {
              setAudience(e.target.value as Audience);
              setReviewed(false);
            }}
          >
            <option value="connections">My current friends & family</option>
            <option value="friends">Friends only</option>
            <option value="family">My current family connections</option>
            <option value="only_me">Only me</option>
            {source.group_id && (
              <option value="group">Current members of this group</option>
            )}
          </select>
        </label>
        {ack && (
          <div className="timer-warning">
            <Icon name="clock" />
            <span>
              The copy keeps the original deadline:{" "}
              <strong>{localDate(ack)}</strong>. You can make it shorter, never
              longer.
            </span>
          </div>
        )}
        <TimerSelect
          value={timer}
          onChange={(v) => {
            setTimer(v);
            setReviewed(false);
          }}
          parent={ack}
        />
        <p className="small-copy">
          The new post has its own thread. Later editing, shortening, or
          deleting the original does not change this copy. The original author
          and date stay in its provenance.
        </p>
        <label className="check-field">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
            required
          />
          <span>
            I reviewed the new audience and expiration and want to share my
            contribution again.
          </span>
        </label>
        <Alert>{action.error}</Alert>
        <div className="button-row">
          <Button
            variant="primary"
            busy={action.busy}
            disabled={!reviewed || (!text.trim() && !content.media?.length)}
          >
            Share as a new post
          </Button>
          <Button type="button" variant="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ReshareProvenance({ content }: { content: Content }) {
  const provenance = content.provenance as Json | undefined;
  if (
    provenance?.kind !== "reshared_post" ||
    typeof provenance.created_at !== "string" ||
    !Number.isFinite(Date.parse(provenance.created_at))
  )
    return null;
  return (
    <p className="small-copy">
      <Icon name="clock" size={13} /> Originally posted on{" "}
      {localDate(provenance.created_at)}, shared again by its author.
    </p>
  );
}
