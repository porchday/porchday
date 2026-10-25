import React, { useState } from "react";
import { auth, post, localDate } from "./api";
import { Logo, Icon, Button, Field, Alert, useAction, navigate } from "./ui";
export function PublicHeader() {
  return (
    <header className="public-header wrap">
      <Logo />
      <nav aria-label="Main navigation">
        <a href="/about">The idea</a>
        <a href="/principles">Our promises</a>
        <a href="/login" className="login-link">
          Log in <Icon name="arrow" size={16} />
        </a>
      </nav>
    </header>
  );
}
export function PublicFooter() {
  return (
    <footer className="public-footer wrap">
      <div>
        <Logo small />
        <p>A little closer to your people.</p>
        <small>© {new Date().getFullYear()} Porchday. A private pilot.</small>
      </div>
      <nav aria-label="Information">
        <a href="/about">Our mission</a>
        <a href="/privacy">Privacy</a>
        <a href="/community">Community rules</a>
        <a href="/accessibility">Accessibility</a>
        <a href="/help">Help & contact</a>
        <a href="/third-party-notices.txt">Open-source notices</a>
      </nav>
      <div className="footer-note">
        <Icon name="sun" size={22} />
        <p>
          Made for a good day.
          <br />
          Built for the public good.
        </p>
      </div>
    </footer>
  );
}
export function Landing() {
  return (
    <>
      <PublicHeader />
      <main id="main-content">
        <section className="hero wrap">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="status-dot" /> A SMALLER CORNER OF THE INTERNET
            </span>
            <h1>
              a late 90s style
              <br />
              social network<span className="coral">.</span>
            </h1>
            <p className="hero-promise">
              No ads. No influencers. No algorithm.
            </p>
            <p className="hero-description">
              A little less scrolling. A little more connection.
              <br className="desktop" /> Your friends, your family, and the
              everyday things
              <br className="desktop" /> that bring you closer.
            </p>
            <div className="hero-actions">
              <a href="/join" className="button primary">
                Find your people <Icon name="arrow" size={19} />
              </a>
              <span className="invitation-note">
                Starting small.
                <br />
                By invitation.
              </span>
            </div>
            <div className="hero-mission">
              <Icon name="leaf" size={22} />
              <p>
                Designed for nonprofit stewardship.
                <br />
                <strong>For the public good. Funded by philanthropy.</strong>
              </p>
            </div>
          </div>
          <div
            className="hero-art"
            aria-label="An illustrated preview of a personal Porchday wall"
          >
            <span className="art-caption">a place to just be you ↘</span>
            <div className="art-sun">
              <Icon name="sun" size={78} />
            </div>
            <div className="preview-window">
              <div className="window-bar">
                <span />
                <span />
                <span />
                <small>your little corner</small>
                <Icon name="lock" size={12} />
              </div>
              <div className="preview-cover">
                <span className="cover-sparkle">✳</span>
                <span>
                  ordinary days.
                  <br />
                  <em>good company.</em>
                </span>
                <div className="cover-flower">✿</div>
              </div>
              <div className="preview-profile">
                <span className="illustration-avatar">
                  <svg viewBox="0 0 90 90">
                    <circle cx="45" cy="45" r="45" fill="#dfad89" />
                    <path d="M14 90c0-37 62-37 62 0" fill="#66866e" />
                    <ellipse cx="45" cy="40" rx="19" ry="24" fill="#efcdb4" />
                    <path
                      d="M24 43c-12-28 24-45 41-17l1 23-9-17c-11 5-21 7-31 0"
                      fill="#5b4336"
                    />
                    <path
                      d="M39 49q6 5 12 0"
                      fill="none"
                      stroke="#a16f55"
                      strokeWidth="2"
                    />
                    <circle cx="37" cy="40" r="1.4" />
                    <circle cx="52" cy="40" r="1.4" />
                  </svg>
                </span>
                <div>
                  <h3>Jamie’s little corner</h3>
                  <p>books · plants · very slow Sundays</p>
                </div>
                <span className="mini-tag">feeling good ☀</span>
              </div>
              <div className="preview-post">
                <div className="preview-post-head">
                  <span className="mini-avatar">J</span>
                  <div>
                    <strong>Jamie</strong>
                    <small>Today, 10:42 am · Friends</small>
                  </div>
                  <Icon name="more" size={18} />
                </div>
                <p>The best plans are sometimes no plans at all.</p>
                <div
                  className="garden-picture"
                  role="img"
                  aria-label="Illustration of a sunny windowsill with houseplants"
                >
                  <div className="window-light" />
                  <div className="plant plant-one">
                    <i />
                    <i />
                    <i />
                    <i />
                    <span />
                  </div>
                  <div className="plant plant-two">
                    <i />
                    <i />
                    <i />
                    <span />
                  </div>
                  <div className="coffee">
                    <i />
                  </div>
                  <div className="table-line" />
                </div>
                <div className="preview-reactions">
                  <span>♡ &nbsp; 3</span>
                  <span>☀ &nbsp; 2</span>
                  <small>2 comments</small>
                </div>
              </div>
              <div className="preview-bottom">
                <Icon name="check" size={12} /> A quiet moment. Shared with your
                people.
              </div>
            </div>
            <div className="floating-note">
              <span>✶</span> more catching up.
              <br />
              <em>less keeping up.</em>
            </div>
            <small className="illustration-label">
              An illustrated preview. No public posts.
            </small>
          </div>
        </section>
        <div className="belief-strip">
          <div className="wrap">
            <span>
              <Icon name="people" />
              Friends, not followers
            </span>
            <span>
              <Icon name="clock" />
              Newest first. Always.
            </span>
            <span>
              <Icon name="lock" />
              Your life stays yours
            </span>
            <span>
              <Icon name="sun" />A little more you
            </span>
          </div>
        </div>
        <section className="section wrap">
          <div className="section-heading">
            <span className="eyebrow">
              REMEMBER WHEN THE INTERNET FELT PERSONAL?
            </span>
            <h2>Let’s bring a little of that back.</h2>
            <p>
              A space for the people you actually know. And the things you
              actually want to share.
            </p>
          </div>
          <div className="promise-grid">
            <article>
              <span className="feature-icon apricot">
                <Icon name="people" size={26} />
              </span>
              <h3>
                Your circle.
                <br />
                Not an audience.
              </h3>
              <p>
                Up to 300 friends, including family. Mutual connections,
                ordinary moments, and no follower counts to chase.
              </p>
              <span className="tiny-label">REAL PEOPLE. NO AI AGENTS.</span>
            </article>
            <article>
              <span className="feature-icon sage">
                <Icon name="clock" size={26} />
              </span>
              <h3>
                Catch up.
                <br />
                Then carry on.
              </h3>
              <p>
                Every eligible post from your people, newest first. No
                recommendations, sponsored surprises, or engagement ranking.
              </p>
              <span className="tiny-label">
                YOUR FEED, IN CHRONOLOGICAL ORDER.
              </span>
            </article>
            <article>
              <span className="feature-icon lavender">
                <Icon name="wall" size={26} />
              </span>
              <h3>
                A wall that feels
                <br />
                like your room.
              </h3>
              <p>
                Pick your colors. Share a photo. Make a group. Leave a comment,
                a little love, or a post that disappears tomorrow.
              </p>
              <span className="tiny-label">PERSONAL, IN THE BEST WAY.</span>
            </article>
          </div>
        </section>
        <section className="ownership wrap">
          <div className="ownership-art" aria-hidden="true">
            <div className="data-folder">
              <Icon name="leaf" size={52} />
              <span>
                your memories.
                <br />
                <em>your choice.</em>
              </span>
            </div>
            <span className="ownership-stamp">
              YOURS
              <br />
              TO KEEP
              <br />↗
            </span>
          </div>
          <div>
            <span className="eyebrow">
              A GOOD SOCIAL NETWORK KNOWS ITS PLACE
            </span>
            <h2>
              You control
              <br />
              your data.
            </h2>
            <p>
              Export it. Connect your tools. Move to another platform. Or delete
              it. Your memories belong to you.
            </p>
            <p className="small-copy">
              Private social content is encrypted on your device. Our planned
              Apache 2.0 source release will make how it works open to everyone;
              the development repository is private for now.
            </p>
            <a href="/privacy" className="text-link">
              Read our privacy promise <Icon name="arrow" size={18} />
            </a>
          </div>
        </section>
        <section className="mission-panel wrap">
          <span className="eyebrow">GOOD COMPANY. A BETTER PURPOSE.</span>
          <h2>
            Built for people.
            <br />
            Supported by people.
          </h2>
          <p>
            We believe the places where society connects should serve the public
            good. Porchday is being built for nonprofit stewardship and
            philanthropic funding, with no ads and no sale of your data.
          </p>
          <p className="mission-fine">
            We’re an early, invitation-only pilot. Legal nonprofit status,
            governance, and public financial reporting are being established. We
            aren’t accepting tax-deductible donations here.
          </p>
          <a href="/about" className="button outline">
            Meet the idea <Icon name="arrow" size={18} />
          </a>
          <span className="mission-daisy" aria-hidden="true">
            ✳
          </span>
        </section>
        <section className="closing wrap">
          <span className="eyebrow">PULL UP A CHAIR</span>
          <h2>There’s room for a kinder internet.</h2>
          <a href="/join" className="button primary">
            Join the Porchday pilot <Icon name="arrow" size={18} />
          </a>
          <p>For adults 18 and older. Invitation required.</p>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}
export function AuthPage({
  mode,
  onSignedIn,
  returnTo = "/app",
}: {
  mode: string;
  onSignedIn: () => void;
  returnTo?: string;
}) {
  const query = new URLSearchParams(location.search);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const [invite, setInvite] = useState(query.get("invite") || "");
  const [adult, setAdult] = useState(false);
  const [rules, setRules] = useState(false);
  const [done, setDone] = useState(false);
  const [secondFactor, setSecondFactor] = useState(false);
  const [factorCode, setFactorCode] = useState("");
  const [backupCode, setBackupCode] = useState(false);
  const action = useAction();
  const reset = mode === "reset";
  const join = mode === "join";
  const forgot = mode === "forgot";
  const verify = mode === "verify";
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (secondFactor) {
        await auth(
          backupCode
            ? "two-factor/verify-backup-code"
            : "two-factor/verify-totp",
          { code: factorCode, trustDevice: false },
        );
        setFactorCode("");
        onSignedIn();
        navigate(
          returnTo.startsWith("/app") || returnTo === "/staff"
            ? returnTo
            : "/app",
        );
      } else if (join) {
        await auth("sign-up/email", {
          email,
          password,
          name: handle,
          handle,
          inviteCode: invite,
          adult,
          acceptedRules: rules,
          callbackURL: `${location.origin}/login?verified=1`,
        });
        setDone(true);
      } else if (forgot) {
        await auth("request-password-reset", {
          email,
          redirectTo: `${location.origin}/reset`,
        });
        setDone(true);
      } else if (reset) {
        await auth("reset-password", {
          newPassword: password,
          token: query.get("token"),
        });
        setDone(true);
      } else if (verify) {
        await auth("send-verification-email", {
          email,
          callbackURL: `${location.origin}/login?verified=1`,
        });
        setDone(true);
      } else {
        const result = await auth("sign-in/email", {
          email,
          password,
          callbackURL: "/app",
        });
        setPassword("");
        if (result.twoFactorRedirect) {
          setSecondFactor(true);
        } else {
          onSignedIn();
          navigate(
            returnTo.startsWith("/app") || returnTo === "/staff"
              ? returnTo
              : "/app",
          );
        }
      }
    });
  }
  return (
    <>
      <PublicHeader />
      <main id="main-content" className="auth-layout wrap">
        <aside className="auth-aside">
          <span className="eyebrow">WELCOME TO YOUR LITTLE CORNER</span>
          <h1>
            Good to
            <br />
            see you<span className="coral">.</span>
          </h1>
          <p>
            A place for everyday moments,
            <br />
            and the people who make them matter.
          </p>
          <div className="auth-decoration" aria-hidden="true">
            <Icon name="sun" size={100} />
            <span>come as you are.</span>
          </div>
        </aside>
        <section className="auth-card">
          <div className="card-eyebrow">
            <Icon name={join ? "people" : "lock"} size={20} />{" "}
            {join ? "A small beginning" : "YOUR PRIVATE SPACE"}
          </div>
          <h2>
            {join
              ? "Pull up a chair."
              : forgot
                ? "A fresh start."
                : reset
                  ? "Choose a new password."
                  : verify
                    ? "Check your inbox."
                    : "Welcome back."}
          </h2>
          <p>
            {join
              ? "Porchday is an invitation-only pilot for adults. Have an invitation? You’re in the right place."
              : forgot
                ? "We’ll email a reset link if there’s an eligible account. Your encryption recovery secret is separate."
                : reset
                  ? "Resetting your password won’t unlock your encrypted history or restore lost encryption keys."
                  : verify
                    ? "Verify your email before entering your circle."
                    : "Log in to catch up with your people."}
          </p>
          {done ? (
            <div className="form-success">
              <Icon name="mail" size={35} />
              <h3>{reset ? "Password updated." : "Check your email."}</h3>
              <p>
                {reset
                  ? "Your other sessions have been revoked. Log in with your new password."
                  : "If the request is eligible, a message with your next step is on its way. Check your spam folder, too."}
              </p>
              <a className="button primary" href="/login">
                Back to log in
              </a>
            </div>
          ) : (
            <form onSubmit={submit}>
              <Alert>{action.error}</Alert>
              {secondFactor && (
                <>
                  <Field
                    label={
                      backupCode ? "One-time backup code" : "Authenticator code"
                    }
                    autoComplete="one-time-code"
                    inputMode={backupCode ? "text" : "numeric"}
                    value={factorCode}
                    onChange={(e) => setFactorCode(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setBackupCode(!backupCode);
                      setFactorCode("");
                    }}
                  >
                    {backupCode ? "Use my authenticator" : "Use a backup code"}
                  </button>
                </>
              )}
              {query.has("passwordChanged") && (
                <Alert success>
                  Your password changed and all sessions were signed out. Log in
                  with your new password.
                </Alert>
              )}
              {query.has("verified") && (
                <Alert success>
                  Email verification complete. Please log in.
                </Alert>
              )}
              {query.has("emailChanged") && (
                <Alert success>
                  Your email change is complete. Log in with your new address.
                </Alert>
              )}
              {!reset && !secondFactor && (
                <Field
                  label="Email address"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                  maxLength={254}
                />
              )}{" "}
              {join && (
                <>
                  <Field
                    label="Your handle"
                    help="An exact, public name so your people can find you. 3–24 letters, numbers, or underscores."
                    value={handle}
                    onChange={(e) => setHandle(e.target.value.toLowerCase())}
                    pattern="[a-z0-9_]{3,24}"
                    minLength={3}
                    maxLength={24}
                    autoComplete="username"
                    required
                  />
                  <Field
                    label="Invitation code"
                    value={invite}
                    onChange={(e) => setInvite(e.target.value.trim())}
                    autoComplete="off"
                    required
                  />
                </>
              )}
              {!forgot && !verify && !secondFactor && (
                <Field
                  label={reset ? "New password" : "Password"}
                  type="password"
                  autoComplete={
                    join || reset ? "new-password" : "current-password"
                  }
                  minLength={12}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  help={
                    join || reset
                      ? "Use a unique passphrase of at least 12 characters. Password managers are welcome."
                      : undefined
                  }
                  required
                />
              )}
              {join && (
                <>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={adult}
                      onChange={(e) => setAdult(e.target.checked)}
                      required
                    />
                    <span>I am at least 18 years old.</span>
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={rules}
                      onChange={(e) => setRules(e.target.checked)}
                      required
                    />
                    <span>
                      I agree to the{" "}
                      <a href="/community" target="_blank" rel="noreferrer">
                        community rules
                      </a>{" "}
                      and{" "}
                      <a href="/privacy" target="_blank" rel="noreferrer">
                        privacy policy
                      </a>
                      . I’m a person operating my own account, not an AI agent.
                    </span>
                  </label>
                </>
              )}
              {!join && !forgot && !reset && !verify && !secondFactor && (
                <a className="forgot-link" href="/forgot">
                  Forgot password?
                </a>
              )}
              <Button type="submit" variant="primary full" busy={action.busy}>
                {secondFactor
                  ? "Verify & log in"
                  : join
                    ? "Create my account"
                    : forgot
                      ? "Send a reset link"
                      : reset
                        ? "Save new password"
                        : verify
                          ? "Resend verification"
                          : "Log in"}
                <Icon name="arrow" size={18} />
              </Button>
            </form>
          )}
          <div className="auth-bottom">
            {join ? (
              <span>
                Already have a spot? <a href="/login">Log in</a>
              </span>
            ) : (
              <span>
                Have an invitation? <a href="/join">Join Porchday</a>
              </span>
            )}
            {!join && <a href="/verify">Resend email verification</a>}
            <a href="/stolen-account">My account was stolen</a>
          </div>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}
export function StolenAccount() {
  const action = useAction();
  const [done, setDone] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    await action.run(async () => {
      const r = await post("/api/account-recovery/reports", {
        accountReference: data.account_identifier,
        safeEmail: data.contact_email,
        compromisedAt: data.compromised_at
          ? new Date(String(data.compromised_at)).toISOString()
          : undefined,
        trustedMethod: data.trusted_method,
        description: data.description,
      });
      setDone(
        r.case_reference ||
          r.reference ||
          "Check your safe contact inbox for next steps.",
      );
    });
  }
  return (
    <>
      <PublicHeader />
      <main id="main-content" className="narrow-page">
        <span className="eyebrow">ACCOUNT SAFETY</span>
        <h1>
          Let’s help you find
          <br />
          your way back.
        </h1>
        <p>
          You can report a stolen account even if its email or password was
          changed. This report does not freeze or transfer an account by itself.
        </p>
        {done ? (
          <Alert success>
            We received your request. If eligible, you’ll receive verification
            at your safe contact address. Case reference: {done}
          </Alert>
        ) : (
          <form className="panel form-stack" onSubmit={submit}>
            <Alert>{action.error}</Alert>
            <Field
              label="Handle or previous account email"
              name="account_identifier"
              required
              maxLength={254}
            />
            <Field
              label="A safe email address we can reach"
              name="contact_email"
              type="email"
              required
              help="Use an address the other person cannot access. Verifying it is for case communication, not proof of account ownership."
            />
            <Field
              label="When did you notice?"
              name="compromised_at"
              type="datetime-local"
              max={new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
                .toISOString()
                .slice(0, 16)}
              required
            />
            <label className="field">
              <span>Can you still use a trusted login or recovery method?</span>
              <select name="trusted_method">
                <option value="none">No, I’ve lost access</option>
                <option value="email">I can access my previous email</option>
                <option value="device">
                  I have a trusted signed-in device
                </option>
                <option value="recovery">
                  I have my encryption recovery secret
                </option>
              </select>
            </label>
            <label className="field">
              <span>What happened?</span>
              <textarea
                name="description"
                maxLength={2000}
                required
                rows={5}
                placeholder="Share enough detail to help a reviewer. Never include passwords, recovery secrets, or access tokens."
              />
            </label>
            <p className="small-copy">
              Never send us your password or encryption recovery secret.
              Restoring your account does not let support decrypt your history.
              When all trusted methods are lost, recovery requires two
              authorized reviewers.
            </p>
            <Button variant="primary" busy={action.busy}>
              Submit a secure report
            </Button>
          </form>
        )}
        <p>
          <a href="/recovery">Resume an existing recovery case</a>
        </p>
        <p>
          <a href="/login">Return to log in</a>
        </p>
      </main>
      <PublicFooter />
    </>
  );
}
const policyContent: Record<
  string,
  { title: string; intro: string; sections: [string, string][] }
> = {
  about: {
    title: "A place worth gathering.",
    intro:
      "The internet can be a good neighbor. Porchday is our attempt to make a small part of it feel that way again.",
    sections: [
      [
        "For the public good",
        "Our intention is nonprofit stewardship, funded by philanthropy. We want decisions to serve members, with published governance and financial reporting. The legal entity, nonprofit status, board, and donation arrangements are still being established. This private pilot makes no tax-deductibility claims.",
      ],
      [
        "Familiar, with a little more care",
        "A personal wall. A feed of your friends, newest first. Photos, comments, groups, and profiles that feel like you. No ads, no recommendations engineered for engagement, and no sale of reach.",
      ],
      [
        "Starting small",
        "The first pilot is invitation-only and for adults 18 and older. Encryption review, moderation staffing, recovery coverage, and legal policies must be ready before real members are admitted.",
      ],
      [
        "Built in the open, soon",
        "The code is licensed under Apache 2.0. The development repository is private while we build; a reviewed public source release is a launch milestone.",
      ],
    ],
  },
  principles: {
    title: "A few good promises.",
    intro: "Simple ideas, built into how this place works.",
    sections: [
      [
        "No ads",
        "No advertising inventory, sponsored posts, paid reach, or behavioral advertising trackers. Contributions will never buy visibility.",
      ],
      [
        "No influencers",
        "Everyone connects mutually, with up to 300 friends including family. No followers, creator tiers, trending lists, public popularity scores, or engagement manipulation. Having an audience somewhere else does not exclude a person from joining.",
      ],
      [
        "No algorithm",
        "Your eligible friends’ posts appear newest first. Ordinary software still handles permissions, sorting, and safety; we do not rank your feed to maximize engagement.",
      ],
      [
        "Real people. No AI agents.",
        "People operate their own accounts. Assistive technology, dictation, and translation are welcome when a person chooses and submits the action. Technical proof of humanity is future work; we do not claim verified human identity.",
      ],
      [
        "You control your data",
        "Export your contributions, authorize scoped tools, migrate using the open archive format, or delete your account. Exported copies and screenshots cannot be recalled.",
      ],
    ],
  },
  privacy: {
    title: "Your life stays yours.",
    intro:
      "Private social content is encrypted on your device. It is not an invitation for us to read along.",
    sections: [
      [
        "What is encrypted",
        "Post and comment text, photos, private profile details, group descriptions, and reaction choices are encrypted for their authorized recipients. The service stores ciphertext and does not hold a master decryption key. The encryption implementation requires independent review before real pilot admission.",
      ],
      [
        "What the service can see",
        "Operational metadata includes public handles, email for authentication, membership, connections, post routing, timing, recipient devices, ciphertext sizes, and usage needed for security and delivery. This information is not end-to-end encrypted. Cloudflare and PlanetScale process necessary service metadata.",
      ],
      [
        "Your keys and recovery",
        "Your login password and encryption recovery secret are separate. A trusted device or your recovery secret is required to recover old content. Support cannot decrypt your history. Browser key protection cannot defend against a compromised device or malicious same-origin code.",
      ],
      [
        "Disappearing means removed from the service",
        "At expiry, posts and descendants stop being readable through the service and are queued for physical deletion. Recipients may retain screenshots, exported copies, or previously delivered keys. Backups age out under the documented operator retention schedule.",
      ],
      [
        "Reports are a deliberate disclosure",
        "When reporting content, you choose what evidence to disclose to authorized moderators. A report preview identifies exactly what will be sent. Moderators cannot browse private walls merely because of their role.",
      ],
      [
        "Your choices",
        "Settings provides local export, reviewed import, integrations, blocks, mutes, notifications, and deletion. The service uses necessary session cookies and protected device-key storage, with no advertising trackers. No decrypted social content is cached by the service worker.",
      ],
      [
        "Pilot privacy notice",
        "This is an early invitation-only pilot, not an invitation to upload sensitive real-world data. Legal operator details, final retention schedules, rights-contact information, and the independent security review are required launch work.",
      ],
    ],
  },
  community: {
    title: "Be a good neighbor.",
    intro: "A small circle works when people feel safe being themselves.",
    sections: [
      [
        "Keep it human",
        "You must be 18 or older and personally operate your account. No AI personas, autonomous accounts, bot posting, or automated connection building. Accessibility tools and ordinary editing aids are welcome.",
      ],
      [
        "Treat people with care",
        "No harassment, hate, threats, impersonation, scams, exploitation, or non-consensual intimate content. Respect people’s boundaries and privacy. Do not share another person’s private content without permission.",
      ],
      [
        "Leave the promotion outside",
        "No purchased reach, unsolicited commercial promotion, mass invitations, or engagement manipulation. Friendship is not an audience acquisition tool.",
      ],
      [
        "You have controls",
        "Block or mute someone, remove a connection, leave a group, or report a concern. A report is reviewed by a person; an appeal route is available. Blocking also applies inside shared groups.",
      ],
      [
        "Moderation with limits",
        "Moderators rely on behavioral metadata and evidence members explicitly disclose. They cannot decrypt everyone’s content. Restrictions preserve ordinary export, deletion, and appeals, except when a corroborated account takeover requires a protective hold.",
      ],
    ],
  },
  accessibility: {
    title: "A place for everyone to belong.",
    intro:
      "Accessibility is part of a welcoming community, not an extra setting.",
    sections: [
      [
        "Our target",
        "We are working toward WCAG 2.2 AA: keyboard navigation, visible focus, meaningful labels, readable contrast, reduced motion, and scalable text. A full independent accessibility audit remains a launch milestone.",
      ],
      [
        "Personal without losing readability",
        "Themes use constrained colors and fonts. You can view walls in the standard theme. Photos support text descriptions and reactions have written names.",
      ],
      [
        "Install or use your browser",
        "Porchday works in a current browser. On iPhone, use Safari’s Share menu and Add to Home Screen to install the PWA. Other browsers may show an install option in the address bar. The app requires connectivity for private content.",
      ],
    ],
  },
  help: {
    title: "A little help, close by.",
    intro: "The essentials for finding your way around Porchday.",
    sections: [
      [
        "Lost account access",
        "Use Forgot password on the login page. If an account was taken over or its email changed, use My account was stolen. Never share your password or recovery secret with anyone, including support.",
      ],
      [
        "Missing encrypted history",
        "Sign in on an existing trusted device or use your encryption recovery secret. A password reset cannot recover encryption keys. If every trusted device and recovery secret is lost, old encrypted content is permanently inaccessible.",
      ],
      [
        "Reporting a problem",
        "Use Report on the relevant content or use Settings → Safety. Choose the evidence to disclose. For account compromise, use the dedicated stolen-account flow. Human support staffing and response targets must be established before opening the real pilot.",
      ],
      [
        "Bringing your memories with you",
        "Settings → Your data provides exports and the Porchday archive importer. Imports are private until you deliberately review their audiences. Connections always require fresh mutual consent.",
      ],
      [
        "A quiet feed",
        "Home shows your posts and your accepted connections’ eligible posts, newest first. Groups have their own walls. Check mutes and filters if you think something is missing.",
      ],
    ],
  },
};
export function Policy({ page }: { page: string }) {
  const p = policyContent[page] || policyContent.help;
  return (
    <>
      <PublicHeader />
      <main id="main-content" className="narrow-page policy">
        <span className="eyebrow">THE PORCHDAY WAY</span>
        <h1>{p.title}</h1>
        <p className="policy-intro">{p.intro}</p>
        {p.sections.map(([heading, body]) => (
          <section key={heading}>
            <h2>{heading}</h2>
            <p>{body}</p>
          </section>
        ))}
        {page === "help" && (
          <a href="/stolen-account" className="button outline">
            My account was stolen <Icon name="arrow" />
          </a>
        )}
        <small>
          Private pilot notice · Updated {localDate("2026-10-24T12:00:00Z")}
        </small>
      </main>
      <PublicFooter />
    </>
  );
}
