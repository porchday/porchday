import { isNativeShell, nativeCall } from "./native-shell";
import { del, get, post } from "./api";

const storageKey = "porchday-push-subscription";

/** Public subscription metadata only. No content, auth tokens, or encryption keys. */
let nativeGeneration = 0;
const nativeStorageKey = "porchday-native-push-subscription";
export async function enableNativePush(memberId: string, requestPermission = true) {
  const generation = nativeGeneration;
  const config = await get("/native-push/config");
  if (!config.enabled) throw new Error("Native push delivery is not configured yet.");
  const registration = await nativeCall("push", { requestPermission }) as { token?: string; environment?: string };
  if (!registration || !/^[a-f0-9]{64,200}$/.test(registration.token || "") || !["production", "sandbox"].includes(registration.environment || "")) throw new Error("Native notification registration failed.");
  if (generation !== nativeGeneration) throw new Error("Notification enrollment was cancelled.");
  const result = await post("/native-push/subscriptions", registration);
  if (generation !== nativeGeneration) return;
  localStorage.setItem(nativeStorageKey, JSON.stringify({ id: result.id, memberId }));
}
export async function refreshNativePush(memberId: string) {
  if (!isNativeShell()) return;
  let stored; try { stored = JSON.parse(localStorage.getItem(nativeStorageKey) || "null"); } catch { return; }
  if (stored?.memberId !== memberId) return;
  // A revoked subscription or global opt-out must never silently opt the member back in.
  const subscriptions = await get("/native-push/subscriptions");
  if (!subscriptions.items?.some((item: { id: string }) => item.id === stored.id)) {
    localStorage.removeItem(nativeStorageKey); await nativeCall("clear"); return;
  }
  await enableNativePush(memberId, false);
}
export async function enableCurrentPush(memberId: string) {
  if (isNativeShell()) { await enableNativePush(memberId); return; }
  if (
    !("Notification" in window) ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  )
    throw new Error(
      "This browser does not support push. In-app notifications remain available. On iPhone, install Porchday on your Home Screen first.",
    );
  const config = await get("/push/config");
  if (!config.enabled || !config.public_key)
    throw new Error(
      "Push delivery is not configured yet. Your in-app updates remain available.",
    );
  if (Notification.permission === "denied")
    throw new Error(
      "Notifications are blocked. Allow them in your browser’s site settings, then return here.",
    );
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error(
      "Notification permission was not granted. You can change it in your browser settings.",
    );
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration?.active)
    throw new Error(
      "The Porchday app is still getting ready. Reload this page, then enable notifications.",
    );
  const encoded = String(config.public_key)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const key = Uint8Array.from(
    atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  try {
    const result = await post("/push/subscriptions", subscription.toJSON());
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ id: result.id, memberId }),
      );
    } catch {}
  } catch (error) {
    await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

export async function unsubscribeCurrentPush() {
  if (isNativeShell()) {
    nativeGeneration++;
    let stored; try { stored = JSON.parse(localStorage.getItem(nativeStorageKey) || "null"); } catch {}
    try { if (stored?.id) await del(`/native-push/subscriptions/${encodeURIComponent(stored.id)}`); }
    catch { /* Server sign-out revokes session-bound delivery too. */ }
    finally { localStorage.removeItem(nativeStorageKey); await nativeCall("clear").catch(() => {}); }
    return;
  }
  let stored: { id?: string } | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(storageKey) || "null");
  } catch {}
  try {
    if (stored?.id)
      await del(`/push/subscriptions/${encodeURIComponent(stored.id)}`);
  } catch {
  } finally {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker
        .getRegistration("/")
        .catch(() => undefined);
      const subscription = await registration?.pushManager
        ?.getSubscription()
        .catch(() => null);
      await subscription?.unsubscribe().catch(() => false);
    }
    try {
      localStorage.removeItem(storageKey);
    } catch {}
  }
}

export async function disableAllPush() {
  await del("/push/subscriptions");
  await del("/native-push/subscriptions");
  await unsubscribeCurrentPush();
}
