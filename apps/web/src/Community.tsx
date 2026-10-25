import React, { useEffect, useState } from "react";
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
  Avatar,
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
export function Connections() {
  const vault = useVault();
  const [data, setData] = useState<Json | null>(null);
  const [handle, setHandle] = useState("");
  const [kind, setKind] = useState("friend");
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
  const list = data?.items || [];
  const requests = data?.requests || [];
  const handles = new Map<string, string>(
    (data?.handles || []).map((p: Json) => [p.id || p.member_id, p.handle]),
  );
  const label = (id: string) => handles.get(id) || "circle member";
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
      });
      setHandle("");
      await refresh();
    }, "Your invitation to connect is on its way.");
  }
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">PEOPLE, NOT AN AUDIENCE</span>
        <h1>
          Your circle<span className="coral">.</span>
        </h1>
        <p>
          Friendship goes both ways. There’s room for up to 300 people,
          including family.
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
          <label className="field">
            <span>Connection</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="friend">Friend</option>
              <option value="family">Family</option>
            </select>
          </label>
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
          Your handle is <strong>@{vault.member.handle}</strong>. Family
          includes chosen family. This label is agreed by both people.
        </p>
        <Alert>{action.error}</Alert>
        <Alert success>{action.notice}</Alert>
      </section>
      {incoming.length > 0 && (
        <section className="panel">
          <h2>A hello, waiting for you</h2>
          <p>
            Accepting connects you for future eligible posts. Existing encrypted
            history stays private unless its author explicitly shares it. Save
            your profile again to share its details and photos with new
            connections.
          </p>
          <div className="member-list">
            {incoming.map((r: Json) => (
              <div className="member-row" key={r.id}>
                <Avatar name={label(r.sender)} />
                <div className="member-info">
                  <strong>@{label(r.sender)}</strong>
                  <small>
                    Wants to connect as{" "}
                    {r.kind === "family" ? "family" : "a friend"}
                  </small>
                </div>
                <div className="button-row">
                  <Button
                    variant="primary compact"
                    busy={action.busy}
                    disabled={vault.member.status === "restricted"}
                    onClick={() =>
                      action.run(async () => {
                        await post(`/connections/requests/${r.id}/accept`);
                        await refresh();
                      })
                    }
                  >
                    Accept
                  </Button>
                  <Button
                    variant="quiet compact"
                    disabled={vault.member.status === "restricted"}
                    onClick={() =>
                      action.run(async () => {
                        await post(`/connections/requests/${r.id}/decline`);
                        await refresh();
                      })
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
          <h2>Your people</h2>
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
          <Empty icon="people" title="Every circle starts with a hello.">
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
                    <Avatar name={label(other)} />
                    <a className="member-info" href={`/app/wall/${other}`}>
                      <strong>@{label(other)}</strong>
                      <small>
                        {r.kind === "family" ? "Family" : "Friend"}
                        {mutes.includes(other) ? " · muted in Home" : ""}
                        {r.proposed_kind
                          ? ` · ${r.proposed_kind} label awaiting agreement`
                          : ""}
                      </small>
                    </a>
                    <details className="row-options">
                      <summary aria-label={`Options for ${label(other)}`}>
                        <Icon name="more" />
                      </summary>
                      <div className="dropdown-menu">
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
                          disabled={vault.member.status === "restricted"}
                          onClick={() =>
                            action.run(async () => {
                              await request(`/connections/${r.id}/kind`, {
                                method: "PUT",
                                body: JSON.stringify({
                                  kind:
                                    r.proposed_kind ||
                                    (r.kind === "friend" ? "family" : "friend"),
                                }),
                              });
                              await refresh();
                            }, "Changing the label needs agreement from both people.")
                          }
                        >
                          {r.proposed_kind
                            ? "Agree to label change"
                            : `Ask to label as ${r.kind === "friend" ? "family" : "friend"}`}
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
              <Avatar name={label(r.recipient)} />
              <div className="member-info">
                <strong>@{label(r.recipient)}</strong>
                <small>Waiting for a hello back</small>
              </div>
              <Button
                variant="quiet compact"
                disabled={vault.member.status === "restricted"}
                onClick={() =>
                  action.run(async () => {
                    await post(`/connections/requests/${r.id}/decline`);
                    await refresh();
                  })
                }
              >
                Cancel
              </Button>
            </div>
          ))}
        </section>
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
        <span className="eyebrow">A FEW PEOPLE. A SHARED THING.</span>
        <div className="section-title">
          <h1>
            Your groups<span className="coral">.</span>
          </h1>
          <Button
            variant="primary compact"
            disabled={vault.member.status === "restricted"}
            onClick={() => setCreate(true)}
          >
            <Icon name="plus" size={18} />
            New group
          </Button>
        </div>
        <p>
          The book club. The cousins. The people who always say yes to a walk.
        </p>
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
            title="Good things happen in small groups."
            action={
              <Button
                variant="outline"
                disabled={vault.member.status === "restricted"}
                onClick={() => setCreate(true)}
              >
                Start your first group
              </Button>
            }
          >
            A private room for a shared interest. Invite people by handle; group
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
                {g.content.description || "A little space to come together."}
              </p>
              <span className="text-link">
                Step inside <Icon name="arrow" size={17} />
              </span>
            </a>
          ))}
        </div>
      )}
      {create && (
        <Modal title="Make a little gathering" onClose={() => setCreate(false)}>
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
              <span>What brings you together?</span>
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
export function GroupDetail({ id }: { id: string }) {
  const vault = useVault();
  const [data, setData] = useState<Json | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [manage, setManage] = useState(false);
  const [handle, setHandle] = useState("");
  const [image, setImage] = useState<PendingAsset | null>(null);
  const uploadAsset = useAssetUpload();
  const action = useAction();
  async function refresh() {
    const r = await get(`/groups/${id}`);
    setData(r);
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
      const next = { ...content };
      const imageSource = image || (content.image as MediaPayload | undefined);
      if (imageSource) next.image = await uploadAsset(imageSource, id, id);
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
        body: JSON.stringify({ envelope }),
      });
      if (next.image)
        await request(`/media/${(next.image as MediaPayload).id}/attachment`, {
          method: "PUT",
          body: JSON.stringify({ kind: "group", target_id: id, slot: "image" }),
        });
      setImage(null);
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
        <span className="eyebrow">YOUR PRIVATE GATHERING</span>
        <h1>{content?.name || "Your group"}</h1>
        <p>{content?.description || "Opening this little corner…"}</p>
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
          <h2>People at the table</h2>
          {["owner", "moderator"].includes(myRole) &&
            vault.member.status !== "restricted" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  action.run(async () => {
                    await post(`/groups/${id}/invitations`, {
                      handle: handle.replace(/^@/, ""),
                    });
                    setHandle("");
                  }, "Invitation sent. Share the group details again after they join.");
                }}
                className="inline-form"
              >
                <Field
                  label="Invite by exact handle"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  required
                />
                <Button variant="primary compact" busy={action.busy}>
                  Invite
                </Button>
              </form>
            )}
          {data.members.map((m: Json) => {
            const handle =
              data.handles.find(
                (h: Json) => (h.id || h.member_id) === m.member_id,
              )?.handle || "member";
            return (
              <div className="member-row" key={m.member_id}>
                <Avatar name={handle} />
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
                onChange={setImage}
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
    label: "Sunday garden",
    description: "Soft greens & slow mornings",
  },
  {
    id: "apricot",
    label: "Golden hour",
    description: "Warm peach & good company",
  },
  {
    id: "lavender",
    label: "After the rain",
    description: "Lilac & a little daydreaming",
  },
  {
    id: "ink",
    label: "Library afternoon",
    description: "Quiet blues & well-loved books",
  },
];
export function Wall({ id }: { id?: string }) {
  const vault = useVault();
  const own = !id || id === vault.member.id;
  const memberId = id || vault.member.id;
  const [profile, setProfile] = useState<Content | null>(null);
  const [handle, setHandle] = useState(own ? vault.member.handle : "");
  const [standard, setStandard] = useState(false);
  const [version, setVersion] = useState(0);
  const action = useAction();
  useEffect(() => {
    action.run(async () => {
      const r = own
        ? await get("/me")
        : await get(`/profiles/member/${memberId}`);
      setHandle(r.handle || "");
      if (r.envelope) {
        try {
          setProfile(await vault.open({ envelope: r.envelope, id: memberId }));
        } catch {
          setProfile(null);
        }
      } else setProfile(null);
    });
  }, [memberId]);
  const theme = standard ? "sage" : String(profile?.theme || "sage");
  return (
    <>
      <section
        className={`wall-header theme-${THEMES.some((t) => t.id === theme) ? theme : "sage"} ${!standard && profile?.font === "sans" ? "profile-font-sans" : ""} ${!standard && profile?.sectionOrder === "interests-first" ? "interests-first" : ""}`}
      >
        <div className="wall-cover">
          {profile?.cover && (
            <div className="profile-cover-photo">
              <EncryptedPhoto media={profile.cover as MediaPayload} />
            </div>
          )}
          <span>{profile?.status || "ordinary days. good company."}</span>
          <span aria-hidden="true">✳</span>
        </div>
        <div className="wall-profile">
          {profile?.avatar ? (
            <span className="avatar large profile-avatar-photo">
              <EncryptedPhoto media={profile.avatar as MediaPayload} />
            </span>
          ) : (
            <Avatar
              name={String(profile?.displayName || handle || "?")}
              size="large"
              theme={theme}
            />
          )}
          <div>
            <span className="eyebrow">
              {own ? "YOUR LITTLE CORNER" : "A FRIEND’S LITTLE CORNER"}
            </span>
            <h1>{profile?.displayName || `@${handle || "Circle member"}`}</h1>
            <p>@{handle || "private"}</p>
          </div>
          {own ? (
            <a href="/app/settings/profile" className="button outline compact">
              <Icon name="edit" size={16} />
              Make it yours
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
      <Alert>{action.error}</Alert>
      {own && <Composer onPosted={() => setVersion((v) => v + 1)} />}
      <Feed key={version} wallId={memberId} />
    </>
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
    connection_request: "Someone wants to connect",
    connection_accepted: "A connection was accepted",
    comment: "There’s a new comment",
    reaction: "Someone left a reaction",
    group_invitation: "You’re invited to a group",
    post: "A new moment from your circle",
    security: "An account security update",
  };
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">LITTLE HELLOS</span>
        <h1>
          Your updates<span className="coral">.</span>
        </h1>
        <p>No pressure to keep up. They’ll be here when you are.</p>
      </div>
      <section className="panel">
        <Alert>{action.error}</Alert>
        {rows === null ? (
          <Loading />
        ) : !rows.length ? (
          <Empty icon="bell" title="All quiet on the porch.">
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
                    const path = r.post_id
                      ? `/app/post/${r.post_id}`
                      : r.group_id
                        ? `/app/groups/${r.group_id}`
                        : "/app/connections";
                    navigate(path);
                  })
                }
              >
                <span className="feature-icon sage">
                  <Icon
                    name={r.kind?.includes("connection") ? "people" : "bell"}
                  />
                </span>
                <span>
                  <strong>{title[r.kind] || "You have a new update"}</strong>
                  <small>
                    {relativeDate(r.created_at)} · Private details stay in the
                    app
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
