import { del, get, post } from "./api";

const storageKey = "porchday-push-subscription";

/** Public subscription metadata only. No content, auth tokens, or encryption keys. */
export async function enableCurrentPush(memberId: string) {
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
  await unsubscribeCurrentPush();
}
