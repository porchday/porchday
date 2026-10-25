import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { get, auth, type Member } from "./api";
import {
  Alert,
  Avatar,
  Button,
  Empty,
  Icon,
  Loading,
  Logo,
  useRoute,
  navigate,
  useAction,
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
import "./styles.css";
import "./retro.css";
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
          title="Let’s take a breath."
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
  const route = useRoute();
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
  async function session() {
    setLoading(true);
    setError("");
    setRestricted(false);
    try {
      const m = await get<Member>("/me");
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
    document.title =
      path === "/"
        ? "Porchday — a simple social network"
        : `${path.includes("settings") ? "Settings" : path.includes("groups") ? "Groups" : path.includes("connections") ? "Your circle" : path.includes("wall") ? "Your wall" : path.includes("app") ? "Home" : "Welcome"} · Porchday`;
  }, [path]);
  async function signOut() {
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
  let page: React.ReactNode;
  if (!online && ((!member && path.startsWith("/app")) || path === "/staff" || path === "/staff/" || path === "/staff/moderation"))
    page = <OfflineScreen onRetry={retryConnection} />;
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
          <VaultProvider member={member}>
            <AppShell path={path} routeKey={route} onLogout={signOut} />
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
          <span>A fresh Porchday is ready. {updateNotice}</span>
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
        title="You’re offline. Your circle can wait."
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
function AppShell({
  path,
  routeKey,
  onLogout,
}: {
  path: string;
  routeKey: string;
  onLogout: () => Promise<void>;
}) {
  const vault = useVault();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    get("/me")
      .then((m) => setCount(m.connection_count))
      .catch(() => {});
  }, [path]);
  async function logout() {
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
        <Settings tab="data" onLogout={logout} />
      </>
    );
  else if (path === "/staff/moderation") content = <StaffConsole initialTab="moderation" />;
  else if (path === "/app" || path === "/app/")
    content = (
      <>
        <div className="page-heading">
          <span className="eyebrow">YOUR PEOPLE, IN ORDER</span>
          <h1>
            A good day to catch up<span className="coral">.</span>
          </h1>
          <p>Little moments. Familiar faces. You’re right where you belong.</p>
        </div>
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
  else if (path === "/app/integrations/authorize")
    content = <IntegrationConsent />;
  else if (path.startsWith("/app/settings"))
    content = (
      <Settings tab={path.split("/")[3] || "profile"} onLogout={logout} />
    );
  else
    content = (
      <Empty
        title="A little off the path."
        action={
          <a className="button primary" href="/app">
            Go Home
          </a>
        }
      >
        This page isn’t part of your circle.
      </Empty>
    );
  return (
    <div className="app-layout">
      <header className="app-mobile-header">
        <Logo small />
        <button className="icon-button" onClick={logout} aria-label="Sign out">
          <Icon name="logout" />
        </button>
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
        <Logo />
        <nav aria-label="Your Porchday">
          {(vault.member.status === "suspended" ? [links[5]] : links).map(
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
        <div className="sidebar-note">
          <Icon name="sun" size={28} />
          <p>
            More catching up.
            <br />
            <em>Less keeping up.</em>
          </p>
        </div>
        <div className="sidebar-account">
          <Avatar name={vault.member.handle} />
          <a href="/app/wall">
            <strong>@{vault.member.handle}</strong>
            <small>Your little corner</small>
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
          <span>Porchday · private pilot</span>
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
      </main>
      <aside className="right-rail">
        <div className="rail-date">
          <Icon name="sun" size={30} />
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
          <p>A day for the little things.</p>
        </div>
        <section className="rail-card">
          <span className="eyebrow">YOUR CIRCLE</span>
          <div className="circle-count">
            <span>{count ?? "–"}</span>
            <small>
              of 300
              <br />
              people
            </small>
          </div>
          <div className="circle-meter">
            <span style={{ width: `${Math.max(2, (count || 0) / 3)}%` }} />
          </div>
          <p>
            Friends and family.
            <br />
            The people who feel like home.
          </p>
          <a className="text-link" href="/app/connections">
            Make a connection <Icon name="arrow" size={15} />
          </a>
        </section>
        <section className="rail-card privacy-note">
          <Icon name="lock" size={23} />
          <h3>A private little place.</h3>
          <p>
            Your social content is encrypted for the people you share it with.
            Even we can’t read along.
          </p>
          <a href="/privacy">How privacy works ↗</a>
        </section>
        <div className="rail-footer">
          No ads. No influencers.
          <br />
          No algorithm.<span>Just a little more connection.</span>
        </div>
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
            <span>{name === "Connections" ? "Circle" : name}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
