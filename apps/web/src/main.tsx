import { FeatureAdditions } from "./FeatureAdditions";
import { hasPendingSaves } from "./pending-saves";
import { MemberAvatar, MemberAvatarProvider } from "./MemberAvatar";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { get, auth, type Member } from "./api";
import {
  Alert,
  Button,
  Empty,
  Icon,
  Loading,
  Logo,
  useRoute,
  navigate,
  useAction,
  PendingSaveStatus,
} from "./ui";
import { AuthPage, Landing, Policy, StolenAccount } from "./Public";
import { VaultProvider, useVault } from "./vault";
import { Feed } from "./Social";
import {
  Connections,
  Groups,
  GroupDetail,
  Notifications,
  Wall,
} from "./Community";
import { Settings } from "./Settings";
import { Recovery } from "./Recovery";
import { IntegrationConsent } from "./Integrations";
import { StaffConsole, StaffEntry } from "./Staff";
import { Appeals } from "./Appeals";
import { signOutSafely } from "./logout";
import { BackgroundControls } from "./BackgroundControls";
import { ColorSchemeControls } from "./ColorSchemeControls";
import { LegacyDomainNotice } from "./DomainMigration";
import { initSiteAppearance } from "./site-appearance";
import { initColorScheme } from "./color-scheme";
import { BuilderChat, builderChatAvailable } from "./BuilderChat";
import { AccountDeletionReceipt, completeDeletionInCurrentSession, deletionContextMatches, type DeletionReceipt } from "./account-deletion";
import "./styles.css";
import "./retro.css";
import "virtual:dark.css";
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="narrow-page">
        <Logo />
        <Empty
          icon="leaf"
          title="Unable to load Porchday"
          action={
            <Button variant="primary" onClick={() => location.reload()}>
              Try again
            </Button>
          }
        >
          Something didn’t load as expected. Your private content has not been
          sent to an error-tracking service.
        </Empty>
      </main>
    ) : (
      this.props.children
    );
  }
}
function App() {
  const navigationEpoch = useRef(0);
  const route = useRoute(navigationEpoch);
  const navigationAtRender = navigationEpoch.current;
  const path = route.split("?")[0];
  const [member, setMember] = useState<Member | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [update, setUpdate] = useState(false);
  const [updateNotice, setUpdateNotice] = useState("");
  const [deletionReceipt, setDeletionReceipt] = useState<DeletionReceipt | null>(null);
  const [deletionCleanupBusy, setDeletionCleanupBusy] = useState(false);
  const authenticationGeneration = useRef(0);
  const generationAtRender = authenticationGeneration.current;
  const deletionAttempt = useRef<symbol | null>(null);
  useEffect(() => { if (path !== "/account-deletion") { setDeletionReceipt(null); deletionAttempt.current = null; } }, [path]);
  async function session() {
    authenticationGeneration.current++;
    setLoading(true);
    setError("");
    setRestricted(false);
    try {
      const m = await get<Member>("/me?bootstrap=1");
      setMember(m);
    } catch (e: any) {
      setMember(null);
      if (e.status === 403 && e.code === "ACCOUNT_UNAVAILABLE")
        setRestricted(true);
      if (e.status !== 401) setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (
      (path.startsWith("/app") || path === "/staff/moderation") &&
      !member &&
      !loading &&
      !restricted
    )
      session();
  }, [path]);
  useEffect(() => {
    const up = () => setOnline(true),
      down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    if ("serviceWorker" in navigator)
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          setRegistration(reg);
          if (reg.waiting) setUpdate(true);
          reg.addEventListener("updatefound", () => {
            const next = reg.installing;
            next?.addEventListener("statechange", () => {
              if (
                next.state === "installed" &&
                navigator.serviceWorker.controller
              )
                setUpdate(true);
            });
          });
        })
        .catch(() => {});
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  useEffect(() => {
    const appWindow = window.matchMedia(
      "(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)",
    );
    const pageTitle = path.includes("settings") ? "Settings" : path.includes("groups") ? "Groups" : path.includes("connections") ? "Connections" : path.includes("wall") ? "My wall" : path.includes("app") ? "Home" : "Porchday";
    const updateTitle = () => {
      // Installed app windows already supply the app name in their chrome.
      const standalone = appWindow.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      document.title = standalone
        ? pageTitle
        : path === "/"
          ? "Porchday — a simple social network"
          : pageTitle === "Porchday" ? pageTitle : `${pageTitle} · Porchday`;
    };
    updateTitle();
    appWindow.addEventListener("change", updateTitle);
    return () => appWindow.removeEventListener("change", updateTitle);
  }, [path]);
  async function signOut() {
    if (hasPendingSaves()) return;
    authenticationGeneration.current++;
    try {
      await signOutSafely();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-out was not confirmed.");
    }
    setMember(null);
    navigate("/login");
  }
  async function retryConnection() {
    const response = await fetch("/health", { cache: "no-store" });
    if (!response.ok)
      throw new Error(
        "Porchday is still unavailable. Your drafts remain in this tab.",
      );
    setOnline(true);
    window.dispatchEvent(new Event("online"));
  }
  async function accountDeleted() {
    const attempt = Symbol();
    await completeDeletionInCurrentSession({
      canStart: () => !!member && deletionContextMatches(
        { route, authentication: generationAtRender, navigation: navigationAtRender },
        { route: location.pathname + location.search, authentication: authenticationGeneration.current, navigation: navigationEpoch.current },
      ),
      start: () => {
        deletionAttempt.current = attempt;
        setDeletionCleanupBusy(true);
        setDeletionReceipt({ clearing: true, cleanupUnconfirmed: false });
        setMember(null); setError(""); navigate("/account-deletion");
      },
      cleanup: signOutSafely,
      receiptIsCurrent: () => deletionAttempt.current === attempt && location.pathname === "/account-deletion" && authenticationGeneration.current === generationAtRender,
      finish: cleanupUnconfirmed => setDeletionReceipt({ clearing: false, cleanupUnconfirmed }),
      end: () => setDeletionCleanupBusy(false),
    });
  }
  let page: React.ReactNode;
  if (deletionCleanupBusy && path !== "/account-deletion")
    page = <main id="main-content" className="narrow-page"><Loading text="Finishing sign-out…" /></main>;
  else if (!online && ((!member && path.startsWith("/app")) || path === "/staff" || path === "/staff/" || path === "/staff/moderation"))
    page = <OfflineScreen onRetry={retryConnection} />;
  else if (path === "/account-deletion") page = <AccountDeletionReceipt receipt={deletionReceipt} onClose={() => { setDeletionReceipt(null); navigate("/"); }} />;
  else if (path === "/") page = <Landing />;
  else if (path === "/stolen-account") page = <StolenAccount />;
  else if (path === "/recovery") page = <Recovery />;
  else if (path === "/appeals") page = <Appeals onLogout={signOut} />;
  else if (path === "/staff" || path === "/staff/") page = <StaffEntry />;
  else if (["/login", "/join", "/forgot", "/reset", "/verify"].includes(path))
    page = <AuthPage key={route} mode={path.slice(1)} onSignedIn={session} />;
  else if (path.startsWith("/app") || path === "/staff/moderation") {
    page = loading ? (
      <main className="narrow-page">
        <Logo />
        <Loading />
      </main>
    ) : restricted ? (
      <Appeals onLogout={signOut} />
    ) : !member ? (
      <>
        <AuthPage
          key={route}
          mode="login"
          onSignedIn={session}
          returnTo={route}
        />
        {error && (
          <div className="fixed-alert">
            <Alert>{error}</Alert>
          </div>
        )}
      </>
    ) : (
      <>
        {!online && <OfflineScreen onRetry={retryConnection} />}
        <div hidden={!online}>
          <VaultProvider key={member.id} member={member} onAccountDeleted={accountDeleted}>
            <AppShell path={path} routeKey={route} onLogout={signOut} onAccountDeleted={accountDeleted} />
          </VaultProvider>
        </div>
      </>
    );
  } else page = <Policy page={path.slice(1)} />;
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {update && (
        <div className="update-banner" role="status">
          <span>An update is available. {updateNotice}</span>
          <Button
            variant="outline compact"
            onClick={() => {
              const dirty =
                !!document.querySelector('[data-unsaved-draft="true"]') ||
                Array.from(document.querySelectorAll("textarea")).some((el) =>
                  el.value.trim(),
                );
              if (dirty) {
                setUpdateNotice(
                  "Finish or clear your draft before updating; it stays here until then.",
                );
                return;
              }
              registration?.waiting?.postMessage("ACTIVATE_UPDATE");
              navigator.serviceWorker.addEventListener(
                "controllerchange",
                () => location.reload(),
                { once: true },
              );
            }}
          >
            Update now
          </Button>
        </div>
      )}
      {path === "/login" && error && (
        <div className="fixed-alert">
          <Alert>{error}</Alert>
          <Button variant="outline compact" onClick={signOut}>
            Retry sign-out
          </Button>
        </div>
      )}
      <LegacyDomainNotice origin={location.origin} path={path} />
      {page}
    </>
  );
}
function OfflineScreen({ onRetry }: { onRetry: () => Promise<void> }) {
  const action = useAction();
  return (
    <main id="main-content" tabIndex={-1} className="narrow-page">
      <Logo />
      <Empty
        icon="sun"
        title="You’re offline"
        action={
          <Button
            variant="primary"
            busy={action.busy}
            onClick={() => action.run(onRetry)}
          >
            Try again
          </Button>
        }
      >
        Porchday needs a connection to load private posts and photos. We don’t
        store an offline copy of your social content. Drafts and keys already
        open stay in this tab while you reconnect.
      </Empty>
      <Alert>{action.error}</Alert>
    </main>
  );
}
const links = [
  ["/app", "home", "Home"],
  ["/app/wall", "wall", "My wall"],
  ["/app/connections", "people", "Connections"],
  ["/app/groups", "group", "Groups"],
  ["/app/notifications", "bell", "Notifications"],
  ["/app/settings/profile", "settings", "Settings"],
];
const builderChatLink = ["/app/builder-chat", "comment", "Builder chat"];
function AppShell({
  path,
  routeKey,
  onLogout,
  onAccountDeleted,
}: {
  path: string;
  routeKey: string;
  onLogout: () => Promise<void>;
  onAccountDeleted: () => Promise<void>;
}) {
  const vault = useVault();
  const [count, setCount] = useState<number | null>(vault.member.connection_count ?? null);
  const countedPath = useRef(path);
  useEffect(() => {
    if (countedPath.current === path) return;
    countedPath.current = path;
    get("/me").then(m => setCount(m.connection_count)).catch(() => {});
  }, [path]);
  // Builder chat appears only for allowlisted members; see design/builder-chat.md.
  const [builderChat, setBuilderChat] = useState(false);
  useEffect(() => {
    if (vault.member.status !== "suspended") builderChatAvailable().then(setBuilderChat);
  }, []);
  const sidebarLinks = vault.member.status === "suspended" ? [links[5]] : builderChat ? [...links.slice(0, 5), builderChatLink, ["/app/features", "plus", "Feature additions"], links[5]] : links;
  async function logout() {
    if (hasPendingSaves()) return;
    await vault.clear();
    await onLogout();
  }
  let content: React.ReactNode;
  if (vault.member.status === "suspended")
    content = (
      <>
        <Alert>
          This account’s social access is suspended. Your own data export,
          deletion, and independent appeals remain available.
        </Alert>
        <a className="button outline" href="/appeals">
          Request an independent review
        </a>
        <Settings tab="data" onLogout={logout} onAccountDeleted={onAccountDeleted} />
      </>
    );
  else if (path === "/staff/moderation") content = <StaffConsole initialTab="moderation" />;
  else if (path === "/app" || path === "/app/")
    content = (
      <>
        <h1 className="sr-only">Home</h1>
        <Feed />
      </>
    );
  else if (path.startsWith("/app/post/"))
    content = <Feed singleId={path.split("/")[3]} />;
  else if (path.startsWith("/app/wall"))
    content = <Wall id={path.split("/")[3]} />;
  else if (path === "/app/connections") content = <Connections />;
  else if (path === "/app/groups") content = <Groups />;
  else if (path.startsWith("/app/groups/"))
    content = <GroupDetail id={path.split("/")[3]} />;
  else if (path === "/app/notifications") content = <Notifications />;
  else if (path === "/app/features") content = <FeatureAdditions />;
  else if (path === "/app/builder-chat") content = <BuilderChat />;
  else if (path === "/app/integrations/authorize")
    content = <IntegrationConsent />;
  else if (path.startsWith("/app/settings"))
    content = (
      <Settings tab={path.split("/")[3] || "profile"} onLogout={logout} onAccountDeleted={onAccountDeleted} />
    );
  else
    content = (
      <Empty
        title="Page not found"
        action={
          <a className="button primary" href="/app">
            Go Home
          </a>
        }
      >
        This page is unavailable.
      </Empty>
    );
  return (
    <MemberAvatarProvider>
    <div className="app-layout">
      <header className="app-mobile-header">
        <Logo small href="/app" />
        <button className="icon-button" onClick={logout} aria-label="Sign out">
          <Icon name="logout" />
        </button>
        {builderChat && (
          <a href="/app/builder-chat" className="icon-button" aria-label="Builder chat">
            <Icon name="comment" />
          </a>
        )}
        <a
          href="/app/notifications"
          className="icon-button"
          aria-label="Notifications"
        >
          <Icon name="bell" />
        </a>
        <a
          href="/app/settings/profile"
          className="icon-button"
          aria-label="Settings"
        >
          <Icon name="settings" />
        </a>
      </header>
      <aside className="sidebar">
        <Logo href="/app" />
        <nav aria-label="Your Porchday">
          {sidebarLinks.map(
            ([href, icon, name]) => {
              const active =
                href === "/app"
                  ? path === "/app"
                  : path.startsWith(href.replace("/profile", ""));
              return (
                <a
                  className={`nav-item ${active ? "active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  key={href}
                  href={href}
                >
                  <Icon name={icon} size={21} />
                  <span>{name}</span>
                  {active && <span className="nav-dot" />}
                </a>
              );
            },
          )}
        </nav>
        <div className="sidebar-account">
          <MemberAvatar memberId={vault.member.id} name={vault.member.handle} />
          <a href="/app/wall">
            <strong>@{vault.member.handle}</strong>
            <small>My profile</small>
          </a>
          <button
            className="icon-button"
            onClick={logout}
            aria-label="Sign out"
          >
            <Icon name="logout" size={17} />
          </button>
        </div>
        <div className="sidebar-footer">
          <a href="/privacy">Privacy</a>
          <a href="/community">Rules</a>
          <a href="/help">Help</a>
          <a href="https://github.com/porchday/porchday">Source code</a>
          <span>Porchday · By invitation only</span>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1} className="app-main">
        {vault.member.status === "restricted" && (
          <Alert>
            This account can read existing content, but social changes are
            restricted. Safety and data controls remain available.{" "}
            <a href="/appeals">Request an independent review.</a>
          </Alert>
        )}
        <React.Fragment key={routeKey}>{content}</React.Fragment>
        <footer className="member-appearance-footer">
          <ColorSchemeControls />
          <BackgroundControls />
        </footer>
      </main>
      <aside className="right-rail">
        <div className="rail-date">
          <span>
            {new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(
              new Date(),
            )}
          </span>
          <strong>
            {new Intl.DateTimeFormat(undefined, {
              month: "long",
              day: "numeric",
            }).format(new Date())}
          </strong>
        </div>
        <section className="rail-card">
          <h2>Connections</h2>
          <p>{count ?? "–"} of 300, including family</p>
          <a className="text-link" href="/app/connections">
            Manage connections <Icon name="arrow" size={15} />
          </a>
        </section>
      </aside>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {(vault.member.status === "suspended"
          ? [links[5]]
          : [links[0], links[2], links[3], links[1]]
        ).map(([href, icon, name]) => (
          <a
            key={href}
            className={
              (href === "/app" ? path === "/app" : path.startsWith(href))
                ? "active"
                : ""
            }
            href={href}
            aria-current={(href === "/app" ? path === "/app" : path.startsWith(href)) ? "page" : undefined}
          >
            <Icon name={icon} size={21} />
            <span>{name}</span>
          </a>
        ))}
      </nav>
    </div>
    </MemberAvatarProvider>
  );
}
initColorScheme();
initSiteAppearance();
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <PendingSaveStatus />
    <App />
  </ErrorBoundary>,
);
