import {startAutomaticUpdates} from "./automatic-updates";
import {FeedUnreadProvider,FeedBadge} from "./FeedUnread";
import { isMemberPath } from "./routes";
import { PhotoCollection } from "./PhotoCollection";
import { Albums, AlbumDetail } from "./Albums";
import {PeopleDirectory} from "./PeopleTags";
import { FeatureAdditions } from "./FeatureAdditions";
import { hasPendingSaves, pendingSaves } from "./pending-saves";
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
import { AuthPage, Landing, Policy, StolenAccount, InvitedPolicyPage } from "./Public";
import { VaultProvider, useVault } from "./vault";
import { Feed, Composer } from "./Social";
import { FeedExperience } from "./FeedExperience";
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
import { canonicalNavigation } from "./domain-navigation";
import { initSiteAppearance } from "./site-appearance";
import { initColorScheme } from "./color-scheme";
import { BuilderChat, builderChatAvailable } from "./BuilderChat";
import { AccountDeletionReceipt, completeDeletionInCurrentSession, deletionContextMatches, type DeletionReceipt } from "./account-deletion";
import { installTracing } from "./tracing";
// Loaded on first visit so the inspector adds nothing to the main bundle.
const DiagnosticInspector = React.lazy(() => import("./DiagnosticPanels"));
const TraceInspector = React.lazy(() => import("./TraceInspector"));
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
  const rawPath = route.split("?")[0];
  const path = rawPath;
  const informationPage = ["/about", "/mission", "/principles", "/privacy", "/community", "/accessibility", "/help", "/contact"].includes(path);
  const [member, setMember] = useState<Member | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
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
      (isMemberPath(path) || path === "/staff/moderation" || informationPage) &&
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
    const stopUpdates = startAutomaticUpdates();
    return () => {
      stopUpdates();
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  useEffect(() => {
    const appWindow = window.matchMedia(
      "(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)",
    );
    const pageTitle = path.includes("settings") ? "Settings" : path.includes("groups") ? "Groups" : path.includes("connections") ? "Connections" : path.includes("wall") ? "My wall" : path === "/" ? "Home" : "Porchday";
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
  else if (!online && ((!member && isMemberPath(path)) || path === "/staff" || path === "/staff/" || path === "/staff/moderation"))
    page = <OfflineScreen onRetry={retryConnection} />;
  else if (path === "/account-deletion") page = <AccountDeletionReceipt receipt={deletionReceipt} onClose={() => { setDeletionReceipt(null); navigate("/"); }} />;

  else if (path === "/stolen-account") page = <StolenAccount />;
  else if (path === "/recovery") page = <Recovery />;
  else if (path === "/appeals") page = <Appeals onLogout={signOut} />;
  else if (path === "/staff" || path === "/staff/") page = <StaffEntry />;
  else if (["/login", "/join", "/forgot", "/reset", "/verify"].includes(path))
    page = <AuthPage key={route} mode={path.slice(1)} onSignedIn={session} />;
  else if (informationPage) {
    page = member ? (path === "/about" ? <Landing /> : <Policy page={path === "/mission" ? "about" : path.slice(1)} />)
      : <InvitedPolicyPage path={path} loading={loading} onSignedIn={session} />;
  }
  else if (isMemberPath(path) || path === "/staff/moderation") {
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
  } else page = <AuthPage mode="login" onSignedIn={session} />;
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
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
const primaryLinks = [
  ["/", "feed", "Feed"],
  ["/share", "plus", "Share"],
  ["/albums", "album", "Albums"],
  ["/connections", "people", "Connections"],
  ["/menu", "more", "More"],
];
const secondaryLinks = [
  ["/groups", "group", "Groups"],
  ["/notifications", "bell", "Notifications"],
  ["/wall", "wall", "My wall"],
];
const featureLink = ["/features", "code", "Feature additions"];
const settingsLink = ["/settings/profile", "settings", "Settings"];
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
  const shareVisited=useRef(path==="/share");
  if(path==="/share")shareVisited.current=true;
  const navigationDisabled = React.useSyncExternalStore(pendingSaves.subscribe, pendingSaves.getNavigationSnapshot, () => 0) > 0;
  const writesPending = React.useSyncExternalStore(pendingSaves.subscribe, pendingSaves.getSnapshot, () => 0) > 0;
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
  const sidebarLinks = vault.member.status === "suspended" ? [settingsLink] : [...primaryLinks.filter(([href])=>href!=="/menu"), ...secondaryLinks, ...(builderChat ? [featureLink,["/builder-chat","chat","Builder chat"]] : []), settingsLink];
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
  else if (path === "/")
    content = (
      <>
        <FeedExperience />
      </>
    );
  else if (path === "/albums") content = <Albums />;
  else if (path.startsWith("/albums/")) content = <AlbumDetail key={path.split("/")[2]} id={path.split("/")[2]}>{album=><PhotoCollection album={album}/>}</AlbumDetail>;
  else if (path === "/photos") content = <FeedExperience initialContent="photos" initialView="calendar" />;
  else if (path === "/share") content = null;
  else if (path === "/menu") content = <section className="panel form-stack"><h1 className="mobile-tab-title">More</h1><a href="/groups">Groups</a><a href="/notifications">Notifications</a><a href="/wall">My wall</a><a href="/features">Feature additions</a>{builderChat && <a href="/builder-chat">Builder chat</a>}<a href="/settings/profile">Settings</a><Button disabled={writesPending} onClick={logout}><Icon name="logout"/>Log out</Button></section>;
  else if (path.startsWith("/post/"))
    content = <Feed singleId={path.split("/")[2]} />;
  else if (path.startsWith("/wall"))
    content = <Wall id={path.split("/")[2]} />;
  else if (path === "/connections") content = <Connections />;
  else if (path === "/groups") content = <Groups />;
  else if (path.startsWith("/groups/"))
    content = <GroupDetail id={path.split("/")[2]} />;
  else if (path === "/notifications") content = <Notifications />;
  else if (path === "/features") content = <FeatureAdditions />;
  else if (path === "/builder-chat") content = <BuilderChat />;
  else if (path === "/diagnostics")
    content = <React.Suspense fallback={<Loading />}><DiagnosticInspector /></React.Suspense>;
  else if (path === "/performance")
    content = <React.Suspense fallback={<Loading />}><TraceInspector /></React.Suspense>;
  else if (path === "/integrations/authorize")
    content = <IntegrationConsent />;
  else if (path.startsWith("/settings"))
    content = (
      <Settings tab={path.split("/")[2] || "profile"} onLogout={logout} onAccountDeleted={onAccountDeleted} />
    );
  else
    content = (
      <Empty
        title="Page not found"
        action={
          <a className="button primary" href="/">
            Go Home
          </a>
        }
      >
        This page is unavailable.
      </Empty>
    );
  return (
    <FeedUnreadProvider><MemberAvatarProvider><PeopleDirectory>
    <div className="app-layout">
      <header className="app-mobile-header">
        <Logo small href="/" />
      </header>
      <aside className="sidebar">
        <Logo href="/" />
        <nav aria-label="Your Porchday">
          {sidebarLinks.map(
            ([href, icon, name]) => {
              const active =
                href === "/"
                  ? path === "/"
                  : path.startsWith(href.replace("/profile", ""));
              return (
                <a
                  className={`nav-item ${active ? "active" : ""}`}
                  aria-disabled={navigationDisabled || undefined}
                  aria-current={active ? "page" : undefined}
                  key={href}
                  href={href}
                >
                  <Icon name={icon} size={21} />
                  <span>{name}</span>{href === "/" && <FeedBadge/>}
                  {active && <span className="nav-dot" />}
                </a>
              );
            },
          )}
        </nav>
        <div className="sidebar-account">
          <MemberAvatar memberId={vault.member.id} name={vault.member.handle} />
          <a href="/wall">
            <strong>@{vault.member.handle}</strong>
            <small>My profile</small>
          </a>
          <button
            className="icon-button"
            onClick={logout}
            aria-label="Sign out"
            disabled={writesPending}
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
        {shareVisited.current&&vault.member.status!=="suspended"&&<div hidden={path!=="/share"} key={"persistent-share-"+vault.member.id}><div className="page-heading mobile-tab-heading"><h1>Share</h1></div><Composer shareTabs initialAlbum={new URLSearchParams(location.search).get("album")||undefined} onPosted={()=>window.dispatchEvent(new Event("porchday:posts-shared"))}/></div>}
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
          <p>{count ?? "–"} of 150, including family</p>
          <a className="text-link" href="/connections">
            Manage connections <Icon name="arrow" size={15} />
          </a>
        </section>
      </aside>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {(vault.member.status === "suspended"
          ? [settingsLink]
          : primaryLinks
        ).map(([href, icon, name]) => (
          <a
            key={href}
            className={
              (href === "/" ? path === "/" : path.startsWith(href))
                ? "active"
                : ""
            }
            href={href}
            aria-disabled={navigationDisabled || undefined}
            aria-current={(href === "/" ? path === "/" : path.startsWith(href)) ? "page" : undefined}
          >
            <Icon name={icon} size={21} />
            <span>{name}</span>{href === "/" && <FeedBadge/>}
          </a>
        ))}
      </nav>
    </div>
    </PeopleDirectory></MemberAvatarProvider></FeedUnreadProvider>
  );
}
const canonicalDestination = canonicalNavigation(new URL(location.href));
if (canonicalDestination) {
  location.replace(canonicalDestination);
} else {
  installTracing();
  initColorScheme();
  initSiteAppearance();
  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>
      <PendingSaveStatus />
      <App />
    </ErrorBoundary>,
  );
}
