import React, { useEffect, useRef, useState } from "react";
import { auth, post, localDate } from "./api";
import { Logo, Icon, Button, Field, Alert, useAction, navigate } from "./ui";
import { BackgroundControls } from "./BackgroundControls";
export function PublicHeader() {
  return (
    <header className="public-header wrap">
      <div className="homemade-sign">
        <Logo />
      </div>
      <nav aria-label="Main navigation">
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/principles">Principles</a>
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
        <small>By invitation only.</small>
      </div>
      <nav aria-label="Information">
        <a href="/about">Our mission</a>
        <a href="/privacy">Privacy</a>
        <a href="/community">Community rules</a>
        <a href="/accessibility">Accessibility</a>
        <a href="/help">Help & contact</a>
        <a href="/third-party-notices.txt">Open-source notices</a>
      </nav>
      <BackgroundControls />
    </footer>
  );
}
export function Landing() {
  return (
    <>
      <PublicHeader />
      <main id="main-content" tabIndex={-1} className="classic-home simple-home wrap">
        <section className="classic-welcome classic-box">
          <h1>a simple social network</h1>
          <div className="classic-box-body">
            <p className="classic-promise">No ads, algorithms, or influencers.</p>
            <p>Already have an account?</p>
            <a className="button primary" href="/login">Member log in</a>
            <p className="invitation-line">Have an invitation? <a href="/join">create account</a></p>
          </div>
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
  const [invite, setInvite] = useState(() =>
    new URLSearchParams((location.hash || "").slice(1)).get("invite") ||
    query.get("invite") || "",
  );
  const [adult, setAdult] = useState(false);
  const [rules, setRules] = useState(false);
  const [done, setDone] = useState(false);
  const successHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (done) successHeading.current?.focus(); }, [done]);
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
      <main id="main-content" tabIndex={-1} className="auth-layout wrap auth-simple">
        <section className="auth-card">
          <h1>
            {join
              ? "Create account"
              : forgot
                ? "Reset password"
                : reset
                  ? "Choose a new password"
                  : verify
                    ? "Verify your email"
                    : "Log in"}
          </h1>
          <p>
            {join
              ? "An invitation is required. You must be 18 or older to join."
              : forgot
                ? "We’ll email a reset link if there’s an eligible account. Your encryption recovery secret is separate."
                : reset
                  ? "Resetting your password won’t unlock your encrypted history or restore lost encryption keys."
                  : verify
                    ? "Open the verification link in your email to continue."
                    : "Enter your email and password."}
          </p>
          {done ? (
            <div className="form-success">
              <Icon name="mail" size={35} />
              <h3 ref={successHeading} tabIndex={-1}>{reset ? "Password updated." : "Check your email."}</h3>
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
                    autoFocus
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
                query.has("error") ? (
                  <Alert>
                    This email-change step could not be completed. Sign in with
                    your currently verified address to request a fresh change
                    if needed.
                  </Alert>
                ) : (
                  <div className="report-preview" role="status">
                    Changing your email requires approval at your current
                    address and verification at the new one. If you just
                    approved the request, check your new inbox for the
                    verification link. Once you’ve verified the new address,
                    log in with it.
                  </div>
                )
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
                    help="Your public username. Use 3–24 letters, numbers, or underscores."
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
                      ? "Use a unique passphrase of at least 12 characters. You can use a password manager."
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
                Already have an account? <a href="/login">Log in</a>
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
  const [done, setDone] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    await action.run(async () => {
      await post("/api/account-recovery/reports", {
        accountReference: data.account_identifier,
        safeEmail: data.contact_email,
        compromisedAt: data.compromised_at
          ? new Date(String(data.compromised_at)).toISOString()
          : undefined,
        trustedMethod: data.trusted_method,
        description: data.description,
      });
      setDone(true);
    });
  }
  return (
    <>
      <PublicHeader />
      <main id="main-content" tabIndex={-1} className="narrow-page">
        <span className="eyebrow">ACCOUNT SAFETY</span>
        <h1>Report a stolen account</h1>
        <p>
          You can report a stolen account even if its email or password was
          changed. This report does not freeze or transfer an account by itself.
        </p>
        {done ? (
          <Alert success>
            We received your request. Check your safe contact inbox for a
            verification link and next steps. This response does not confirm
            whether an account exists.
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
    title: "About Porchday",
    intro:
      "Porchday is a social network built for the public good.",
    sections: [
      [
        "For the public good",
        "Porchday is inspired by the likes of Wikipedia, Firefox, Signal, and Internet Archive. We want decisions to serve members, with published governance and financial reporting. The legal entity, nonprofit status, board, and donation arrangements are still being established. This private pilot makes no tax-deductibility claims.",
      ],
      [
        "How Porchday works",
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
    title: "Our principles",
    intro: "The principles behind Porchday.",
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
        "No AI agents",
        "People operate their own accounts. Assistive technology, dictation, and translation are welcome when a person chooses and submits the action. Technical proof of humanity is future work; we do not claim verified human identity.",
      ],
      [
        "No need to trust us",
        "You own your data. Export it, move it, or delete your account. Porchday is being built around open-source code and an open protocol so you can inspect how it works and choose other tools and services. The code is licensed under Apache 2.0; public release of the source and protocol documentation is a launch milestone. Our open archive format already supports portable exports.",
      ],
    ],
  },
  privacy: {
    title: "Privacy",
    intro:
      "Private social content is encrypted on your device. Porchday cannot read it.",
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
    title: "Community rules",
    intro: "These rules apply to every account.",
    sections: [
      [
        "Personal accounts",
        "You must be 18 or older and personally operate your account. No AI personas, autonomous accounts, bot posting, or automated connection building. Accessibility tools and ordinary editing aids are welcome.",
      ],
      [
        "Treat people with care",
        "No harassment, hate, threats, impersonation, scams, exploitation, or non-consensual intimate content. Respect people’s boundaries and privacy. Do not share another person’s private content without permission.",
      ],
      [
        "No unsolicited promotion",
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
    title: "Accessibility",
    intro:
      "Our accessibility goals and available features.",
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
    title: "Help and contact",
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
        "Exporting and importing your data",
        "Settings → Your data provides exports and the Porchday archive importer. Imports are private until you deliberately review their audiences. Connections always require fresh mutual consent.",
      ],
      [
        "Chronological feed",
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
      <main id="main-content" tabIndex={-1} className="narrow-page policy">
        <span className="eyebrow">PORCHDAY</span>
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
