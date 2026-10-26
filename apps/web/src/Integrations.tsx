import React, { useEffect, useState } from "react";
import { get, post, localDate, type Json } from "./api";
import { Alert, Button, Icon, Loading, useAction } from "./ui";
export const scopeLabels: Record<string, string> = {
  "emoji:read": "Your encrypted personal custom emoji collection",
  "profile:read": "Your encrypted profile and public handle",
  "content:read": "Your own encrypted posts, comments, and reactions",
  "media:read": "Your own encrypted photos and their routing metadata",
  "export:read": "Your own export job status",
};
export function IntegrationGrantDetails({ grant }: { grant: Json }) {
  return <div className="member-info">
    <strong>{grant.name || grant.client_name}</strong>
    <p>{grant.purpose}</p>
    <small>
      {grant.scopes?.join(", ")} · {grant.last_used_at ? localDate(grant.last_used_at) : "Not used yet"}
      {grant.revoked_at ? " · Revoked" : ""}
    </small>
  </div>;
}
export function IntegrationConsent() {
  const [client, setClient] = useState<Json | null>(null);
  const action = useAction();
  const q = new URLSearchParams(location.search);
  const scopes = (q.get("scope") || "").split(/\s+/).filter(Boolean);
  useEffect(() => {
    action.run(async () => {
      const result = await get(
        `/integrations/clients/${encodeURIComponent(q.get("client_id") || "")}`,
      );
      if (result.redirect_uri !== q.get("redirect_uri"))
        throw new Error(
          "This request does not match the app’s registered return address.",
        );
      if (
        !scopes.length ||
        scopes.some((s) => !scopeLabels[s]) ||
        q.get("code_challenge_method") !== "S256" ||
        !q.get("state") ||
        !q.get("code_challenge")
      )
        throw new Error("This app sent an unsupported authorization request.");
      setClient(result);
    });
  }, []);
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">DATA ACCESS</span>
        <h1>Connect a tool?</h1>
        <p>You decide exactly what an integration may access.</p>
      </div>
      <section className="panel form-stack">
        <Alert>{action.error}</Alert>
        {client ? (
          <>
            <span className="feature-icon sage">
              <Icon name="external" size={26} />
            </span>
            <h2>{client.name}</h2>
            <p>{client.purpose}</p>
            <div className="report-preview">
              <strong>This app is requesting:</strong>
              <ul>
                {scopes.map((s) => (
                  <li key={s}>{scopeLabels[s]}</li>
                ))}
              </ul>
            </div>
            <p>
              Access is limited to your own ciphertext and necessary metadata.
              This does not share encryption keys, your friends’ feed, or
              permission to publish posts, comments, or reactions. Grants expire
              after 30 days and can be revoked anytime in My data.
            </p>
            <p className="small-copy">
              Return address:{" "}
              <strong>{new URL(client.redirect_uri).origin}</strong>. Revoking
              access stops future requests; it cannot recall copies already
              received.
            </p>
            <div className="button-row">
              <Button
                variant="primary"
                busy={action.busy}
                onClick={() =>
                  action.run(async () => {
                    const r = await post("/integrations/authorize", {
                      client_id: q.get("client_id"),
                      redirect_uri: client.redirect_uri,
                      scope: scopes,
                      code_challenge: q.get("code_challenge"),
                      code_challenge_method: "S256",
                      state: q.get("state"),
                      consent: true,
                    });
                    const redirect = new URL(r.redirect_uri);
                    const registered = new URL(client.redirect_uri);
                    if (
                      redirect.origin !== registered.origin ||
                      redirect.pathname !== registered.pathname
                    )
                      throw new Error("The return address did not match.");
                    location.assign(redirect.href);
                  })
                }
              >
                Allow selected access
              </Button>
              <a href="/app/settings/data" className="button quiet">
                Cancel
              </a>
            </div>
          </>
        ) : action.busy ? (
          <Loading text="Checking this app’s request…" />
        ) : (
          <a href="/app/settings/data" className="button outline">
            Back to My data
          </a>
        )}
      </section>
    </>
  );
}
export function RegisterIntegration() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [redirect, setRedirect] = useState("");
  const [created, setCreated] = useState("");
  const action = useAction();
  return (
    <div className="form-stack">
      <button className="text-button" onClick={() => setOpen(!open)}>
        Register a tool you’re building
      </button>
      {open && (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(async () => {
              const result = await post("/integrations/clients", {
                name,
                purpose,
                redirect_uri: redirect,
              });
              setCreated(result.id);
            }, "App registered. Use authorization code with PKCE S256 and explicit member consent.");
          }}
        >
          <p className="small-copy">
            For member-authorized data transport tools. Autonomous social
            actions and AI member agents are not permitted.
          </p>
          <label className="field">
            <span>App name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label className="field">
            <span>Purpose</span>
            <input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              required
              maxLength={500}
            />
          </label>
          <label className="field">
            <span>Exact HTTPS return URL</span>
            <input
              type="url"
              value={redirect}
              onChange={(e) => setRedirect(e.target.value)}
              required
            />
          </label>
          <Button variant="outline" busy={action.busy}>
            Register integration
          </Button>
          {created && (
            <p>
              Client ID: <code>{created}</code>
            </p>
          )}
          <Alert>{action.error}</Alert>
          <Alert success>{action.notice}</Alert>
        </form>
      )}
    </div>
  );
}
