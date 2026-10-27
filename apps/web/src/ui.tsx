import { hasPendingSaves, pendingSaves, withPendingSave } from "./pending-saves";
import React, { useEffect, useState } from "react";
import { message } from "./api";
import { needsDomainNavigation } from "./domain-navigation";
export function Icon({
  name,
  size = 20,
  ...props
}: { name: string; size?: number } & React.SVGProps<SVGSVGElement>) {
  const paths: Record<string, React.ReactNode> = {
    home: (
      <>
        <path d="m3 10 9-7 9 7v10H3z" />
        <path d="M9 20v-7h6v7" />
      </>
    ),
    people: (
      <>
        <circle cx="9" cy="7" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14c3 0 4 2 4 5v2" />
      </>
    ),
    group: (
      <>
        <circle cx="12" cy="8" r="3" />
        <path d="M6 21v-3a6 6 0 0 1 12 0v3M4 5a3 3 0 0 0 0 6M20 5a3 3 0 0 1 0 6M2 21v-5m20 5v-5" />
      </>
    ),
    wall: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <circle cx="12" cy="9" r="3" />
        <path d="M8 17h8" />
      </>
    ),
    bell: (
      <>
        <path d="M4 17h16l-2-3V9a6 6 0 0 0-12 0v5zM9 21h6" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    photo: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1" />
        <path d="m3 17 6-6 4 4 3-3 5 5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" />
      </>
    ),
    smile: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 14c1 4 7 4 8 0M8 8v1m8-1v1" />
      </>
    ),
    comment: <path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z" />,
    plus: <path d="M12 4v16M4 12h16" />,
    check: <path d="m4 12 5 5L20 6" />,
    close: <path d="m5 5 14 14M5 19 19 5" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    logout: (
      <>
        <path d="M9 3H3v18h6m5-15 6 6-6 6m-7-6h13" />
      </>
    ),
    more: (
      <>
        <circle cx="4" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="20" cy="12" r="1" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z" />
        <path d="m8 11 3 3 5-5" />
      </>
    ),
    mail: (
      <>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m2 6 10 7L22 6" />
      </>
    ),
    leaf: (
      <>
        <path d="M19 3C9 2 2 6 5 14s15 5 14-11Z" />
        <path d="m3 21 11-11" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M9 10v7m6-7v7" />
      </>
    ),
    edit: (
      <>
        <path d="m4 15 12-12 5 5L9 20l-6 1zM14 5l5 5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.sun}
    </svg>
  );
}
export function Logo({ small = false, href = "/" }: { small?: boolean; href?: string }) {
  return (
    <a
      className={`logo ${small ? "logo-small" : ""}`}
      href={href}
      aria-label="Porchday home"
    >
      <img className="logo-mark" src="/logo.svg" width="40" height="40" alt="" />
      <span>
        porchday<span className="logo-dot">.</span>
      </span>
    </a>
  );
}
export function Button({
  children,
  busy = false,
  disabled = false,
  variant = "",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: string;
}) {
  return (
    <button
      className={`button ${variant} ${className}`}
      disabled={busy || disabled}
      {...props}
    >
      {busy ? (
        <>
          <span className="spinner" />
          Working…
        </>
      ) : (
        children
      )}
    </button>
  );
}
export function Alert({
  children,
  success = false,
}: {
  children: React.ReactNode;
  success?: boolean;
}) {
  return children ? (
    <div
      className={`alert ${success ? "success" : ""}`}
      role={success ? "status" : "alert"}
    >
      <Icon name={success ? "check" : "shield"} size={18} />
      <span>{children}</span>
    </div>
  ) : null;
}
export function Field({
  label,
  help,
  id: providedId,
  "aria-describedby": describedBy,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  help?: string;
}) {
  const generatedId = React.useId();
  const id = providedId || generatedId;
  const description = [describedBy, help ? `${id}-help` : undefined]
    .filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input {...props} id={id} aria-describedby={description} />
      {help && <small id={`${id}-help`}>{help}</small>}
    </div>
  );
}
export function Empty({
  icon = "sun",
  title,
  children,
  action,
}: {
  icon?: string;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon">
        <Icon name={icon} size={30} />
      </span>}
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Loading({ text = "Loading…" }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {text}
    </div>
  );
}
export function Avatar({
  name = "?",
  theme = "sage",
  size = "",
}: {
  name?: string;
  theme?: string;
  size?: string;
}) {
  return (
    <span className={`avatar ${theme} ${size}`} aria-hidden="true">
      {name.replace(/^@/, "").slice(0, 1).toUpperCase()}
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  returnFocusRef,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const el = ref.current;
    el?.showModal();
    const close = (event: Event) => {
      event.preventDefault();
      closeRef.current();
    };
    el?.addEventListener("cancel", close);
    return () => {
      el?.removeEventListener("cancel", close);
      el?.close();
      const target = returnFocusRef?.current || previous;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [returnFocusRef]);
  return (
    <dialog ref={ref} className="modal" aria-label={title}>
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function PendingSaveStatus() {
  const status = React.useSyncExternalStore(pendingSaves.subscribe, pendingSaves.getStatus, () => "");
  return status ? <div className="pending-save-status" role="status" aria-live="polite">{status === "saving" ? "Saving… Keep this page open until saving finishes." : "Finishing background updates…"}</div> : null;
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run<T>(action: () => Promise<T>, success?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (success) setNotice(success);
      return result;
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const saving = React.useRef(false);
  async function runSave<T>(action: () => Promise<T>, success?: string) {
    if (saving.current) return;
    saving.current = true;
    try { return await run(() => withPendingSave(action), success); }
    finally { saving.current = false; }
  }
  return { busy, error, notice, run, runSave, setError, setNotice };
}
export function useRoute(navigationEpoch?: { current: number }) {
  const [path, setPath] = useState(location.pathname + location.search);
  const observedPath = React.useRef(path);
  useEffect(() => {
    const pop = () => {
      const next = location.pathname + location.search;
      if (next !== observedPath.current && hasPendingSaves()) {
        history.pushState({}, "", observedPath.current);
        return;
      }
      if (next !== observedPath.current) {
        observedPath.current = next;
        if (navigationEpoch) navigationEpoch.current++;
      }
      setPath(next);
    };
    const clicks = (event: MouseEvent) => {
      const a = (event.target as HTMLElement).closest("a");
      if (
        !a ||
        a.target ||
        a.download ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.defaultPrevented ||
        event.button !== 0
      )
        return;
      const url = new URL(a.href);
      if (url.origin !== location.origin || url.hash || needsDomainNavigation(url, location.origin)) return;
      event.preventDefault();
      history.pushState({}, "", url.pathname + url.search);
      pop();
      window.scrollTo(0, 0);
    };
    const protectLinks = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.("a[href]");
      if (!hasPendingSaves() || !anchor || (anchor as HTMLAnchorElement).target ||
          (anchor as HTMLAnchorElement).hasAttribute("download") || event.button !== 0 ||
          event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", protectLinks, true);
    window.addEventListener("popstate", pop);
    document.addEventListener("click", clicks);
    return () => {
      document.removeEventListener("click", protectLinks, true);
      window.removeEventListener("popstate", pop);
      document.removeEventListener("click", clicks);
    };
  }, []);
  const previousPath = React.useRef(path);
  useEffect(() => {
    if (previousPath.current === path) return;
    previousPath.current = path;
    // SPA navigation must announce the new page, including lazily loaded views.
    // Stop waiting as soon as the person starts interacting with the new view.
    let observer: MutationObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let focusedHeading: HTMLElement | undefined;
    const stop = () => {
      observer?.disconnect();
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", stop);
      document.removeEventListener("pointerdown", stop);
    };
    const focusHeading = () => {
      // A remembered-device unlock can replace an intermediate heading. Follow
      // that replacement only while no keyboard/pointer interaction has begun.
      if (focusedHeading?.isConnected) return;
      const visible = (node: HTMLElement) => node.getClientRects().length &&
        !node.closest("[hidden]") && getComputedStyle(node).visibility === "visible";
      const heading = Array.from(document.querySelectorAll<HTMLElement>("#main-content h1")).find(visible) ||
        Array.from(document.querySelectorAll<HTMLElement>("#main-content h2")).find(visible);
      if (!heading) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      focusedHeading = heading;
    };
    timeout = setTimeout(stop, 12000);
    document.addEventListener("keydown", stop);
    document.addEventListener("pointerdown", stop);
    frame = requestAnimationFrame(() => {
      observer = new MutationObserver(focusHeading);
      observer.observe(document.body, {childList: true, subtree: true});
      focusHeading();
    });
    return stop;
  }, [path]);
  return path;
}
export function navigate(path: string) {
  if (hasPendingSaves()) return;
  const destination = new URL(path, location.href);
  if (needsDomainNavigation(destination, location.origin)) {
    location.assign(destination.href);
    return;
  }
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}
