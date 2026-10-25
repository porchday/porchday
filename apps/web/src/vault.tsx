import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
} from "react";
import {
  authorizeDevice,
  createRecoverySecret,
  decryptObject,
  displayFingerprint,
  encryptObject,
  fingerprint,
  generateDeviceKeys,
  unlockPrivateKey,
  type Audience,
  type ContentContext,
  type EncryptedEnvelope,
  type UnlockedPrivateKey,
  type DeviceKeys,
} from "@porchday/crypto";
import {
  forgetAllDevices,
  recallDevice,
  rememberDevice,
} from "@porchday/crypto/browser";
import {
  get,
  post,
  request,
  items,
  saveFile,
  type Device,
  type Member,
  type Content,
  type SocialObject,
} from "./api";
import { Alert, Button, Field, Icon, Loading, useAction } from "./ui";
import { LockedAccount } from "./LockedAccount";
import { initializeEmptyProfile } from "./initial-profile";
type BackupDevice = {
  id: string;
  public_key: string;
  fingerprint: string;
  encrypted_private_key: string;
};
type Backup = {
  v: 1;
  devices: BackupDevice[];
  recovery: {
    public_key: string;
    fingerprint: string;
    encrypted_private_key: string;
  };
};
type VaultValue = {
  member: Member;
  device: Device;
  privateKey: UnlockedPrivateKey;
  keys: UnlockedPrivateKey[];
  devices: Device[];
  open: (
    row:
      | SocialObject
      | { envelope: EncryptedEnvelope; id?: string; author_id?: string },
  ) => Promise<Content>;
  seal: (
    payload: unknown,
    context: Partial<ContentContext> & {
      kind: ContentContext["kind"];
      audience: Audience;
    },
    postId?: string,
  ) => Promise<EncryptedEnvelope>;
  audience: (
    audience: Audience,
    groupId?: string | null,
    postId?: string,
  ) => Promise<{ epoch: number; devices: Device[] }>;
  clear: () => Promise<void>;
};
const Vault = createContext<VaultValue | null>(null);
export const useVault = () => {
  const context = useContext(Vault);
  if (!context) throw new Error("Encryption keys are not unlocked");
  return context;
};
function storedDevice(memberId: string) {
  try {
    return localStorage.getItem(`porchday-device:${memberId}`);
  } catch {
    return null;
  }
}
function saveDevice(memberId: string, id: string) {
  localStorage.setItem(`porchday-device:${memberId}`, id);
}
async function checkDevice(device: Device) {
  const actual = await fingerprint(device.public_key);
  if (actual !== device.fingerprint)
    throw new Error(
      "A device key did not match its fingerprint. Sharing has been stopped.",
    );
  const key = `porchday-key:${device.member_id}:${device.id}`;
  const pinned = localStorage.getItem(key);
  if (pinned && pinned !== actual)
    throw new Error(
      "A recipient’s encryption key changed unexpectedly. Verify it with them before sharing.",
    );
  localStorage.setItem(key, actual);
}
export function VaultProvider({
  member,
  children,
}: {
  member: Member;
  children: React.ReactNode;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [active, setActive] = useState<{
    device: Device;
    key: UnlockedPrivateKey;
    history: UnlockedPrivateKey[];
  } | null>(null);
  const [error, setError] = useState("");
  const [generated, setGenerated] = useState<{
    device: BackupDevice;
    keys: DeviceKeys;
    recovery: DeviceKeys;
    secret: string;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(false);
  const [profileReadyFor, setProfileReadyFor] = useState("");
  const [profileSetupError, setProfileSetupError] = useState(false);
  const [profileSetupAttempt, setProfileSetupAttempt] = useState(0);
  const action = useAction();
  const authorKeys = useRef(new Map<string, Promise<Device>>());
  useEffect(() => {
    let canceled = false;
    get("/devices")
      .then(async (result) => {
        const list = items<Device>(result);
        if (canceled) return;
        setDevices(list);
        const own = list.find(
          (d) => d.id === storedDevice(member.id) && !d.revoked_at,
        );
        if (own) {
          const key = await recallDevice({
            memberId: member.id,
            deviceId: own.id,
            fingerprint: own.fingerprint,
          });
          if (key && !canceled) {
            const historical: UnlockedPrivateKey[] = [];
            for (const old of list.filter((d) => d.id !== own.id)) {
              const recalled = await recallDevice({
                memberId: member.id,
                deviceId: old.id,
                fingerprint: old.fingerprint,
              }).catch(() => null);
              if (recalled) historical.push(recalled);
            }
            setActive({ device: own, key, history: historical });
          }
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      canceled = true;
    };
  }, [member.id]);
  useEffect(() => {
    if (!active) return;
    const readyKey = member.id + ":" + active.device.id;
    if (["restricted", "suspended"].includes(member.status || "")) {
      setProfileReadyFor(readyKey);
      return;
    }
    const controller = new AbortController();
    let canceled = false;
    const timeout = setTimeout(() => {
      controller.abort();
      // Key operations may not observe AbortSignal. Cosmetic setup must still
      // release the app; the aborted save cannot replace a later profile edit.
      if (!canceled) {
        setProfileSetupError(true);
        setProfileReadyFor(readyKey);
      }
    }, 12000);
    setProfileSetupError(false);
    initializeEmptyProfile({
      read: () => request("/me", {signal: controller.signal}),
      seal: (profile) => seal(profile, {
        id: member.id, kind: "profile", audience: "connections", revision: 1,
      }, undefined, controller.signal),
      save: (envelope) => request("/profiles/me", {
        method: "PUT", body: JSON.stringify({envelope}), signal: controller.signal,
      }),
    }).catch(() => {
      if (!canceled) setProfileSetupError(true);
    }).finally(() => {
      clearTimeout(timeout);
      if (!canceled) setProfileReadyFor(readyKey);
    });
    return () => { canceled = true; clearTimeout(timeout); controller.abort(); };
  }, [member.id, member.status, active?.device.id, profileSetupAttempt]);
  async function generate() {
    await action.run(async () => {
      const id = crypto.randomUUID();
      const secret = createRecoverySecret();
      const [keys, recovery] = await Promise.all([
        generateDeviceKeys(member.id, id, secret),
        generateDeviceKeys(member.id, "recovery", secret),
      ]);
      setGenerated({
        device: {
          id,
          public_key: keys.publicKey,
          fingerprint: keys.fingerprint,
          encrypted_private_key: keys.encryptedPrivateKey,
        },
        keys,
        recovery,
        secret,
      });
    });
  }
  async function finish() {
    if (!generated || !saved) return;
    await action.run(async () => {
      const backup: Backup = {
        v: 1,
        devices: [generated.device],
        recovery: {
          public_key: generated.recovery.publicKey,
          fingerprint: generated.recovery.fingerprint,
          encrypted_private_key: generated.recovery.encryptedPrivateKey,
        },
      };
      const device = {
        ...generated.device,
        member_id: member.id,
        name: "Web browser",
      };
      await post("/devices", {
        id: device.id,
        public_key: device.public_key,
        fingerprint: device.fingerprint,
        name: device.name,
        authorization: { type: "initial" },
        recovery_public_key: generated.recovery.publicKey,
        backup,
      });
      const key = await unlockPrivateKey(
        generated.keys.encryptedPrivateKey,
        generated.secret,
        device.fingerprint,
      );
      if (remember)
        await rememberDevice(
          {
            memberId: member.id,
            deviceId: device.id,
            fingerprint: device.fingerprint,
          },
          key,
        );
      saveDevice(member.id, device.id);
      setDevices([device]);
      setActive({ device, key, history: [] });
      setGenerated(null);
      setSecret("");
    });
  }
  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const result = await get("/keys/backup");
      const backup = (result.envelope || result.backup || result) as Backup;
      if (backup.v !== 1 || !backup.devices?.length)
        throw new Error(
          "No compatible encrypted backup is available. Use a trusted device.",
        );
      const unlocked = await Promise.all(
        backup.devices.map(async (d) => ({
          device: d,
          key: await unlockPrivateKey(
            d.encrypted_private_key,
            secret.trim(),
            d.fingerprint,
          ),
        })),
      );
      const existing = devices!.find(
        (d) => d.id === storedDevice(member.id) && !d.revoked_at,
      );
      let device: Device;
      let key: UnlockedPrivateKey;
      if (["restricted", "suspended"].includes(member.status || "")) {
        const restored =
          unlocked.find((v) => devices!.some((d) => d.id === v.device.id)) ||
          unlocked[0];
        device = { ...restored.device, member_id: member.id };
        key = restored.key;
      } else if (existing) {
        const match = unlocked.find((v) => v.device.id === existing.id);
        if (!match)
          throw new Error(
            "This device backup is missing. Use another trusted device.",
          );
        device = existing;
        key = match.key;
      } else {
        const id = crypto.randomUUID();
        const newKeys = await generateDeviceKeys(member.id, id, secret.trim());
        const challenge = await post("/devices/challenge", {
          id,
          public_key: newKeys.publicKey,
          fingerprint: newKeys.fingerprint,
        });
        const recoveryKey = await unlockPrivateKey(
          backup.recovery.encrypted_private_key,
          secret.trim(),
          backup.recovery.fingerprint,
        );
        const signed = await authorizeDevice(
          {
            v: 1,
            purpose: "porchday-device-authorization",
            memberId: member.id,
            authorizingDeviceId: "recovery",
            deviceId: id,
            fingerprint: newKeys.fingerprint,
            challenge: challenge.challenge,
            expiresAt: challenge.expires_at,
          },
          recoveryKey,
        );
        device = {
          id,
          member_id: member.id,
          public_key: newKeys.publicKey,
          fingerprint: newKeys.fingerprint,
          name: "Web browser",
        };
        const updated: Backup = {
          ...backup,
          devices: [
            ...backup.devices,
            {
              id,
              public_key: newKeys.publicKey,
              fingerprint: newKeys.fingerprint,
              encrypted_private_key: newKeys.encryptedPrivateKey,
            },
          ],
        };
        await post("/devices", {
          ...device,
          authorization: { type: "recovery", signed },
          backup: updated,
        });
        key = await unlockPrivateKey(
          newKeys.encryptedPrivateKey,
          secret.trim(),
          device.fingerprint,
        );
        setDevices([...devices!, device]);
      }
      if (remember) {
        await rememberDevice(
          {
            memberId: member.id,
            deviceId: device.id,
            fingerprint: device.fingerprint,
          },
          key,
        );
        for (const old of unlocked)
          await rememberDevice(
            {
              memberId: member.id,
              deviceId: old.device.id,
              fingerprint: old.device.fingerprint,
            },
            old.key,
          );
      }
      saveDevice(member.id, device.id);
      setActive({ device, key, history: unlocked.map((v) => v.key) });
      setSecret("");
    });
  }
  if (error)
    return (
      <div className="vault-page">
        <div className="panel">
          <Alert>{error}</Alert>
          <Button onClick={() => location.reload()}>Try again</Button>
        </div>
        <LockedAccount member={member} />
      </div>
    );
  if (!devices) return <Loading text="Checking your private space…" />;
  if (!active)
    return (
      <main id="main-content" className="vault-page">
        <span className="feature-icon sage">
          <Icon name="lock" size={30} />
        </span>
        <span className="eyebrow">ONLY YOU HOLD THE KEY</span>
        <h1>
          {devices.length
            ? "Welcome back to your private space."
            : "A little privacy, by design."}
        </h1>
        <p>
          Your posts, photos, and conversations are encrypted for your people.
          Porchday cannot read them. Your recovery secret is separate from your
          login password.
        </p>
        <div className="panel form-stack">
          <Alert>{action.error}</Alert>
          {devices.length ? (
            <form className="form-stack" onSubmit={unlock}>
              <h2>Unlock this device</h2>
              <p>
                {["restricted", "suspended"].includes(member.status || "")
                  ? "Use your saved recovery secret to read existing encrypted content and export your data. This does not enroll a new device or restore restricted social features."
                  : "Use your saved recovery secret to unlock your history and authorize this device. Password resets do not restore these keys."}
              </p>
              <Field
                label="Encryption recovery secret"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                spellCheck={false}
                required
              />
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>
                  Remember this private device. Anyone who can use this browser
                  may be able to read your content. Signing out clears stored
                  keys.
                </span>
              </label>
              <Button variant="primary" busy={action.busy}>
                Unlock my circle <Icon name="lock" size={17} />
              </Button>
            </form>
          ) : generated ? (
            <>
              <h2>Keep this somewhere safe.</h2>
              <p>
                This secret can restore your encryption keys. Save it in your
                password manager or store a printed copy somewhere private. We
                can’t replace it.
              </p>
              <div className="secret-box">
                <code>{generated.secret}</code>
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  saveFile(
                    new Blob(
                      [
                        `Porchday encryption recovery secret\nAccount: @${member.handle}\nSecret: ${generated.secret}\n\nKeep this private. Never send it to support. Your login password is separate.\n`,
                      ],
                      { type: "text/plain" },
                    ),
                    "porchday-recovery.txt",
                  )
                }
              >
                <Icon name="download" size={17} />
                Download recovery note
              </Button>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                <span>
                  I saved my secret. I understand that losing it and all trusted
                  devices means losing my encrypted history.
                </span>
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>
                  Remember keys on this private device. Do not choose this on a
                  shared computer.
                </span>
              </label>
              <Button
                variant="primary"
                busy={action.busy}
                disabled={!saved}
                onClick={finish}
              >
                My secret is safe. Let’s go.
              </Button>
            </>
          ) : ["restricted", "suspended"].includes(member.status || "") ? (
            <>
              <h2>Your data controls remain available.</h2>
              <p>
                This account has no encryption devices to unlock. Use the
                account controls below to sign out, appeal, or delete your
                account.
              </p>
            </>
          ) : (
            <>
              <h2>Make this space yours.</h2>
              <p>
                We’ll create your keys right here on your device. You’ll save a
                recovery secret before continuing. It never goes to Porchday.
              </p>
              <Button variant="primary" busy={action.busy} onClick={generate}>
                Create my private keys <Icon name="arrow" size={18} />
              </Button>
            </>
          )}
        </div>
        <p className="small-copy">
          Encryption protects content, not every detail: the service still needs
          account, connection, delivery, and timing metadata.{" "}
          <a href="/privacy">Read the privacy notice.</a>
        </p>
        <LockedAccount member={member} />
      </main>
    );
  async function audience(
    audience: Audience,
    groupId?: string | null,
    postId?: string,
    signal?: AbortSignal,
  ) {
    const qs = new URLSearchParams(
      postId
        ? { post_id: postId }
        : { audience, ...(groupId ? { group_id: groupId } : {}) },
    );
    const r = await request(`/audiences?${qs}`, {signal});
    const list = items<Device>(r);
    if (
      (Array.isArray(r.pending_members) && r.pending_members.length) ||
      (typeof r.pending_members === "number" && r.pending_members > 0)
    )
      throw new Error(
        "Someone in this audience has not set up encryption yet. Wait for their keys before sharing; no one will be silently left out.",
      );
    for (const d of list) await checkDevice(d);
    return { epoch: r.epoch as number, devices: list };
  }
  async function seal(
    payload: unknown,
    partial: Partial<ContentContext> & {
      kind: ContentContext["kind"];
      audience: Audience;
    },
    postId?: string,
    signal?: AbortSignal,
  ) {
    if (
      ["restricted", "suspended"].includes(member.status || "") &&
      partial.kind !== "report"
    )
      throw new Error(
        "Social changes are unavailable while this account is restricted. Your data and appeals remain available.",
      );
    const recipients = await audience(
      partial.audience,
      partial.groupId,
      postId,
      signal,
    );
    const context: ContentContext = {
      id: crypto.randomUUID(),
      authorId: member.id,
      authorDeviceId: active!.device.id,
      parentId: null,
      groupId: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revision: 1,
      ...partial,
      epoch: recipients.epoch,
    };
    return encryptObject({
      context,
      payload,
      signingKey: active!.key,
      recipients: recipients.devices.map((d) => ({
        memberId: d.member_id,
        deviceId: d.id,
        publicKey: d.public_key,
      })),
    });
  }
  async function open(
    row:
      | SocialObject
      | { envelope: EncryptedEnvelope; id?: string; author_id?: string },
  ) {
    const envelope = row.envelope;
    if (!envelope?.context)
      throw new Error("No encrypted content is available.");
    const expected = { ...envelope.context };
    if (row.id && row.id !== expected.id)
      throw new Error("Content identity did not match.");
    if (row.author_id && row.author_id !== expected.authorId)
      throw new Error("Content author did not match.");
    if (!authorKeys.current.has(expected.authorDeviceId)) {
      authorKeys.current.set(
        expected.authorDeviceId,
        get(`/devices/${expected.authorDeviceId}`)
          .then(async (result) => {
            const author = (result.device || result) as Device;
            await checkDevice(author);
            return author;
          })
          .catch((e) => {
            authorKeys.current.delete(expected.authorDeviceId);
            throw e;
          }),
      );
    }
    const author = await authorKeys.current.get(expected.authorDeviceId)!;
    const keys = [active!.key, ...active!.history];
    const matching = keys.find((k) =>
      envelope.recipients.some((r) => r.fingerprint === k.getFingerprint()),
    );
    if (!matching)
      throw new Error(
        "This was shared before your device joined. Restore your recovery keys or ask the author to share it explicitly.",
      );
    return decryptObject<Content>({
      envelope,
      expectedContext: expected,
      privateKey: matching,
      authorPublicKey: author.public_key,
    });
  }
  if (profileReadyFor !== member.id + ":" + active.device.id)
    return <Loading text="Getting your personal page ready…" />;
  return (
    <Vault.Provider
      value={{
        member,
        device: active.device,
        privateKey: active.key,
        keys: [active.key, ...active.history],
        devices,
        open,
        seal,
        audience,
        clear: async () => {
          await forgetAllDevices();
          setActive(null);
        },
      }}
    >
      {profileSetupError && (
        <div className="panel" role="status">
          <p>We couldn’t check your starter background. Your account and keys are ready; you can keep using Porchday or try again.</p>
          <Button variant="outline" onClick={() => setProfileSetupAttempt((v) => v + 1)}>Try background setup again</Button>
        </div>
      )}
      {children}
    </Vault.Provider>
  );
}
export function Fingerprint({ device }: { device: Device }) {
  return (
    <code className="fingerprint">
      {displayFingerprint(device.fingerprint)}
    </code>
  );
}
