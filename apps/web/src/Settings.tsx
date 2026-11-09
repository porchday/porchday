import { ChildrenSettings } from "./ChildrenSettings";
import { MemberAvatar } from "./MemberAvatar";
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
import { IntegrationGrantDetails, RegisterIntegration } from "./Integrations";
import { EmailSettings, MfaSettings } from "./AccountSecurity";
import { AssetPicker, useAssetUpload, type PendingAsset } from "./Media";
import { DataTransfer } from "./DataTransfer";
import { PerformanceTracing } from "./PerformanceTracing";
import { TimeSettings } from "./TimeSettings";
import { enableCurrentPush, disableAllPush, currentPushStatus, type CurrentPushStatus } from "./push";
import { PROFILE_SLOTS, planSurfacePhotos } from "./surface-media";
import { WALLPAPERS, wallpaperId } from "./wallpaper";
import { DeletionUnconfirmedError, requestAccountDeletion } from "./account-deletion";
import { profileRefreshState } from "./profile-refresh";
export function Settings({
  tab = "profile",
  onLogout,
  onAccountDeleted,
}: {
  tab?: string;
  onLogout: () => Promise<void>;
  onAccountDeleted: () => Promise<void>;
}) {
  return (
    <>
      <div className="page-heading">
        <h1>Settings</h1>
      </div>
      <nav className="settings-tabs settings-navigation" aria-label="Settings">
        {[
          ["profile", "My profile"],
          ["children", "Children"],
          ["notifications", "Notifications"],
          ["privacy", "Privacy & safety"],
          ["security", "Account & keys"],
          ["data", "My data"],
        ].map(([id, name]) => (
          <a
            className={tab === id ? "active" : ""}
            aria-current={tab === id ? "page" : undefined}
            href={`/settings/${id}`}
            key={id}
          >
            {name}
          </a>
        ))}
      </nav>
      {tab === "profile" ? (
        <><ProfileSettings /><TimeSettings /></>
      ) : tab === "children" ? (
        <ChildrenSettings />
      ) : tab === "notifications" ? (
        <NotificationSettings />
      ) : tab === "privacy" ? (
        <PrivacySettings />
      ) : tab === "security" ? (
        <SecuritySettings onLogout={onLogout} />
      ) : (
        <DataSettings onAccountDeleted={onAccountDeleted} />
      )}
    </>
  );
}
const emptyProfile = (): Content => ({ displayName: "", bio: "", interests: "", status: "", theme: "sage", font: "serif", sectionOrder: "about-first" });
function ProfileSettings() {
  const vault = useVault();
  const [profile, setProfile] = useState<Content>(emptyProfile);
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
  const owner = vault.member.id + ":" + vault.device.id;
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const editorOwner = useRef(owner);
  const refresh = useRef(profileRefreshState());
  const baseline = useRef<EncryptedEnvelope | null>(null);
  const saving = useRef(false);
  const [loadedOwner, setLoadedOwner] = useState("");
  const [profileChanged, setProfileChanged] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (editorOwner.current !== owner) {
      editorOwner.current = owner;
      refresh.current = profileRefreshState(); baseline.current = null;
      setProfile(emptyProfile()); setOld(null); setProfileAudience("connections");
      setAssets({avatar:null,cover:null,background:null}); setRemovedAssets({});
      setLoadedOwner(""); setProfileChanged(false);
    }
    const guard = refresh.current, token = guard.begin(), controller = new AbortController();
    let canceled = false;
    setLoadError("");
    const decision = (envelope: EncryptedEnvelope | null) => canceled || currentOwner.current !== owner ? "stale" : guard.decide(token, baseline.current, envelope);
    void (async () => {
      const me = await request("/me", {signal:controller.signal});
      const envelope = (me.envelope || null) as EncryptedEnvelope | null;
      let choice = decision(envelope);
      if (choice === "stale") return;
      if (choice !== "replace") {
        if (choice === "conflict") setProfileChanged(true);
        setLoadedOwner(owner); return;
      }
      const content = envelope ? await vault.open({envelope,id:vault.member.id}) : emptyProfile();
      choice = decision(envelope);
      if (choice === "stale") return;
      if (choice === "replace") {
        setProfile(content); setOld(envelope); baseline.current = envelope;
        setProfileAudience(envelope?.context.audience === "only_me" ? "only_me" : "connections");
        setProfileChanged(false);
      } else if (choice === "conflict") setProfileChanged(true);
      setLoadedOwner(owner);
    })().catch(() => { if (decision(baseline.current) !== "stale") setLoadError("Could not load your saved profile. Your draft is unchanged."); });
    return () => { canceled = true; guard.invalidate(); controller.abort(); };
  }, [owner, vault.profileVersion, reload]);
  const edit = (change: () => void) => { if (!saving.current) { refresh.current.edit(); change(); } };
  const update = (field: string, value: string) => edit(() => setProfile((p) => ({ ...p, [field]: value })));
  function reloadSavedProfile() {
    refresh.current.saved(); setLoadedOwner(""); setProfileChanged(false);
    setAssets({avatar:null,cover:null,background:null}); setRemovedAssets({});
    setReload(v => v + 1);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving.current || loadedOwner !== owner || profileChanged) return;
    saving.current = true;
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
      if (currentOwner.current !== owner) return;
      await request("/profiles/me", {
        method: "PUT",
        body: JSON.stringify({ envelope, remove_media: plan.remove_media }),
      });
      // The revised profile and removals have committed even if a later new-photo
      // attachment needs retrying. Keep the revision current for that retry.
      if (currentOwner.current !== owner) return;
      refresh.current.saved(); baseline.current = envelope;
      setOld(envelope);
      setProfile(next);
      setAssets({ avatar: null, cover: null, background: null });
      setRemovedAssets({});
      setProfileChanged(false);
      vault.notifyProfileChanged();
      for (const asset of uploaded)
        await request(`/media/${asset.id}/attachment`, {
          method: "PUT",
          body: JSON.stringify({
            kind: "profile",
            target_id: vault.member.id,
            slot: asset.slot,
          }),
        });
      // Newly uploaded photos become readable only after attachment succeeds.
      if (uploaded.length && currentOwner.current === owner) vault.notifyProfileChanged();
    }, "Profile saved.");
    saving.current = false;
  }
  if (editorOwner.current !== owner) return <Loading text="Loading profile…" />;
  if (vault.member.status === "restricted")
    return (
      <Alert>
        Profile changes are unavailable while this account is restricted. You
        can still export your profile from My data.
      </Alert>
    );
  return (
    <form onSubmit={submit} className="form-stack">
      {loadError && <Alert>{loadError} <button type="button" className="text-button" onClick={() => setReload(v => v + 1)}>Retry loading</button></Alert>}
      {profileChanged && <Alert>Your saved profile changed. Your draft has been kept. <button type="button" className="text-button" onClick={reloadSavedProfile}>Discard draft and reload</button></Alert>}
      <fieldset disabled={action.busy} className="form-stack" style={{border:0,padding:0,margin:0,minWidth:0}}>
      <section className="panel form-stack">
        <h2>Profile details</h2>
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
              edit(() => setProfileAudience(e.target.value as "connections" | "only_me"))
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
          label="Interests"
          help="Separate interests with commas."
          placeholder="Books, gardening, music"
          value={String(profile.interests || "")}
          onChange={(e) => update("interests", e.target.value)}
          maxLength={300}
        />
      </section>
      <section className="panel form-stack">
        <h2>Profile photos</h2>
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
                edit(() => setRemovedAssets((p) => ({ ...p, [slot]: removed })))
              }
              onChange={(asset) => edit(() => {
                setAssets((p) => ({ ...p, [slot]: asset }));
                if (asset) setRemovedAssets((p) => ({ ...p, [slot]: false }));
              })}
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
              <option value="serif">Serif</option>
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
        <Button variant="primary" busy={action.busy} disabled={loadedOwner !== owner || profileChanged}>
          Save my profile <Icon name="check" size={17} />
        </Button>
      </div>
      </fieldset>
    </form>
  );
}
function NotificationSettings() {
  const vault = useVault();
  const [prefs, setPrefs] = useState({ in_app: true, push: false });
  const action = useAction();
  const pushAction = useAction();
  const [devicePush, setDevicePush] = useState<CurrentPushStatus | "checking" | "unknown">("checking");
  const [pushOperation, setPushOperation] = useState<"enable" | "disable" | null>(null);
  useEffect(() => {
    let active = true;
    currentPushStatus(vault.member.id).then(status => { if (active) setDevicePush(status); }).catch(() => { if (active) setDevicePush("unknown"); });
    return () => { active = false; };
  }, [vault.member.id]);
  async function refresh() {
    const me = await get("/me");
    setPrefs({ ...prefs, ...me.notification_preferences });
  }
  useEffect(() => {
    action.run(refresh);
  }, []);
  async function enablePush() {
    setPushOperation("enable");
    await pushAction.run(async () => {
      await enableCurrentPush(vault.member.id);
      await patch("/me", {
        notification_preferences: { ...prefs, push: true },
      });
      setPrefs((p) => ({ ...p, push: true }));
      setDevicePush("enabled");
    }, "This device is registered for notifications about new feed posts and photos.");
    setPushOperation(null);
  }
  async function disablePush() {
    setPushOperation("disable");
    await pushAction.run(async () => {
      await disableAllPush();
      await patch("/me", {
        notification_preferences: { ...prefs, push: false },
      });
      setPrefs((p) => ({ ...p, push: false }));
      setDevicePush("off");
    }, "Push notifications are off for all your devices. In-app preferences are unchanged.");
    setPushOperation(null);
  }
  return (
    <>
      <section className="panel form-stack">
        <h2>Notifications</h2>
        <label className="check-field">
          <input
            type="checkbox"
            checked={prefs.in_app}
            disabled={action.busy || pushAction.busy}
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
        <div className="form-stack" aria-busy={pushAction.busy}>
          <p role="status" aria-live="polite">
            <strong>{devicePush === "enabled" ? "Push enabled on this device" : devicePush === "checking" ? "Checking this device…" : devicePush === "blocked" ? "Notifications are blocked on this device" : devicePush === "unsupported" ? "Push is unavailable in this browser" : devicePush === "unknown" ? "Couldn’t check this device’s push status" : "Push is off on this device"}</strong>
          </p>
          {devicePush === "enabled" ? <p className="small-copy">You’re registered for new feed posts and photos. Notification permission, sounds and previews are controlled in your device’s notification settings.</p> : <>
            {devicePush === "blocked" && <p className="small-copy">Allow notifications for Porchday in your device or browser settings, then try again.</p>}
            {devicePush === "unsupported" && <p className="small-copy">On iPhone or iPad, add Porchday to your Home Screen, open it there, and enable notifications. In-app notifications are still available here.</p>}
            {devicePush === "unknown" && <p className="small-copy">Check your connection, then try enabling push again. We’ll confirm when this device is registered.</p>}
            <Button variant="outline" disabled={action.busy || pushAction.busy || devicePush === "checking" || devicePush === "unsupported"} onClick={enablePush}>
              {pushOperation === "enable" ? <><span className="spinner" />Enabling notifications…</> : <><Icon name="bell" size={17} />Enable push on this device</>}
            </Button>
          </>}
          {pushOperation === "enable" && <p role="status">Allow notifications if your device asks. Keep this page open while setup finishes.</p>}
          <Alert>{pushAction.error}</Alert>
          <Alert success>{pushAction.notice}</Alert>
          {prefs.push && <Button variant="quiet" disabled={action.busy || pushAction.busy || devicePush === "checking"} onClick={disablePush}>
            {pushOperation === "disable" ? <><span className="spinner" />Turning off notifications…</> : "Turn off push on all devices"}
          </Button>}
        </div>
        <p className="small-copy">
          Feed notifications show the author’s handle and activity type. We never put post text,
          photos, or reaction choices in a notification.
        </p>
      </section>
      <Alert>{action.error}</Alert>
    </>
  );
}
function PrivacySettings() {
  const [blocks, setBlocks] = useState<Json[]>([]);
  const [mutes, setMutes] = useState<Json[]>([]);
  const [reports, setReports] = useState<Json[]>([]);
  const action = useAction();
  async function refresh() {
    const [b, m, r] = await Promise.all([get("/blocks"), get("/mutes"), get("/reports")]);
    setBlocks(items(b)); setMutes(items(m)); setReports(items(r));
  }
  useEffect(() => { action.run(refresh); }, []);
  return (
    <>
      <section className="panel form-stack">
        <h2>Privacy &amp; safety</h2>
        <p>Your email and connection list are private. Choose an audience when sharing posts, photos or videos.</p>
      </section>
      <section className="panel">
        <h2>Muted in Home</h2>
        {mutes.length ? (
          mutes.map((m) => (
            <div className="member-row" key={m.target}>
              <MemberAvatar memberId={m.target} />
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
              <MemberAvatar memberId={b.target} />
              <span className="member-info">
                Blocked account <small>{b.target}</small>
              </span>
              <Button
                variant="quiet compact"
                onClick={() =>
                  action.run(async () => {
                    await del(`/blocks/${b.target}`);
                    window.dispatchEvent(new Event("porchday:connections-changed"));
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
function DataSettings({ onAccountDeleted }: { onAccountDeleted: () => Promise<void> }) {
  const vault = useVault();
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deletionUnconfirmed, setDeletionUnconfirmed] = useState(false);
  const deletionAttempt = useRef(false);
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
                <IntegrationGrantDetails grant={g} />
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
      <PerformanceTracing />
      <section className="panel danger-panel">
        <h2>Delete account</h2>
        <p>
          Deleting your account removes your profile, contributions,
          connections, and access. You can export first, but you don’t have to.
          Transfer or delete any groups you own before continuing. Albums you still own
          will be deleted; transfer album ownership first to keep them.
        </p>
        {ownedGroups.map((g) => (
          <div className="member-row" key={g.id}>
            <Icon name="group" />
            <div className="member-info">
              <strong>A group you own</strong>
              <small>{g.id}</small>
            </div>
            {!suspended && (
              <a className="button quiet compact" href={`/groups/${g.id}`}>
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
              cleanup process. Albums you still own are deleted too; transferred albums remain.
              Existing saved copies cannot be recalled, and
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
            {action.busy && <p role="status">Submitting your deletion request…</p>}
            <Button
              variant="danger"
              busy={action.busy}
              disabled={deleteConfirm !== "DELETE" || deletionUnconfirmed}
              onClick={() =>
                action.run(async () => {
                  if (deletionAttempt.current) return;
                  deletionAttempt.current = true;
                  try { await requestAccountDeletion(); }
                  catch (error) {
                    if (error instanceof DeletionUnconfirmedError) setDeletionUnconfirmed(true);
                    else deletionAttempt.current = false;
                    throw error;
                  }
                  await onAccountDeleted();
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
