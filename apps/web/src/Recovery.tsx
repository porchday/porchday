import React, { useEffect, useState } from "react";
import { get, post, request, localDate, type Json } from "./api";
import { Alert, Button, Field, Icon, useAction } from "./ui";
import { PublicHeader, PublicFooter, StolenAccount } from "./Public";
export function Recovery() {
  const [link] = useState(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    return { token: params.get("token"), restore: params.get("restore") };
  });
  const [session, setSession] = useState("");
  const [status, setStatus] = useState<Json | null>(null);
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [appeal, setAppeal] = useState(false);
  const [password, setPassword] = useState("");
  const [complete, setComplete] = useState(false);
  const action = useAction();
  useEffect(() => {
    if (location.hash)
      history.replaceState({}, "", location.pathname + location.search);
  }, []);
  async function refresh(bearer = session) {
    const result = await request("/api/account-recovery/case", {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    setStatus(result);
  }
  async function confirmContact() {
    await action.run(async () => {
      const r = await post("/api/account-recovery/verify-contact", {
        token: link.token,
      });
      setSession(r.recoverySession);
      await refresh(r.recoverySession);
    });
  }
  if (!link.token && !link.restore && !session) return <ResumeRecovery />;
  return (
    <>
      <PublicHeader />
      <main id="main-content" className="narrow-page">
        <span className="eyebrow">A SAFE WAY BACK</span>
        <h1>
          Your account
          <br />
          recovery case.
        </h1>
        <p>
          Confirming a safe contact address lets us communicate with you. It
          doesn’t prove account ownership or give access to encrypted history.
        </p>
        <section className="panel form-stack">
          <Alert>{action.error}</Alert>
          <Alert success>{action.notice}</Alert>
          {link.restore ? (
            complete ? (
              <>
                <Icon name="check" size={36} />
                <h2>Your login access is restored.</h2>
                <p>
                  Previous sessions and compromised credentials were
                  invalidated. Log in using your verified safe contact email and
                  new password, then review devices and integrations. Previous
                  device keys were revoked; use your saved encryption recovery
                  secret to authorize a fresh device and open old encrypted
                  content.
                </p>
                <a href="/login" className="button primary">
                  Log in securely
                </a>
              </>
            ) : (
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  action.run(async () => {
                    await post("/api/account-recovery/complete", {
                      token: link.restore,
                      newPassword: password,
                    });
                    setPassword("");
                    setComplete(true);
                  });
                }}
              >
                <h2>Choose a fresh password</h2>
                <p>
                  This link is issued only after the account recovery review. It
                  can be used once and expires. Never use a password from
                  another account.
                </p>
                <Field
                  label="New password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button variant="primary" busy={action.busy}>
                  Restore my login access
                </Button>
              </form>
            )
          ) : !session ? (
            <>
              <Icon name="mail" size={36} />
              <h2>Confirm your safe contact address.</h2>
              <p>
                Only continue if you requested this stolen-account report. The
                link expires after 30 minutes and can be used once. Confirming
                will not freeze or transfer an account.
              </p>
              <Button
                variant="primary"
                busy={action.busy}
                onClick={confirmContact}
              >
                Confirm contact & view case
              </Button>
            </>
          ) : (
            <>
              <div className="section-title">
                <h2>Your request is with us.</h2>
                <span className="mini-tag">{status?.state || "received"}</span>
              </div>
              <p>
                Case reference: <code>{status?.id}</code>
              </p>
              {status?.reason && <Alert>{status.reason}</Alert>}
              <p className="small-copy">
                Last updated{" "}
                {status?.updated_at ? localDate(status.updated_at) : "just now"}
                . Keep this case reference. You can resume later by requesting a
                fresh link at your verified safe contact address.
              </p>
              <Button
                variant="outline compact"
                busy={action.busy}
                onClick={() => action.run(() => refresh())}
              >
                Check for an update
              </Button>
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  action.run(async () => {
                    await request("/api/account-recovery/evidence", {
                      method: "POST",
                      headers: { Authorization: `Bearer ${session}` },
                      body: JSON.stringify({
                        description,
                        evidenceReference: reference || undefined,
                        appeal,
                      }),
                    });
                    setDescription("");
                    setReference("");
                    await refresh();
                  }, "Your information was added to the case for authorized reviewers.");
                }}
              >
                <h3>Anything the reviewer should know?</h3>
                <p>
                  Describe established recovery methods and when the account
                  changed. Public profile facts or a newly supplied email
                  address alone do not establish ownership.
                </p>
                <label className="field">
                  <span>Additional details</span>
                  <textarea
                    rows={5}
                    maxLength={2000}
                    required
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Never include passwords, encryption recovery secrets, access tokens, or unnecessary private content."
                  />
                </label>
                <Field
                  label="Existing case or evidence reference (optional)"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={500}
                />
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={appeal}
                    onChange={(e) => setAppeal(e.target.checked)}
                  />
                  <span>I’m appealing a recovery decision.</span>
                </label>
                <Button variant="primary" busy={action.busy}>
                  Add to my case
                </Button>
              </form>
            </>
          )}
        </section>
        <p className="small-copy">
          Support cannot decrypt your history, restore expired posts, or undo
          copies someone already saved. Recovery with all trusted methods lost
          requires two authorized reviewers.
        </p>
      </main>
      <PublicFooter />
    </>
  );
}

function ResumeRecovery() {
  const [caseId, setCaseId] = useState("");
  const [email, setEmail] = useState("");
  const action = useAction();
  return (
    <>
      <PublicHeader />
      <main id="main-content" className="narrow-page">
        <span className="eyebrow">ACCOUNT RECOVERY</span>
        <h1>
          Come back to
          <br />
          your case.
        </h1>
        <p>
          Request a fresh, single-use link at the safe contact address you
          originally verified. This does not change a recovery decision or give
          access to the account.
        </p>
        <form
          className="panel form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(async () => {
              await post("/api/account-recovery/resume", {
                caseId: caseId.trim(),
                safeEmail: email.trim(),
              });
            }, "If this case and address match, a fresh link will arrive in your safe contact inbox.");
          }}
        >
          <Field
            label="Case reference"
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
            required
            autoComplete="off"
            maxLength={100}
          />
          <Field
            label="Original safe contact email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <Alert>{action.error}</Alert>
          <Alert success>{action.notice}</Alert>
          <Button variant="primary" busy={action.busy}>
            Email a fresh case link
          </Button>
        </form>
        <p>
          Need to report a stolen account?{" "}
          <a href="/stolen-account">Start a new report.</a>
        </p>
        <a href="/login">Return to log in</a>
      </main>
      <PublicFooter />
    </>
  );
}
