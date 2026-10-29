import { GroupInviteForm } from "./GroupInviteForm";
import { invitationHandle, notificationPath } from "./invitation-notification";
import { MemberAvatar } from "./MemberAvatar";
import React, { useEffect, useRef, useState } from "react";
import {
  get,
  post,
  request,
  del,
  items,
  relativeDate,
  type Json,
  type Content,
} from "./api";
import {
  Alert,
  Button,
  Empty,
  Field,
  Icon,
  Loading,
  Modal,
  useAction,
  navigate,
} from "./ui";
import { useVault } from "./vault";
import { Composer, Feed, EncryptedPhoto } from "./Social";
import type { MediaPayload, Device } from "./api";
import { AssetPicker, useAssetUpload, type PendingAsset } from "./Media";
import { Fingerprint } from "./vault";
import { planSurfacePhotos } from "./surface-media";
import { wallpaperId } from "./wallpaper";
import { PlatformInvitation } from "./PlatformInvitation";
export function Connections() {
  const vault = useVault();
  const [data, setData] = useState<Json | null>(null);
  const peopleHeading = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef(new Set<() => void>());
  useEffect(() => () => {
    for (const cancel of pendingFocus.current) cancel();
    pendingFocus.current.clear();
  }, []);
  const [handle, setHandle] = useState(() => invitationHandle(new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("handle")) || "");
  const [kind, setKind] = useState<"friend" | "family">("friend");
  const [history, setHistory] = useState<"full" | "future">("full");
  const [incomingHistory, setIncomingHistory] = useState<Record<string, "full" | "future">>({});
  const [incomingKind, setIncomingKind] = useState<Record<string, "friend" | "family">>({});
  const [sharingConnection, setSharingConnection] = useState<{ id: string; name: string; history: "full" | "future" } | null>(null);
  const [filter, setFilter] = useState("all");
  const [mutes, setMutes] = useState<string[]>([]);
  const [verifiedKeys, setVerifiedKeys] = useState<{
    name: string;
    devices: Device[];
  } | null>(null);
  const action = useAction();
  async function refresh() {
    const [r, m] = await Promise.all([get("/connections"), get("/mutes")]);
    setData(r);
    setMutes(items<Json>(m).map((v) => v.target));
  }
  useEffect(() => {
    action.run(refresh);
  }, []);
  function respond(id: string, decision: "accept" | "decline", notice: string) {
    return action.run(async () => {
      let interacted = false;
      const removeListeners = () => {
        pendingFocus.current.delete(cancelFocus);
        document.removeEventListener("keydown", cancelFocus);
        document.removeEventListener("pointerdown", cancelFocus);
      };
      const cancelFocus = () => { interacted = true; removeListeners(); };
      pendingFocus.current.add(cancelFocus);
      document.addEventListener("keydown", cancelFocus);
      document.addEventListener("pointerdown", cancelFocus);
      try {
        await post(`/connections/requests/${id}/${decision}`, decision === "accept" ? { kind: incomingKind[id] || "friend", history: incomingHistory[id] || "full" } : {});
        await refresh();
        if (decision === "accept") window.dispatchEvent(new Event("porchday:connections-changed"));
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          if (!interacted) peopleHeading.current?.focus();
          resolve();
        }));
      } finally { removeListeners(); }
    }, notice);
  }
  const list = data?.items || [];
  const requests = data?.requests || [];
  const handles = new Map<string, string>(
    (data?.handles || []).map((p: Json) => [p.id || p.member_id, p.handle]),
  );
  const label = (id: string) => handles.get(id) || "member";
  const incoming = requests.filter(
    (r: Json) => r.recipient === vault.member.id,
  );
  const outgoing = requests.filter((r: Json) => r.sender === vault.member.id);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      await post("/connections/requests", {
        handle: handle.replace(/^@/, "").toLowerCase(),
        kind,
        history,
      });
      setHandle("");
      await refresh();
    }, "Connection request sent.");
  }
  return (
    <>
      <div className="page-heading">
        <h1>Connections</h1>
        <p>
          Up to 300 mutual connections, including family.
        </p>
      </div>
      <section className="panel">
        <div className="section-title">
          <h2>Find someone you know</h2>
          <Icon name="people" />
        </div>
        <form className="connection-search" onSubmit={send}>
          <Field
            label="Their exact handle"
            placeholder="@yourfriend"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={25}
            required
          />
          <ConnectionKindChoice value={kind} onChange={setKind} disabled={action.busy || vault.member.status === "restricted"} />
          <HistoryChoice value={history} onChange={setHistory} disabled={action.busy || vault.member.status === "restricted"} />
          <Button
            variant="primary"
            busy={action.busy}
            disabled={
              list.length >= 300 || vault.member.status === "restricted"
            }
          >
            Send request <Icon name="arrow" size={16} />
          </Button>
        </form>
        <p className="small-copy">
          Your handle is <strong>@{vault.member.handle}</strong>. Your label
          controls whether this person can see your friends-only or family-only
          posts. Each person chooses their own label.
        </p>
        <Alert>{action.error}</Alert>
        <Alert success>{action.notice}</Alert>
      </section>
      <PlatformInvitation canInvite={vault.member.status === "active"} />
      {incoming.length > 0 && (
        <section className="panel">
          <h2>Connection requests</h2>
          <p>
            Choose your label and whether to share your earlier posts with each
            person. Their choices for their own posts are separate. Save
            your profile again to share its details and photos with new
            connections.
          </p>
          <div className="member-list">
            {incoming.map((r: Json) => (
              <div className="member-row connection-request-row" key={r.id}>
                <MemberAvatar memberId={r.sender} name={label(r.sender)} />
                <div className="member-info">
                  <strong>@{label(r.sender)}</strong>
                  <small>Wants to connect</small>
                </div>
                <div className="history-choice">
                  <ConnectionKindChoice value={incomingKind[r.id] || "friend"} onChange={value => setIncomingKind(previous => ({ ...previous, [r.id]: value }))} disabled={action.busy || vault.member.status === "restricted"} />
                  <HistoryChoice value={incomingHistory[r.id] || "full"} onChange={value => setIncomingHistory(previous => ({ ...previous, [r.id]: value }))} disabled={action.busy || vault.member.status === "restricted"} />
                </div>
                <div className="button-row">
                  <Button
                    variant="primary compact"
                    aria-label={`Accept connection request from @${label(r.sender)}`}
                    busy={action.busy}
                    disabled={list.length >= 300 || vault.member.status === "restricted"}
                    onClick={() =>
                      respond(r.id, "accept", `Connected with @${label(r.sender)}.`)
                    }
                  >
                    Accept
                  </Button>
                  <Button
                    variant="quiet compact"
                    aria-label={`Decline connection request from @${label(r.sender)}`}
                    disabled={vault.member.status === "restricted"}
                    onClick={() =>
                      respond(r.id, "decline", `Declined the request from @${label(r.sender)}.`)
                    }
                  >
                    Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="panel">
        <div className="section-title">
          <h2 ref={peopleHeading} tabIndex={-1}>Your connections</h2>
          <span className="count-badge">{list.length} / 300</span>
        </div>
        <div className="tabs" role="group" aria-label="Connection filter">
          {["all", "friend", "family"].map((f) => (
            <button
              key={f}
              className={filter === f ? "active" : ""}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "Everyone" : f === "friend" ? "Friends" : "Family"}
            </button>
          ))}
        </div>
        {!data ? (
          <Loading />
        ) : !list.length ? (
          <Empty icon="people" title="No connections yet">
            Find a friend by their exact handle. We don’t upload contact books
            or recommend strangers.
          </Empty>
        ) : (
          <div className="member-list">
            {list
              .filter((r: Json) => filter === "all" || r.kind === filter)
              .map((r: Json) => {
                const other =
                  r.member_a === vault.member.id ? r.member_b : r.member_a;
                return (
                  <div className="member-row" key={r.id}>
                    <MemberAvatar memberId={other} name={label(other)} />
                    <a className="member-info" href={`/app/wall/${other}`}>
                      <strong>@{label(other)}</strong>
                      <small>
                        Your label: {r.kind === "family" ? "Family" : "Friend"}
                        {mutes.includes(other) ? " · muted in Home" : ""}
                      </small>
                    </a>
                    <details className="row-options">
                      <summary aria-label={`Options for ${label(other)}`}>
                        <Icon name="more" />
                      </summary>
                      <div className="dropdown-menu">
                        <button disabled={vault.member.status === "restricted"} onClick={() => setSharingConnection({ id: r.id, name: label(other), history: r.own_history === "full" ? "full" : "future" })}>
                          Post sharing
                        </button>
                        <button
                          onClick={() =>
                            action.run(async () => {
                              const directory = await get(
                                "/audiences?audience=connections",
                              );
                              setVerifiedKeys({
                                name: label(other),
                                devices: items<Device>(directory).filter(
                                  (d) => d.member_id === other,
                                ),
                              });
                            })
                          }
                        >
                          Verify encryption keys
                        </button>
                        <button
                          onClick={() =>
                            action.run(async () => {
                              if (mutes.includes(other))
                                await del(`/mutes/${other}`);
                              else
                                await request(`/mutes/${other}`, {
                                  method: "PUT",
                                });
                              await refresh();
                            })
                          }
                        >
                          {mutes.includes(other)
                            ? "Unmute in Home"
                            : "Mute in Home"}
                        </button>
                        <button
                          disabled={action.busy || vault.member.status === "restricted"}
                          onClick={() =>
                            action.run(async () => {
                              await request(`/connections/${r.id}/kind`, {
                                method: "PUT",
                                body: JSON.stringify({
                                  kind: r.kind === "friend" ? "family" : "friend",
                                }),
                              });
                              await refresh();
                              window.dispatchEvent(new Event("porchday:connections-changed"));
                            }, "Your label was updated.")
                          }
                        >
                          Label as {r.kind === "friend" ? "family" : "friend"}
                        </button>
                        <button
                          disabled={vault.member.status === "restricted"}
                          onClick={() => {
                            if (
                              confirm(
                                "Remove this connection? Neither of you will have access to the other’s connection-only posts.",
                              )
                            )
                              action.run(async () => {
                                await del(`/connections/${r.id}`);
                                window.dispatchEvent(new Event("porchday:connections-changed"));
                                await refresh();
                              });
                          }}
                        >
                          Remove connection
                        </button>
                        <button
                          onClick={() => {
                            if (
                              confirm(
                                "Block this person? This also hides their content in shared groups.",
                              )
                            )
                              action.run(async () => {
                                await request(`/blocks/${other}`, {
                                  method: "PUT",
                                });
                                window.dispatchEvent(new Event("porchday:connections-changed"));
                                await refresh();
                              });
                          }}
                        >
                          Block
                        </button>
                      </div>
                    </details>
                  </div>
                );
              })}
          </div>
        )}
      </section>
      {outgoing.length > 0 && (
        <section className="panel">
          <h2>Sent requests</h2>
          {outgoing.map((r: Json) => (
            <div className="member-row" key={r.id}>
              <MemberAvatar memberId={r.recipient} name={label(r.recipient)} />
              <div className="member-info">
                <strong>@{label(r.recipient)}</strong>
                <small>Request pending · Your label: {r.kind === "family" ? "Family" : "Friend"}</small>
              </div>
              <Button
                variant="quiet compact"
                aria-label={`Cancel connection request to @${label(r.recipient)}`}
                disabled={vault.member.status === "restricted"}
                onClick={() =>
                  respond(r.id, "decline", `Canceled the request to @${label(r.recipient)}.`)
                }
              >
                Cancel
              </Button>
            </div>
          ))}
        </section>
      )}
      {sharingConnection && (
        <Modal title="Post sharing" onClose={() => setSharingConnection(null)}>
          <p>Share your posts with <strong>@{sharingConnection.name}</strong>.</p>
          <HistoryChoice value={sharingConnection.history} onChange={history => setSharingConnection(previous => previous && ({ ...previous, history }))} disabled={action.busy} />
          <p>Full history includes your earlier posts and photos whose audience allows this connection. Only me posts, expired posts, and earlier comments and reactions stay excluded.</p>
          <p>Earlier posts are shared while your account is unlocked. Choosing only new posts does not take back posts already shared.</p>
          <Alert>{action.error}</Alert>
          <Button variant="primary" busy={action.busy} disabled={vault.member.status === "restricted"} onClick={() => action.run(async () => {
            await request(`/connections/${sharingConnection.id}/history`, { method: "PUT", body: JSON.stringify({ history: sharingConnection.history }) });
            await refresh(); setSharingConnection(null);
            window.dispatchEvent(new Event("porchday:connections-changed"));
          }, "Post sharing updated.")}>Save</Button>
        </Modal>
      )}
      {verifiedKeys && (
        <Modal
          title={`Verify @${verifiedKeys.name}`}
          onClose={() => setVerifiedKeys(null)}
        >
          <p>
            Compare the full device fingerprints with your friend through a
            trusted channel. A new device has a different fingerprint.
          </p>
          {verifiedKeys.devices.map((d) => (
            <div key={d.id}>
              <p className="small-copy">Device {d.id}</p>
              <Fingerprint device={d} />
            </div>
          ))}
          <Button variant="primary" onClick={() => setVerifiedKeys(null)}>
            Done
          </Button>
        </Modal>
      )}
    </>
  );
}
export function HistoryChoice({ value, onChange, disabled }: { value: "full" | "future"; onChange: (value: "full" | "future") => void; disabled?: boolean }) {
  return <label className="field history-choice">
    <span>Share your posts</span>
    <select aria-label="Share your posts" value={value} disabled={disabled} onChange={event => onChange(event.target.value as "full" | "future")}>
      <option value="full">Share full history (recommended)</option>
      <option value="future">Only share new posts</option>
    </select>
  </label>;
}
export function ConnectionKindChoice({ value, onChange, disabled }: { value: "friend" | "family"; onChange: (value: "friend" | "family") => void; disabled?: boolean }) {
  return <label className="field">
    <span>Your label</span>
    <select aria-label="Your label" value={value} disabled={disabled} onChange={event => onChange(event.target.value as "friend" | "family")}>
      <option value="friend">Friend</option>
      <option value="family">Family</option>
    </select>
  </label>;
}
export function Groups() {
  const vault = useVault();
  const [groups, setGroups] = useState<Json[] | null>(null);
  const [invites, setInvites] = useState<Json[]>([]);
  const [create, setCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const action = useAction();
  async function refresh() {
    const r = await get("/groups");
    const decoded = await Promise.all(
      items<Json>(r).map(async (g) => {
        try {
          return {
            ...g,
            content: await vault.open({ envelope: g.envelope, id: g.id }),
          };
        } catch {
          return {
            ...g,
            content: {
              name: "Private group",
              description:
                "The group owner needs to share its details with your device.",
            },
          };
        }
      }),
    );
    setGroups(decoded);
    setInvites(r.invitations || []);
  }
  useEffect(() => {
    action.run(refresh);
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const envelope = await vault.seal(
        { name, description },
        { kind: "group", audience: "only_me" },
      );
      const r = await post("/groups", { envelope });
      setCreate(false);
      navigate(`/app/groups/${r.id}`);
    });
  }
  return (
    <>
      <div className="page-heading">
        <div className="section-title">
          <h1>Groups</h1>
          <Button
            variant="primary compact"
            disabled={vault.member.status === "restricted"}
            onClick={() => setCreate(true)}
          >
            <Icon name="plus" size={18} />
            New group
          </Button>
        </div>
      </div>
      <Alert>{action.error}</Alert>
      {invites.length > 0 && (
        <section className="panel">
          <h2>You’re invited</h2>
          {invites.map((inv) => (
            <div className="member-row" key={inv.id}>
              <span className="feature-icon lavender">
                <Icon name="group" />
              </span>
              <div className="member-info">
                <strong>A private group invitation</strong>
                <small>
                  Details are shared after you join and the owner shares its
                  keys.
                </small>
              </div>
              <Button
                variant="primary compact"
                busy={action.busy}
                disabled={vault.member.status === "restricted"}
                onClick={() =>
                  action.run(async () => {
                    await post(`/group-invitations/${inv.id}/accept`);
                    await refresh();
                  })
                }
              >
                Accept
              </Button>
            </div>
          ))}
        </section>
      )}
      {groups === null ? (
        <Loading />
      ) : !groups.length ? (
        <section className="panel">
          <Empty
            icon="group"
            title="No groups yet"
            action={
              <Button
                variant="outline"
                disabled={vault.member.status === "restricted"}
                onClick={() => setCreate(true)}
              >
                Create group
              </Button>
            }
          >
            Invite existing members by handle. Group
            membership doesn’t use a friend slot.
          </Empty>
        </section>
      ) : (
        <div className="group-grid">
          {groups.map((g, i) => (
            <a
              className={`group-card ${["sage", "apricot", "lavender"][i % 3]}`}
              key={g.id}
              href={`/app/groups/${g.id}`}
            >
              <span className="group-art">
                <Icon name={["leaf", "sun", "group"][i % 3]} size={46} />
              </span>
              <span className="tiny-label">
                <Icon name="lock" size={12} /> PRIVATE GROUP
              </span>
              <h2>{g.content.name}</h2>
              <p>
                {g.content.description || "Private group"}
              </p>
              <span className="text-link">
                Open group <Icon name="arrow" size={17} />
              </span>
            </a>
          ))}
        </div>
      )}
      {create && (
        <Modal title="Create group" onClose={() => setCreate(false)}>
          <form onSubmit={submit} className="form-stack">
            <p>
              Groups are private and invitation-only. Names and descriptions are
              encrypted for members.
            </p>
            <Field
              label="Group name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
            <label className="field">
              <span>Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={1000}
              />
            </label>
            <Alert>{action.error}</Alert>
            <Button variant="primary" busy={action.busy}>
              Create group <Icon name="arrow" />
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
export function GroupInvitationList({ invitations }: { invitations: Json[] }) {
  return invitations.length ? (
    <ul className="form-stack">
      {invitations.map(invitation => (
        <li key={invitation.id}>
          <strong>{invitation.recipient_handle ? `@${invitation.recipient_handle}` : "Unavailable member"}</strong>
          {" · Invited by "}{invitation.inviter_handle ? `@${invitation.inviter_handle}` : "Unavailable member"}
          <small>{" · "}{invitation.accepted_at ? "Accepted" : Date.parse(invitation.expires_at) > Date.now() ? "Pending" : "Expired"}</small>
        </li>
      ))}
    </ul>
  ) : <p>No group invitations yet.</p>;
}

export function GroupDetail({ id }: { id: string }) {
  const vault = useVault();
  const [data, setData] = useState<Json | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [manage, setManage] = useState(false);
  const [invitations, setInvitations] = useState<Json[]>([]);
  const [invitationCursor, setInvitationCursor] = useState<string | null>(null);
  async function loadInvitations(more = false) {
    const result = await get(`/groups/${id}/invitations${more && invitationCursor ? `?cursor=${encodeURIComponent(invitationCursor)}` : ""}`);
    setInvitations(previous => more ? [...previous, ...result.items] : result.items);
    setInvitationCursor(result.next_cursor);
  }
  const [image, setImage] = useState<PendingAsset | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const uploadAsset = useAssetUpload();
  const action = useAction();
  async function refresh() {
    const r = await get(`/groups/${id}`);
    setData(r);
    if (r.group.owner_id === vault.member.id) await loadInvitations();
    else { setInvitations([]); setInvitationCursor(null); }
    try {
      setContent(await vault.open(r.group));
    } catch {
      setContent({
        name: "Private group",
        description:
          "Ask the owner to share updated group details with your device.",
      });
    }
  }
  useEffect(() => {
    action.run(refresh);
  }, [id]);
  const own = data?.group.owner_id === vault.member.id;
  const myRole = data?.members.find(
    (m: Json) => m.member_id === vault.member.id,
  )?.role;
  async function reshare() {
    if (!content || !data) return;
    await action.run(async () => {
      const plan = planSurfacePhotos(
        content,
        ["image"],
        { image },
        { image: removeImage },
      );
      const next = plan.payload;
      for (const { asset } of plan.uploads)
        next.image = await uploadAsset(asset, id, id);
      const envelope = await vault.seal(next, {
        id,
        kind: "group",
        audience: "group",
        groupId: id,
        createdAt: data.group.envelope.context.createdAt,
        revision: (data.group.envelope?.context.revision || 0) + 1,
      });
      await request(`/groups/${id}`, {
        method: "PUT",
        body: JSON.stringify({ envelope, remove_media: plan.remove_media }),
      });
      setData({ ...data, group: { ...data.group, envelope } });
      setContent(next);
      setImage(null);
      setRemoveImage(false);
      if (next.image)
        await request(`/media/${(next.image as MediaPayload).id}/attachment`, {
          method: "PUT",
          body: JSON.stringify({ kind: "group", target_id: id, slot: "image" }),
        });
      await refresh();
    }, "Group details shared with current members. Existing posts remain unchanged.");
  }
  return (
    <>
      <div className="group-banner">
        {!!content?.image && (
          <div className="group-image">
            <EncryptedPhoto media={content.image as MediaPayload} />
          </div>
        )}
        <Icon name="group" size={44} />
        <span className="eyebrow">PRIVATE GROUP</span>
        <h1>{content?.name || "Your group"}</h1>
        <p>{content?.description || "Loading group…"}</p>
        <div>
          <span>
            <Icon name="lock" size={14} />
            {data?.members?.length || 0} members
          </span>
          <Button variant="outline compact" onClick={() => setManage(!manage)}>
            Members & settings
          </Button>
        </div>
      </div>
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
      {manage && data && (
        <section className="panel form-stack">
          <h2>Group members</h2>
          {["owner", "moderator"].includes(myRole) &&
            vault.member.status !== "restricted" && (
              <GroupInviteForm
                key={id}
                memberId={vault.member.id}
                members={data.members}
                onInvite={async handle => {
                  await post(`/groups/${id}/invitations`, { handle });
                  await refresh();
                }}
              />
            )}
          {data.members.map((m: Json) => {
            const handle =
              data.handles.find(
                (h: Json) => (h.id || h.member_id) === m.member_id,
              )?.handle || "member";
            return (
              <div className="member-row" key={m.member_id}>
                <MemberAvatar memberId={m.member_id} name={handle} />
                <div className="member-info">
                  <strong>@{handle}</strong>
                  <small>{m.role}</small>
                </div>
                {own &&
                  m.member_id !== vault.member.id &&
                  vault.member.status !== "restricted" && (
                    <details className="row-options">
                      <summary>
                        <Icon name="more" />
                      </summary>
                      <div className="dropdown-menu">
                        <button
                          onClick={() =>
                            action.run(async () => {
                              await request(
                                `/groups/${id}/members/${m.member_id}`,
                                {
                                  method: "PUT",
                                  body: JSON.stringify({
                                    role:
                                      m.role === "moderator"
                                        ? "member"
                                        : "moderator",
                                  }),
                                },
                              );
                              await refresh();
                            })
                          }
                        >
                          {m.role === "moderator"
                            ? "Make member"
                            : "Make moderator"}
                        </button>
                        <button
                          onClick={() => {
                            if (
                              confirm(`Transfer group ownership to @${handle}?`)
                            )
                              action.run(async () => {
                                await request(
                                  `/groups/${id}/members/${m.member_id}`,
                                  {
                                    method: "PUT",
                                    body: JSON.stringify({ role: "owner" }),
                                  },
                                );
                                await refresh();
                              });
                          }}
                        >
                          Transfer ownership
                        </button>
                        <button
                          onClick={() =>
                            action.run(async () => {
                              await del(`/groups/${id}/members/${m.member_id}`);
                              await refresh();
                            })
                          }
                        >
                          Remove member
                        </button>
                      </div>
                    </details>
                  )}
              </div>
            );
          })}
          {own && (
            <section aria-label="Group invitations">
              <h3>Group invitations</h3>
              <p>The latest invitation for each person.</p>
              <GroupInvitationList invitations={invitations} />
              {invitationCursor && <Button busy={action.busy} onClick={() => action.run(() => loadInvitations(true))}>Load more invitations</Button>}
            </section>
          )}
          {own && vault.member.status !== "restricted" && (
            <>
              <Field
                label="Group name"
                value={content?.name || ""}
                maxLength={80}
                onChange={(e) =>
                  setContent((p) => ({ ...p, name: e.target.value }))
                }
              />
              <label className="field">
                <span>Group description</span>
                <textarea
                  value={content?.description || ""}
                  maxLength={1000}
                  rows={3}
                  onChange={(e) =>
                    setContent((p) => ({ ...p, description: e.target.value }))
                  }
                />
              </label>
              <AssetPicker
                slot="image"
                label="Group image"
                asset={image}
                current={content?.image as MediaPayload | undefined}
                removed={removeImage}
                disabled={action.busy}
                onRemovalChange={setRemoveImage}
                onChange={(asset) => {
                  setImage(asset);
                  if (asset) setRemoveImage(false);
                }}
              />
              <Button variant="outline" busy={action.busy} onClick={reshare}>
                Save group details & share with current members
              </Button>
            </>
          )}
          <p className="small-copy">
            New members receive future posts. Sharing group details does not
            grant access to historical posts. Removed members lose service
            access; previously saved copies cannot be recalled.
          </p>
          <Button
            variant="danger"
            disabled={!own && vault.member.status === "restricted"}
            onClick={() => {
              if (
                confirm(
                  own
                    ? "Delete the whole group and its content?"
                    : "Leave this group? You’ll lose access to its content.",
                )
              )
                action.run(async () => {
                  await del(
                    own
                      ? `/groups/${id}`
                      : `/groups/${id}/members/${vault.member.id}`,
                  );
                  navigate("/app/groups");
                });
            }}
          >
            {own ? "Delete group" : "Leave group"}
          </Button>
        </section>
      )}
      <Feed
        groupId={id}
        canModerate={["owner", "moderator"].includes(myRole)}
      />
    </>
  );
}
export const THEMES = [
  {
    id: "sage",
    label: "Green",
    description: "Green and cream",
  },
  {
    id: "apricot",
    label: "Peach",
    description: "Peach and cream",
  },
  {
    id: "lavender",
    label: "Purple",
    description: "Purple and cream",
  },
  {
    id: "ink",
    label: "Blue",
    description: "Blue and cream",
  },
];
export function Wall({ id }: { id?: string }) {
  const vault = useVault();
  const own = !id || id === vault.member.id;
  const memberId = id || vault.member.id;
  const target = vault.member.id + ":" + vault.device.id + ":" + memberId;
  const [loaded, setLoaded] = useState<{target:string;profile:Content|null;handle:string}>({target,profile:null,handle:own?vault.member.handle:""});
  const profile = loaded.target === target ? loaded.profile : null;
  const handle = loaded.target === target ? loaded.handle : own ? vault.member.handle : "";
  const [standard, setStandard] = useState(false);
  const [version, setVersion] = useState(0);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let canceled = false;
    const controller = new AbortController();
    setLoadError("");
    void (async () => {
      const r = own
        ? await request("/me", {signal:controller.signal})
        : await request(`/profiles/member/${memberId}`, {signal:controller.signal});
      if (canceled) return;
      let content: Content | null = null;
      if (r.envelope) {
        try {
          content = await vault.open({ envelope: r.envelope, id: memberId });
        } catch { /* Unavailable encrypted content remains hidden. */ }
      }
      if (!canceled) setLoaded({target,profile:content,handle:r.handle || ""});
    })().catch(() => { if (!canceled) setLoadError("Could not load this profile. Please try again."); });
    return () => { canceled = true; controller.abort(); };
  }, [target, own ? vault.profileVersion : 0]);
  useEffect(() => { setStandard(false); }, [target]);
  const theme = standard ? "sage" : String(profile?.theme || "sage");
  const wallpaper = standard ? "none" : wallpaperId(profile?.wallpaper);
  return (
    <div className={`personal-wall wallpaper-${wallpaper}`}>
      <section
        className={`wall-header theme-${THEMES.some((t) => t.id === theme) ? theme : "sage"} ${!standard && profile?.font === "sans" ? "profile-font-sans" : ""} ${!standard && profile?.sectionOrder === "interests-first" ? "interests-first" : ""}`}
      >
        <div className="wall-cover">
          {profile?.cover && (
            <div className="profile-cover-photo">
              <EncryptedPhoto media={profile.cover as MediaPayload} />
            </div>
          )}
          {profile?.status && <span>{profile.status}</span>}
        </div>
        <div className="wall-profile" style={{flexWrap:"wrap"}}>
          <MemberAvatar memberId={id || vault.member.id}
            name={String(profile?.displayName || handle || "?")} size="large" theme={theme} />
          <div style={{flex:"1 1 12rem",minWidth:0,overflowWrap:"anywhere"}}>
            <h1>{profile?.displayName || `@${handle || "Member"}`}</h1>
            <p>@{handle || "private"}</p>
          </div>
          {own ? (
            <a href="/app/settings/profile" className="button outline compact">
              <Icon name="edit" size={16} />
              Edit profile
            </a>
          ) : (
            <button
              className="text-button"
              onClick={() => setStandard(!standard)}
            >
              {standard ? "View personal theme" : "Use standard theme"}
            </button>
          )}
        </div>
        {profile?.background && !standard && (
          <div className="profile-background-preview">
            <EncryptedPhoto media={profile.background as MediaPayload} />
          </div>
        )}
        {profile?.bio && <p className="profile-bio">{profile.bio}</p>}
        {profile?.interests && (
          <div className="interest-tags">
            {String(profile.interests)
              .split(",")
              .filter(Boolean)
              .map((v) => (
                <span key={v}>{v.trim()}</span>
              ))}
          </div>
        )}
      </section>
      <Alert>{loadError}</Alert>
      {own && <Composer onPosted={() => setVersion((v) => v + 1)} />}
      <Feed key={version} wallId={memberId} />
    </div>
  );
}
export function Notifications() {
  const [rows, setRows] = useState<Json[] | null>(null);
  const action = useAction();
  async function refresh() {
    setRows(items<Json>(await get("/notifications")));
  }
  useEffect(() => {
    action.run(refresh);
  }, []);
  const title: Record<string, string> = {
    connection_request: "Connection request",
    connection_accepted: "Connection accepted",
    comment: "New comment",
    reaction: "New reaction",
    group_invitation: "Group invitation",
    post: "New post",
    security: "Account security update",
  };
  return (
    <>
      <div className="page-heading">
        <h1>Notifications</h1>
      </div>
      <section className="panel">
        <Alert>{action.error}</Alert>
        {rows === null ? (
          <Loading />
        ) : !rows.length ? (
          <Empty icon="bell" title="No notifications">
            When someone connects or joins a conversation, you’ll see an update
            here.
          </Empty>
        ) : (
          <div className="notification-list">
            {rows.map((r) => (
              <button
                className={`notification-row ${r.read_at ? "" : "unread"}`}
                key={r.id}
                onClick={() =>
                  action.run(async () => {
                    await request(`/notifications/${r.id}/read`, {
                      method: "PUT",
                    });
                    navigate(notificationPath(r));
                  })
                }
              >
                {r.actor ? <MemberAvatar memberId={r.actor} /> : (
                  <span className="feature-icon sage"><Icon name="bell" /></span>
                )}
                <span>
                  <strong>{r.kind === "invitation_joined"
                    ? (invitationHandle(r.actor_handle) ? `@${r.actor_handle} joined Porchday` : "Someone you invited joined Porchday")
                    : title[r.kind] || "You have a new update"}</strong>
                  <small>
                    {relativeDate(r.created_at)} · {r.kind === "invitation_joined"
                      ? "Send a connection request" : "Private details stay in the app"}
                  </small>
                </span>
                <Icon name="arrow" size={17} />
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
