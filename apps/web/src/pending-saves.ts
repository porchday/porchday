let pending = 0, foreground = 0, navigation = 0;
const listeners = new Set<() => void>();
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (!pending) return;
  event.preventDefault();
  event.returnValue = "";
};
export const pendingSaves = {
  getSnapshot: () => pending,
  getNavigationSnapshot: () => navigation,
  getStatus: () => navigation ? (foreground ? "saving" : "background") : "",
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export function hasNavigationBlockingSaves() { return navigation > 0; }
export function hasPendingSaves() { return pending > 0; }
/** Covers encryption/upload as well as the final write when used around a save. */
export async function withPendingSave<T>(save: () => Promise<T>, background = false, keepNavigation = false): Promise<T> {
  if (!keepNavigation) navigation++;
  if (!background) foreground++;
  if (++pending === 1 && typeof window !== "undefined") window.addEventListener("beforeunload", beforeUnload);
  for (const listener of listeners) listener();
  try { return await save(); }
  finally {
    if (!keepNavigation) navigation--;
    if (!background) foreground--;
    if (--pending === 0 && typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnload);
    for (const listener of listeners) listener();
  }
}
