import React, { useEffect, useRef, useState } from "react";
import { decryptObject, type EncryptedEnvelope } from "@porchday/crypto";
import { ApiError, get, post, del, items, localDate, type Json } from "./api";
import { Alert, Button, Empty, Field, Icon, Loading, Logo, useAction } from "./ui";
import { useOptionalVault, Fingerprint } from "./vault";
type StaffIdentity = { subject: string; email: string; roles: ("recovery" | "moderation")[] };

export function StaffEntry() {
  const [identity, setIdentity] = useState<StaffIdentity | null>(null);
  const action = useAction();
  async function refresh() {
    setIdentity(null);
    const value = await get<StaffIdentity>("/api/staff/identity");
    if (!value || typeof value.subject !== "string" || typeof value.email !== "string" ||
        !Array.isArray(value.roles) || value.roles.some(role => !["recovery", "moderation"].includes(role)))
      throw new Error("Staff sign-in could not be verified. Reload this page to sign in again.");
    setIdentity(value);
  }
  useEffect(() => { action.run(refresh); }, []);
  return <main id="main-content" className="narrow-page">
    <Logo />
    <section className="panel form-stack">
      <h1>Porchday staff</h1>
      <Alert>{action.error}</Alert>
      {!identity ? <>
        {action.busy ? <Loading /> : <p>Sign in through Cloudflare Access with your staff email and personal MFA device.</p>}
        <Button variant="outline" busy={action.busy} onClick={() => action.run(refresh)}>Check staff access</Button>
      </> : <>
        <p>Signed in as <strong>{identity.email}</strong>.</p>
        {!identity.roles.length && <>
          <p>Your sign-in is verified. An operator must authorize your staff role before you can review cases.</p>
          <p>Give the operator this account reference: <code>{identity.subject}</code>. This reference grants no access; never share a sign-in code or session token.</p>
        </>}
        <Button variant="outline" busy={action.busy} onClick={() => action.run(refresh)}>Check staff access</Button>
        <Button variant="outline" onClick={() => window.location.assign("/cdn-cgi/access/logout")}>Sign out of staff access</Button>
      </>}
    </section>
    {!!identity?.roles.length && <StaffConsole roles={identity.roles} onAccessLost={() => setIdentity(null)} />}
  </main>;
}

export function StaffConsole({ roles, initialTab, onAccessLost }: { roles?: StaffIdentity["roles"]; initialTab?: string; onAccessLost?: () => void } = {}) {
  const vault = useOptionalVault();
  const availableTabs = [["recovery", "Account recovery"], ["moderation", "Community reports"]]
    .filter(([role]) => !roles || roles.includes(role as StaffIdentity["roles"][number]));
  const [tab, setTab] = useState(initialTab || availableTabs[0]?.[0] || "recovery");
  const [rows, setRows] = useState<Json[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Json | null>(null);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [decision, setDecision] = useState("hold");
  const [evidence, setEvidence] = useState<Json | null>(null);
  const [keys, setKeys] = useState<Json[]>([]);
  const generation = useRef(0);
  const action = useAction();
  const base =
    tab === "recovery"
      ? "/api/staff/recovery/cases"
      : "/api/staff/moderation/reports";
  async function staffRequest<T,>(operation: () => Promise<T>): Promise<T> {
    const started = generation.current;
    try {
      const result = await operation();
      if (started !== generation.current) throw new Error("The staff view changed. Refresh to continue.");
      return result;
    } catch (error) {
      if (started === generation.current && error instanceof ApiError && [401, 403].includes(error.status)) {
        generation.current++;
        setRows(null); setCursor(null); setSelected(null); setEvidence(null); setKeys([]);
        setReason(""); setReference("");
        onAccessLost?.();
      }
      throw error;
    }
  }
  const staffGet = (path: string) => staffRequest(() => get(path));
  const staffPost = (path: string, data: unknown) => staffRequest(() => post(path, data));
  const staffDelete = (path: string) => staffRequest(() => del(path));
  async function refresh(more = false) {
    generation.current++;
    const query = new URLSearchParams({
      ...(filter ? { state: filter } : {}),
      ...(more && cursor ? { cursor } : {}),
    });
    const data = await staffGet(base + (query.size ? "?" + query : ""));
    const next: Json[] = data.cases || items(data);
    setRows((old) =>
      more
        ? [
            ...(old || []),
            ...next.filter(
              (row) => !old?.some((existing) => existing.id === row.id),
            ),
          ]
        : next,
    );
    setCursor(data.next_cursor || null);
    if (tab === "moderation" && !more)
      setKeys(items(await staffGet("/api/staff/moderation/keys")));
  }
  useEffect(() => {
    setSelected(null);
    setEvidence(null);
    setRows(null);
    action.run(() => refresh());
    return () => { generation.current++; };
  }, [tab, filter]);
  async function open(row: Json) {
    generation.current++;
    setSelected(null);
    setEvidence(null);
    await action.run(async () => {
      setSelected(await staffGet(`${base}/${row.id}`));
      setEvidence(null);
      setReason("");
      setReference("");
      setDecision(tab === "recovery" ? "hold" : "review");
    });
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    await action.run(async () => {
      if (tab === "recovery")
        await staffPost(`${base}/${selected.id}/review`, {
          decision,
          evidenceReference: reference,
          reason,
        });
      else
        await staffPost(`${base}/${selected.id}/actions`, {
          action: decision,
          reason_code: reason
            .toLowerCase()
            .replace(/[^a-z_]/g, "_")
            .slice(0, 60),
        });
      setSelected(await staffGet(`${base}/${selected.id}`));
      await refresh();
    }, "The review was recorded. Recovery transfers require approval from two distinct authorized reviewers.");
  }
  async function openEvidence() {
    if (!selected?.evidence_envelope) return;
    const started = generation.current;
    await action.run(async () => {
      if (!vault) throw new Error("Open the trusted-device staff view and unlock your encryption keys to read disclosed evidence.");
      const envelope = selected.evidence_envelope as EncryptedEnvelope;
      const author = await staffGet(`${base}/${selected.id}/author-key`);
      const key = vault.keys.find((k) =>
        envelope.recipients.some((r) => r.fingerprint === k.getFingerprint()),
      );
      if (!key)
        throw new Error(
          "This report was not encrypted for this trusted device. Use the original authorized moderation device.",
        );
      const content = await decryptObject<Json>({
        envelope,
        expectedContext: envelope.context,
        privateKey: key,
        authorPublicKey: author.public_key,
      });
      if (started === generation.current) setEvidence(content);
    });
  }
  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">AUTHORIZED HUMAN REVIEW</span>
        <h1>Care for the circle.</h1>
        <p>
          Staff access is role-limited and audited. Being staff never grants
          access to private walls.
        </p>
      </div>
      <nav className="settings-tabs" aria-label="Staff queues">
        {availableTabs.map(([id, label]) => (
          <button
            className={`text-button ${tab === id ? "active" : ""}`}
            key={id}
            onClick={() => {
              setTab(id);
              setFilter("");
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
      {tab === "moderation" && !vault && <section className="panel">
        <h2>Disclosed evidence</h2>
        <p>Reading encrypted report evidence or registering a moderation device requires your separate Porchday account and trusted encryption keys.</p>
        <a className="button outline" href="/staff/moderation">Open trusted-device staff view</a>
      </section>}
      {tab === "moderation" && vault && (
        <section className="panel">
          <h2>Report evidence keys</h2>
          <p>
            Register this trusted device to receive evidence members explicitly
            disclose in future reports. Existing reports cannot be decrypted by
            adding a new key.
          </p>
          <Fingerprint device={vault.device} />
          {keys.map((k) => (
            <div className="list-row" key={k.id}>
              <span>
                {k.id === vault.device.id ? "This device" : k.id}
                <small>{k.revoked_at ? "Revoked" : "Active"}</small>
              </span>
              {!k.revoked_at && (
                <Button
                  variant="outline compact"
                  busy={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await staffDelete(`/api/staff/moderation/keys/${k.id}`);
                      await refresh();
                    })
                  }
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
          <Button
            variant="outline"
            busy={action.busy}
            onClick={() =>
              action.run(async () => {
                await staffPost("/api/staff/moderation/keys", {
                  id: vault.device.id,
                  member_id: vault.member.id,
                  public_key: vault.device.public_key,
                  fingerprint: vault.device.fingerprint,
                });
                await refresh();
              }, "This trusted device can receive future, explicitly disclosed reports.")
            }
          >
            Register this device for report evidence
          </Button>
        </section>
      )}
      <section className="panel">
        <div className="section-title">
          <h2>{tab === "recovery" ? "Recovery cases" : "Community reports"}</h2>
          <Button
            variant="quiet compact"
            onClick={() => action.run(() => refresh())}
          >
            Refresh
          </Button>
        </div>
        {
          <label className="field">
            <span>{tab === "moderation" ? "Report state" : "Case state"}</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All states</option>
              {(tab === "moderation"
                ? ["received", "reviewing", "resolved", "appealed"]
                : ["submitted", "reviewing", "hold", "restored", "denied"]
              ).map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </label>
        }
        {rows === null ? (
          action.busy ? (
            <Loading />
          ) : (
            <p>
              Staff access is required. Sign in through the operator’s
              Cloudflare Access application with an authorized staff role.
            </p>
          )
        ) : !rows.length ? (
          <Empty icon="shield" title="Nothing waiting here.">
            This queue contains no available cases.
          </Empty>
        ) : (
          rows.map((row) => (
            <button
              className="notification-row"
              key={row.id}
              onClick={() => open(row)}
            >
              <span className="feature-icon sage">
                <Icon name="shield" />
              </span>
              <span>
                <strong>
                  {tab === "recovery"
                    ? "Account recovery case"
                    : `${row.reason} report`}
                </strong>
                <small>
                  {row.id} · {localDate(row.created_at)}
                </small>
              </span>
              <span className="mini-tag">{row.state || row.status}</span>
            </button>
          ))
        )}
        {cursor && (
          <Button
            variant="outline full"
            busy={action.busy}
            onClick={() => action.run(() => refresh(true))}
          >
            Load more cases
          </Button>
        )}
      </section>
      {selected && (
        <section className="panel form-stack">
          <h2>Review case {String(selected.id).slice(0, 8)}</h2>
          <p>
            Status: <strong>{selected.state || selected.status}</strong>
          </p>
          {tab === "recovery" ? (
            <>
              <dl className="case-details">
                <dt>Account reference</dt>
                <dd>{selected.account_reference}</dd>
                <dt>Safe contact</dt>
                <dd>{selected.safe_email}</dd>
                <dt>Contact verified</dt>
                <dd>
                  {selected.contact_verified_at
                    ? "Yes — communication only, not ownership proof"
                    : "Not verified"}
                </dd>
                <dt>Member’s description</dt>
                <dd>{selected.description || "No description recorded."}</dd>
                <dt>Prior methods</dt>
                <dd>{selected.trusted_method || "Not stated"}</dd>
              </dl>
              {(selected.evidence || []).map((e: Json) => (
                <blockquote className="report-preview" key={e.id}>
                  <p>{e.description}</p>
                  <small>
                    {e.evidence_reference || "No external reference"}
                    {e.appeal ? " · Appeal" : ""}
                  </small>
                </blockquote>
              ))}
              <p>
                Do not infer ownership from public profile facts, a matching
                email string, or control of a newly supplied safe address.
                Corroborate established methods and security history. A hold
                stops extraction and destructive actions, while existing timers
                keep running.
              </p>
              {selected.reviews?.length > 0 && (
                <div className="report-preview">
                  <strong>Recorded reviewer decisions</strong>
                  {selected.reviews.map((r: Json, i: number) => (
                    <p key={r.id || i}>
                      {r.decision} ·{" "}
                      {r.reason || r.evidence_reference || r.reviewed_at}
                    </p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <p>
                Category: {selected.reason}. Target reference:{" "}
                {selected.target_id || selected.target_member || "Not provided"}
                .
              </p>
              {selected.evidence_disclosed && selected.evidence_envelope ? (
                <>
                  <Button
                    variant="outline"
                    busy={action.busy}
                    disabled={!vault}
                    onClick={openEvidence}
                  >
                    Open explicitly disclosed evidence
                  </Button>
                  {evidence && (
                    <div className="report-preview">
                      <strong>Disclosed content</strong>
                      <blockquote>
                        {String(evidence.selectedText || "")}
                      </blockquote>
                      <p>{String(evidence.description || "")}</p>
                      <small>
                        No undisclosed photos or private conversations are
                        included.
                      </small>
                    </div>
                  )}
                </>
              ) : (
                <p>
                  The member did not disclose private content. Review only the
                  report and necessary behavioral metadata.
                </p>
              )}
            </>
          )}
          <form className="form-stack" onSubmit={submit}>
            <label className="field">
              <span>Review action</span>
              <select
                value={decision}
                onChange={(e) => setDecision(e.target.value)}
              >
                {(tab === "recovery"
                  ? [
                      ["hold", "Apply corroborated security hold"],
                      [
                        "restore",
                        "Approve restoration (two reviewers required)",
                      ],
                      ["deny", "Decline unsupported claim"],
                    ]
                  : [
                      ["review", "Mark under review"],
                      ["resolve", "Resolve report"],
                      ["restrict", "Restrict social actions"],
                      ["suspend", "Suspend account"],
                      ["restore", "Restore permitted access"],
                      ["remove_content", "Remove reported content"],
                    ]
                ).map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {tab === "recovery" && (
              <Field
                label="Corroborating evidence reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                required
                minLength={10}
                maxLength={500}
                help="Use a secure evidence reference. Do not paste passwords, recovery secrets, or unnecessary private data."
              />
            )}
            <Field
              label={
                tab === "recovery"
                  ? "Reason for this decision"
                  : "Reason code (letters and underscores)"
              }
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={tab === "recovery" ? 10 : 3}
              maxLength={tab === "recovery" ? 1000 : 60}
            />
            <Button variant="primary" busy={action.busy}>
              Record review decision
            </Button>
          </form>
        </section>
      )}
    </>
  );
}
