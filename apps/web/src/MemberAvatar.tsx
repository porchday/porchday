import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { base64ToBytes } from "@porchday/crypto";
import { request } from "./api";
import { createAvatarStore } from "./avatar-store";
import { readAvatarPhoto } from "./avatar-photo";
import { validatedPhoto } from "./photo-safety";
import { useVault } from "./vault";
import { useNearViewport } from "./near-viewport";

const Avatars = createContext<ReturnType<typeof createAvatarStore> | null>(null);
export function MemberAvatarProvider({ children }: { children: React.ReactNode }) {
  const vault = useVault(), latest = useRef(vault); latest.current = vault;
  const identity = `${vault.member.id}:${vault.member.status}:${vault.device.id}:${vault.device.revoked_at || ""}`;
  const store = useMemo(() => {
    let initialSelfRead = true;
    return createAvatarStore((id, signal, previous) => readAvatarPhoto(id, signal, previous, {
    viewerId: vault.member.id,
    read: <T,>(path: string, signal: AbortSignal): Promise<T> => {
      if (path === "/me" && initialSelfRead) {
        initialSelfRead = false;
        return Promise.resolve(vault.member as T);
      }
      return request<T>(path, { signal });
    },
    open: row => latest.current.open(row),
    validate: async encoded => (await validatedPhoto(base64ToBytes(encoded))).blob,
  })); }, [identity]);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState !== "hidden") store.refresh(); };
    const connections = () => store.refresh(undefined, true);
    const interval = setInterval(recheck, 60_000);
    window.addEventListener("focus", recheck);
    window.addEventListener("online", recheck);
    window.addEventListener("porchday:connections-changed", connections);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      clearInterval(interval); store.clear();
      window.removeEventListener("focus", recheck);
      window.removeEventListener("online", recheck);
      window.removeEventListener("porchday:connections-changed", connections);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [store]);
  const previousVersion = useRef({ store, version: vault.profileVersion });
  useEffect(() => {
    if (previousVersion.current.store === store && previousVersion.current.version !== vault.profileVersion)
      store.refresh(vault.member.id, true);
    previousVersion.current = { store, version: vault.profileVersion };
  }, [store, vault.profileVersion]);
  return <Avatars.Provider value={store}>{children}</Avatars.Provider>;
}

export function MemberAvatar({ memberId, name = "?", theme = "sage", size = "" }: {
  memberId: string; name?: string; theme?: string; size?: string;
}) {
  const store = useContext(Avatars), vault = useVault();
  const { ref, near } = useNearViewport<HTMLSpanElement>();
  const subscribe = useCallback((notify: () => void) => (near ? store?.subscribe(memberId, notify) : undefined) || (() => {}), [store, memberId, near]);
  const snapshot = useCallback(() => store?.getURL(memberId) || "", [store, memberId]);
  const url = useSyncExternalStore(subscribe, snapshot, () => "");
  const [failed, setFailed] = useState("");
  const initial = (memberId === vault.member.id ? vault.member.handle : name).replace(/^@/, "").slice(0, 1).toUpperCase() || "?";
  return <span ref={ref} className={`avatar member-avatar ${theme} ${size}`} aria-hidden="true">
    {url && failed !== url ? <img src={url} alt="" onError={() => setFailed(url)} /> : initial}
  </span>;
}
