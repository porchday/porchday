import React, { useEffect, useRef, useState } from "react";
import { base64ToBytes, type EncryptedEnvelope } from "@porchday/crypto";
import {
  get,
  post,
  request,
  patch,
  del,
  auth,
  items,
  localDate,
  saveFile,
  type Json,
  type Content,
  type Device,
  type SocialObject,
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
import { useVault, Fingerprint } from "./vault";
import { THEMES } from "./Community";
import { RegisterIntegration } from "./Integrations";
import { EmailSettings, MfaSettings } from "./AccountSecurity";
import { AssetPicker, useAssetUpload, type PendingAsset } from "./Media";
import { DataTransfer } from "./DataTransfer";
import { TimeSettings } from "./TimeSettings";
import { enableCurrentPush, disableAllPush } from "./push";
import { PROFILE_SLOTS, planSurfacePhotos } from "./surface-media";
import { WALLPAPERS, wallpaperId } from "./wallpaper";
export function Settings({
  tab = "profile",
  onLogout,
}: {
  tab?: string;
  onLogout: () => Promise<void>;
}) {
  return (
    <>
      <div className="page-heading">
        <h1>Settings</h1>
      </div>
      <nav className="settings-tabs" aria-label="Settings">
        {[
          ["profile", "My profile"],
          ["privacy", "Privacy & safety"],
          ["security", "Account & keys"],
          ["data", "My data"],
        ].map(([id, name]) => (
          <a
            className={tab === id ? "active" : ""}
            aria-current={tab === id ? "page" : undefined}
            href={`/app/settings/${id}`}
            key={id}
          >
            {name}
          </a>
        ))}
      </nav>
      {tab === "profile" ? (
        <ProfileSettings />
      ) : tab === "privacy" ? (
        <PrivacySettings />
      ) : tab === "security" ? (
        <SecuritySettings onLogout={onLogout} />
      ) : (
        <DataSettings onLogout={onLogout} />
      )}
    </>
  );
}
function ProfileSettings() {
  const vault = useVault();
  const [profile, setProfile] = useState<Content>({
    displayName: "",
    bio: "",
    interests: "",
    status: "",
    theme: "sage",
    font: "serif",
    sectionOrder: "about-first",
  });
  const [old, setOld] = useState<EncryptedEnvelope | null>(null);
  const [profileAudience, setProfileAudience] = useState<
    "connections" | "only_me"
  >("connections");
  const [assets, setAssets] = useState<Record<string, PendingAsset | null>>({
    avatar: null,
    cover: null,
    background: null,
  });
  const [removedAssets, setRemovedAssets] = useState<Record<string, boolean>>(
    {},
  );
  const uploadAsset = useAssetUpload();
  const action = useAction();
  useEffect(() => {
    action.run(async () => {
      const me = await get("/me");
      if (me.envelope) {
        setProfile(
          await vault.open({ envelope: me.envelope, id: vault.member.id }),
        );
        setOld(me.envelope);
        setProfileAudience(
          me.envelope.context.audience === "only_me"
            ? "only_me"
            : "connections",
        );
      }
    });
  }, []);
  const update = (field: string, value: string) =>
    setProfile((p) => ({ ...p, [field]: value }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const plan = planSurfacePhotos(
        profile,
        PROFILE_SLOTS,
        assets,
        removedAssets,
      );
      const next = plan.payload;
      const uploaded: { id: string; slot: string }[] = [];
      for (const { slot, asset } of plan.uploads) {
        const result = await uploadAsset(
          asset,
          vault.member.id,
          null,
          profileAudience,
        );
        next[slot] = result;
        uploaded.push({ id: result.id, slot });
      }
      const envelope = await vault.seal(next, {
        id: vault.member.id,
        kind: "profile",
        audience: profileAudience,
        createdAt: old?.context.createdAt || new Date().toISOString(),
        revision: (old?.context.revision || 0) + 1,
      });
      await request("/profiles/me", {
        method: "PUT",
        body: JSON.stringify({ envelope, remove_media: plan.remove_media }),
      });
      // The revised profile and removals have committed even if a later new-photo
      // attachment needs retrying. Keep the revision current for that retry.
      setOld(envelope);
      setProfile(next);
      setAssets({ avatar: null, cover: null, background: null });
      setRemovedAssets({});
      for (const asset of uploaded)
        await request(`/media/${asset.id}/attachment`, {
          method: "PUT",
          body: JSON.stringify({
            kind: "profile",
            target_id: vault.member.id,
            slot: asset.slot,
          }),
        });
    }, "Profile saved.");
  }
  if (vault.member.status === "restricted")
    return (
      <Alert>
        Profile changes are unavailable while this account is restricted. You
        can still export your profile from My data.
      </Alert>
    );
  return (
    <form onSubmit={submit} className="form-stack">
      <section className="panel form-stack">
        <h2>The person behind the handle</h2>
        <p>
          Your handle, <strong>@{vault.member.handle}</strong>, is public for
          exact lookup. Choose who can read these encrypted profile details and
          photos.
        </p>
        <label className="field">
          <span>Profile visibility</span>
          <select
            value={profileAudience}
            onChange={(e) =>
              setProfileAudience(e.target.value as "connections" | "only_me")
            }
          >
            <option value="connections">My current friends & family</option>
            <option value="only_me">Only me</option>
          </select>
          <small>
            Your handle remains available for exact lookup. Save again after
            accepting a new connection to explicitly share profile details and
            photos with them.
          </small>
        </label>
        <Field
          label="Display name"
          value={String(profile.displayName || "")}
          onChange={(e) => update("displayName", e.target.value)}
          maxLength={80}
        />
        <Field
          label="Status"
          placeholder="Add a status"
          value={String(profile.status || "")}
          onChange={(e) => update("status", e.target.value)}
          maxLength={100}
        />
        <label className="field">
          <span>About me</span>
          <textarea
            value={String(profile.bio || "")}
            onChange={(e) => update("bio", e.target.value)}
            rows={4}
            maxLength={1000}
          />
        </label>
        <Field
          label="A few things you love"
          help="Separate interests with commas."
          placeholder="Used bookstores, long walks, Sunday pancakes"
          value={String(profile.interests || "")}
          onChange={(e) => update("interests", e.target.value)}
          maxLength={300}
        />
      </section>
      <section className="panel form-stack">
        <h2>A few pictures of you</h2>
        <p>
          Photos are resized, stripped of location metadata, and encrypted on
          this device before upload.
        </p>
        <div className="profile-asset-grid">
          {PROFILE_SLOTS.map((slot) => (
            <AssetPicker
              key={slot}
              slot={slot}
              label={
                slot === "avatar"
                  ? "Profile photo"
                  : slot === "cover"
                    ? "Cover photo"
                    : "Wall background"
              }
              asset={assets[slot]}
              current={profile[slot]}
              removed={removedAssets[slot]}
              disabled={action.busy}
              onRemovalChange={(removed) =>
                setRemovedAssets((p) => ({ ...p, [slot]: removed }))
              }
              onChange={(asset) => {
                setAssets((p) => ({ ...p, [slot]: asset }));
                if (asset) setRemovedAssets((p) => ({ ...p, [slot]: false }));
              }}
            />
          ))}
        </div>
      </section>
      <section className="panel form-stack">
        <h2>Theme</h2>
        <p>
          Curated themes keep text readable and
          don’t run scripts or load outside trackers.
        </p>
        <h3>Tiled wallpaper</h3>
        <p className="small-copy">
          Pick a pattern for the space around your wall. Text and photos stay on
          readable panels. Your choice is saved with your encrypted profile.
        </p>
        <div className="wallpaper-grid" role="group" aria-label="Tiled wallpaper">
          {[{ id: "none", label: "No wallpaper", description: "Keep this wall simple" }, ...WALLPAPERS].map((wallpaper) => (
            <button
              key={wallpaper.id}
              type="button"
              className={`wallpaper-choice ${wallpaperId(profile.wallpaper) === wallpaper.id ? "chosen" : ""}`}
              aria-pressed={wallpaperId(profile.wallpaper) === wallpaper.id}
              onClick={() => update("wallpaper", wallpaper.id)}
            >
              <span className={`wallpaper-preview wallpaper-${wallpaper.id}`} aria-hidden="true" />
              <strong>{wallpaper.label}</strong>
              <small>{wallpaper.description}</small>
            </button>
          ))}
        </div>
        <h3>Profile colors</h3>
        <div className="theme-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`theme-choice ${theme.id} ${profile.theme === theme.id ? "chosen" : ""}`}
              aria-pressed={profile.theme === theme.id}
              onClick={() => update("theme", theme.id)}
            >
              <span className="theme-swatch">
                <span>Profile preview</span>
                <Icon name={theme.id === "sage" ? "leaf" : "sun"} />
              </span>
              <strong>{theme.label}</strong>
              <small>{theme.description}</small>
              {profile.theme === theme.id && (
                <span className="theme-check">
                  <Icon name="check" size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="two-fields">
          <label className="field">
            <span>Profile heading style</span>
            <select
              value={String(profile.font || "serif")}
              onChange={(e) => update("font", e.target.value)}
            >
              <option value="serif">Bookish serif</option>
              <option value="sans">Simple sans serif</option>
            </select>
          </label>
          <label className="field">
            <span>Profile sections</span>
            <select
              value={String(profile.sectionOrder || "about-first")}
              onChange={(e) => update("sectionOrder", e.target.value)}
            >
              <option value="about-first">About, then interests</option>
              <option value="interests-first">Interests, then about</option>
            </select>
          </label>
        </div>
      </section>
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
      <div className="sticky-actions">
        <p>
          <Icon name="lock" size={14} />
          Encrypted before saving
        </p>
        <Button variant="primary" busy={action.busy}>
          Save my profile <Icon name="check" size={17} />
        </Button>
      </div>
    </form>
  );
}
function PrivacySettings() {
  const vault = useVault();
  const [blocks, setBlocks] = useState<Json[]>([]);
  const [mutes, setMutes] = useState<Json[]>([]);
  const [reports, setReports] = useState<Json[]>([]);
  const [prefs, setPrefs] = useState({ in_app: true, push: false });
  const action = useAction();
  async function refresh() {
    const [b, m, r, me] = await Promise.all([
      get("/blocks"),
      get("/mutes"),
      get("/reports"),
      get("/me"),
    ]);
    setBlocks(items(b));
    setMutes(items(m));
    setReports(items(r));
    setPrefs({ ...prefs, ...me.notification_preferences });
  }
  useEffect(() => {
    action.run(refresh);
  }, []);
  async function enablePush() {
    await action.run(async () => {
      await enableCurrentPush(vault.member.id);
      await patch("/me", {
        notification_preferences: { ...prefs, push: true },
      });
      setPrefs((p) => ({ ...p, push: true }));
    }, "Notifications enabled on this browser. Push messages never include private content.");
  }
  async function disablePush() {
    await action.run(async () => {
      await disableAllPush();
      await patch("/me", {
        notification_preferences: { ...prefs, push: false },
      });
      setPrefs((p) => ({ ...p, push: false }));
    }, "Push notifications are off for all your devices. In-app preferences are unchanged.");
  }
  return (
    <>
      <section className="panel form-stack">
        <h2>Privacy and notifications</h2>
        <p>
          Share posts with friends and family, friends only, family only, or
          only yourself. Your email and connection list are private.
        </p>
        <label className="check-field">
          <input
            type="checkbox"
            checked={prefs.in_app}
            onChange={(e) =>
              action.run(async () => {
                const next = { ...prefs, in_app: e.target.checked };
                await patch("/me", { notification_preferences: next });
                setPrefs(next);
              })
            }
          />
          <span>In-app social notifications</span>
        </label>
        <Button variant="outline" busy={action.busy} onClick={enablePush}>
          <Icon name="bell" size={17} />
          {prefs.push
            ? "Enable push on this browser"
            : "Enable push notifications"}
        </Button>
        {prefs.push && (
          <Button variant="quiet" busy={action.busy} onClick={disablePush}>
            Turn off push on all devices
          </Button>
        )}
        <p className="small-copy">
          Push says only “You have a new update.” We never put post text,
          photos, or reaction choices in a notification.
        </p>
      </section>
      <TimeSettings />
      <section className="panel">
        <h2>Muted in Home</h2>
        {mutes.length ? (
          mutes.map((m) => (
            <div className="member-row" key={m.target}>
              <Avatar name="M" />
              <span className="member-info">
                A muted connection <small>{m.target}</small>
              </span>
              <Button
                variant="quiet compact"
                onClick={() =>
                  action.run(async () => {
                    await del(`/mutes/${m.target}`);
                    await refresh();
                  })
                }
              >
                Unmute
              </Button>
            </div>
          ))
        ) : (
          <p>No one is muted. Muting only changes your Home feed.</p>
        )}
      </section>
      <section className="panel">
        <h2>Blocked people</h2>
        {blocks.length ? (
          blocks.map((b) => (
            <div className="member-row" key={b.target}>
              <Avatar name="B" />
              <span className="member-info">
                Blocked account <small>{b.target}</small>
              </span>
              <Button
                variant="quiet compact"
                onClick={() =>
                  action.run(async () => {
                    await del(`/blocks/${b.target}`);
                    await refresh();
                  })
                }
              >
                Unblock
              </Button>
            </div>
          ))
        ) : (
          <p>
            You haven’t blocked anyone. Blocking hides their content and
            prevents interaction, including in shared groups.
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Reports & appeals</h2>
        {reports.length ? (
          reports.map((r) => (
            <div className="list-row" key={r.id}>
              <span>
                {r.reason} report<small>{localDate(r.created_at)}</small>
              </span>
              <span className="mini-tag">{r.status}</span>
            </div>
          ))
        ) : (
          <p>
            You have no reports yet. Use a post or comment’s report action to
            tell us about harassment, an AI agent account, or another concern.
          </p>
        )}
        <a href="/stolen-account" className="text-link">
          My account was stolen <Icon name="arrow" size={16} />
        </a>
        <a href="/appeals" className="text-link">
          Ask for an independent moderation review{" "}
          <Icon name="arrow" size={16} />
        </a>
      </section>
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
    </>
  );
}
function SecuritySettings({ onLogout }: { onLogout: () => Promise<void> }) {
  const vault = useVault();
  const [devices, setDevices] = useState<Device[]>(vault.devices);
  const [sessions, setSessions] = useState<Json[]>([]);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [selected, setSelected] = useState<Device | null>(null);
  const action = useAction();
  async function refresh() {
    const [d, s] = await Promise.all([
      get("/devices"),
      get("/api/auth/list-sessions"),
    ]);
    setDevices(items(d));
    setSessions(items(s));
  }
  useEffect(() => {
    action.run(refresh);
  }, []);
  return (
    <>
      <EmailSettings />
      <MfaSettings />
      <section className="panel form-stack">
        <h2>Your password</h2>
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(async () => {
              await auth("change-password", {
                currentPassword: current,
                newPassword: password,
                revokeOtherSessions: true,
              });
              setCurrent("");
              setPassword("");
              await onLogout();
              navigate("/login?passwordChanged=1");
            }, "Password changed. All sessions have been signed out.");
          }}
        >
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            maxLength={128}
            required
          />
          <Button variant="outline" busy={action.busy}>
            Update password
          </Button>
        </form>
        <p className="small-copy">
          Your encryption recovery secret is separate and never changes with
          your password. Changing your password signs out every session and
          clears this browser's remembered keys. Keep your recovery secret
          available to unlock after signing in again.
        </p>
      </section>
      <section className="panel">
        <h2>Trusted encryption devices</h2>
        <p>
          Review fingerprints with the person using a device. A first-seen
          fingerprint is not proof against a malicious key directory.
        </p>
        {devices.map((d) => (
          <div className="device-row" key={d.id}>
            <Icon name={d.revoked_at ? "shield" : "lock"} />
            <div className="member-info">
              <strong>
                {d.id === vault.device.id
                  ? "This browser"
                  : "Encryption device"}
                {d.revoked_at ? " · revoked" : ""}
              </strong>
              <small>{d.fingerprint.slice(0, 16)}…</small>
            </div>
            <Button variant="quiet compact" onClick={() => setSelected(d)}>
              Verify
            </Button>
            {!d.revoked_at &&
              d.id !== vault.device.id &&
              vault.member.status !== "restricted" && (
                <Button
                  variant="danger compact"
                  onClick={() => {
                    if (
                      confirm(
                        "Revoke this device? It will not receive future content keys. Already saved copies cannot be recalled.",
                      )
                    )
                      action.run(async () => {
                        await del(`/devices/${d.id}`);
                        await refresh();
                      });
                  }}
                >
                  Revoke
                </Button>
              )}
          </div>
        ))}
        <p className="small-copy">
          New devices need a trusted device or the recovery secret. Account
          support cannot decrypt your history.
        </p>
        {selected && (
          <Modal title="Device fingerprint" onClose={() => setSelected(null)}>
            <p>
              Compare this full fingerprint over a trusted channel. Matching
              only the first few characters is not enough.
            </p>
            <Fingerprint device={selected} />
            <Button variant="primary" onClick={() => setSelected(null)}>
              Done
            </Button>
          </Modal>
        )}
      </section>
      <section className="panel">
        <h2>Signed-in sessions</h2>
        {sessions.length ? (
          sessions.map((s, i) => (
            <div className="member-row" key={s.id || i}>
              <Icon name="lock" />
              <div className="member-info">
                <strong>
                  {s.userAgent?.slice(0, 85) || "A signed-in device"}
                </strong>
                <small>
                  {s.createdAt
                    ? `Signed in ${localDate(s.createdAt)}`
                    : "Active session"}
                </small>
              </div>
              <Button
                variant="quiet compact"
                onClick={() =>
                  action.run(async () => {
                    await auth("revoke-session", { token: s.token });
                    const state = await get("/api/auth/get-session");
                    if (!state?.session) {
                      await onLogout();
                      return;
                    }
                    await refresh();
                  })
                }
              >
                Sign out
              </Button>
            </div>
          ))
        ) : (
          <p>Your current session is active.</p>
        )}
        <Button
          variant="outline"
          onClick={() =>
            action.run(async () => {
              await auth("revoke-other-sessions", {});
              await refresh();
            }, "Other sessions are signed out.")
          }
        >
          Sign out other sessions
        </Button>
      </section>
      <section className="panel">
        <h2>Something doesn’t look right?</h2>
        <p>
          If someone else may have your account, start the stolen-account
          process. It works even if your email or password changed.
        </p>
        <a href="/stolen-account" className="button outline">
          My account was stolen
        </a>
      </section>
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
      <Button variant="quiet" onClick={() => action.run(onLogout)}>
        <Icon name="logout" size={17} />
        Sign out and clear this device’s keys
      </Button>
    </>
  );
}
function DataSettings({ onLogout }: { onLogout: () => Promise<void> }) {
  const vault = useVault();
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [grants, setGrants] = useState<Json[]>([]);
  const [ownedGroups, setOwnedGroups] = useState<Json[]>([]);
  const action = useAction();
  useEffect(() => {
    if (deleting && action.error)
      document.getElementById("delete-account-confirmation")?.focus();
  }, [deleting, action.error]);
  const suspended = vault.member.status === "suspended";
  useEffect(() => {
    if (!suspended)
      get("/integrations")
        .then((r) => setGrants(r.grants || []))
        .catch(() => {});
    get("/owned-groups")
      .then((r) => setOwnedGroups(items(r)))
      .catch(() => {});
  }, []);
  return (
    <>
      <DataTransfer />
      {!suspended && (
        <section className="panel">
          <h2>Connected integrations</h2>
          <p>
            Tools may read your own ciphertext and routing metadata with your
            consent. They never receive your encryption keys or access to your
            friends’ feed, and cannot post autonomously.
          </p>
          {grants.length ? (
            grants.map((g) => (
              <div className="member-row" key={g.id}>
                <Icon name="external" />
                <div className="member-info">
                  <strong>{g.name || g.client_name}</strong>
                  <small>
                    {g.scopes?.join(", ")} ·{" "}
                    {g.last_used_at
                      ? localDate(g.last_used_at)
                      : "Not used yet"}
                    {g.revoked_at ? " · Revoked" : ""}
                  </small>
                </div>
                {!g.revoked_at && (
                  <Button
                    variant="outline compact"
                    onClick={() =>
                      action.run(async () => {
                        await del(`/integrations/${g.id}`);
                        setGrants(grants.filter((v) => v.id !== g.id));
                      })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))
          ) : (
            <p className="small-copy">You have not connected any tools.</p>
          )}
          {vault.member.status !== "restricted" && <RegisterIntegration />}
        </section>
      )}
      <section className="panel danger-panel">
        <h2>Say goodbye, on your terms.</h2>
        <p>
          Deleting your account removes your profile, contributions,
          connections, and access. You can export first, but you don’t have to.
          Transfer or delete any groups you own before continuing.
        </p>
        {ownedGroups.map((g) => (
          <div className="member-row" key={g.id}>
            <Icon name="group" />
            <div className="member-info">
              <strong>A group you own</strong>
              <small>{g.id}</small>
            </div>
            {!suspended && (
              <a className="button quiet compact" href={`/app/groups/${g.id}`}>
                Manage
              </a>
            )}
            <Button
              variant="danger compact"
              busy={action.busy}
              onClick={() => {
                if (
                  confirm(
                    "Delete this owned group and all its content? This cannot be undone.",
                  )
                )
                  action.run(async () => {
                    await del(`/groups/${g.id}`);
                    setOwnedGroups(ownedGroups.filter((x) => x.id !== g.id));
                  });
              }}
            >
              Delete group
            </Button>
          </div>
        ))}
        <Button variant="danger" onClick={() => setDeleting(true)}>
          Delete my account
        </Button>
      </section>
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
      {deleting && (
        <Modal
          title="Delete your Porchday account?"
          onClose={() => setDeleting(false)}
        >
          <div className="form-stack">
            <p>
              This revokes your sessions and integrations immediately. Posts,
              comments, reactions, and encrypted photos are deleted through the
              cleanup process. Existing saved copies cannot be recalled, and
              encrypted backups age out under the operator’s retention policy.
            </p>
            <p>
              This requires a recent sign-in. A security hold may pause deletion
              while ownership is reviewed.
            </p>
            <Field
              id="delete-account-confirmation"
              label="Type DELETE to confirm"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              autoComplete="off"
            />
            <Alert>{action.error}</Alert>
            <Button
              variant="danger"
              busy={action.busy}
              disabled={deleteConfirm !== "DELETE"}
              onClick={() =>
                action.run(async () => {
                  await request("/account", {
                    method: "DELETE",
                    body: JSON.stringify({ confirm: "DELETE" }),
                  });
                  await onLogout();
                  navigate("/");
                })
              }
            >
              Permanently delete my account
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
