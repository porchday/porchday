import React, { useEffect, useRef, useState } from "react";
import { ApiError, post, request, localDate, accessLost } from "./api";
import { Alert, Button, Field } from "./ui";

type Invitation = { id: string; email: string; requested_at: string; expires_at: string; status: "pending" | "joined" | "expired" | "revoked"; kind: "friend" | "family" | null };
const statusLabels = { pending: "Pending", joined: "Joined", expired: "Expired", revoked: "Revoked" };

export function PlatformInvitation({ canInvite }: { canInvite: boolean }) {
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<"friend" | "family">("friend");
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState("");
  const reading = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  async function load(more = false) {
    reading.current?.abort();
    const controller = new AbortController(); reading.current = controller;
    setListBusy(true); setListError("");
    try {
      const result = await request<{ items: Invitation[]; next_cursor: string | null }>(
        "/platform-invitations?v=2" + (more && cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setInvitations(previous => more ? [...(previous || []), ...result.items.filter(item => !previous?.some(old => old.id === item.id))] : result.items);
      setCursor(result.next_cursor);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        if (accessLost(failure)) { setInvitations(null); setCursor(null); }
        setListError("Could not load your invitations. Try again.");
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) setListBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true; void load();
    const refresh = () => { if (document.visibilityState !== "hidden") void load(); };
    window.addEventListener("focus", refresh);
    async function revoke(invitation: Invitation) {
    if (revoking) return;
    setRevoking(invitation.id); setListError("");
    try {
      await post(`/platform-invitations/${invitation.id}/revoke`);
      if (mounted.current) { setNotice("Invitation revoked. It will no longer create a connection."); await load(); }
    } catch (failure) {
      if (mounted.current) setListError(failure instanceof ApiError && failure.code === "ALREADY_JOINED"
        ? "They have already joined. Manage your connection separately."
        : "Could not confirm revocation. Refresh invitations before trying again.");
    } finally { if (mounted.current) setRevoking(null); }
  }

  return () => { mounted.current = false; reading.current?.abort(); window.removeEventListener("focus", refresh); };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current || !canInvite) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await post("/platform-invitations", { email: email.trim(), kind });
      if (!mounted.current) return;
      if (result.accepted !== true) throw new Error("UNCONFIRMED");
      setEmail("");
      setNotice("Invitation requested. If the address is eligible, Porchday will email a signup link and code.");
      void load();
    } catch (failure) {
      if (!mounted.current) return;
      const errors: Record<string, string> = {
        INVALID_EMAIL: "Enter a valid email address.",
        INVITATION_LIMIT: "You have reached the limit of 10 invitations in 24 hours. Try again later.",
        PILOT_CLOSED: "New account invitations are currently closed.",
        INVITATIONS_PAUSED: "Invitations are temporarily paused.",
        ACCOUNT_UNAVAILABLE: "This account cannot send invitations right now.",
      };
      setError(failure instanceof ApiError && errors[failure.code]
        ? errors[failure.code]
        : "We could not confirm the request. It may have been accepted; check with the recipient before trying again.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function revoke(invitation: Invitation) {
    if (revoking) return;
    setRevoking(invitation.id); setListError("");
    try {
      await post(`/platform-invitations/${invitation.id}/revoke`);
      if (mounted.current) { setNotice("Invitation revoked. It will no longer create a connection."); await load(); }
    } catch (failure) {
      if (mounted.current) setListError(failure instanceof ApiError && failure.code === "ALREADY_JOINED"
        ? "They have already joined. Manage your connection separately."
        : "Could not confirm revocation. Refresh invitations before trying again.");
    } finally { if (mounted.current) setRevoking(null); }
  }

  return (
    <section className="panel">
      <h2>Invite someone</h2>
      <p>Invite someone who does not have a Porchday account. Invitations expire after seven days.</p>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Their email address" type="email" autoComplete="off"
          autoCapitalize="none" spellCheck={false} value={email}
          onChange={event => setEmail(event.target.value)} maxLength={254}
          disabled={busy || !canInvite} required />
        <label>Connect as
          <select value={kind} onChange={event => setKind(event.target.value as "friend" | "family")} disabled={busy || !canInvite}>
            <option value="friend">Friend</option><option value="family">Family</option>
          </select>
        </label>
        <p>When they accept and verify their email, you will automatically connect as {kind === "family" ? "Family" : "Friends"}. You will share future posts for that audience. Each of you can change your own label or disconnect later.</p>
        <Button variant="primary compact" type="submit" busy={busy} disabled={!canInvite}>
          Send invitation
        </Button>
        <Alert>{error}</Alert>
        <Alert success>{notice}</Alert>
      </form>
      <p className="small-copy">Up to 10 requests every 24 hours. You can revoke a pending invitation before they verify their account.</p>
      {!canInvite && <p>This account cannot send invitations right now.</p>}
      <div className="invitation-history">
        <div className="invitation-history-heading">
          <h3>Invitations</h3>
          <Button variant="quiet compact" type="button" busy={listBusy} onClick={() => void load()}>Refresh</Button>
        </div>
        <p className="small-copy">Last 90 days. Joined means they verified an account using your invitation.</p>
        <Alert>{listError}</Alert>
        {invitations === null ? (
          !listError && <p role="status">Loading invitations…</p>
        ) : invitations.length === 0 ? <p>No invitations yet.</p> : (
          <ul className="invitation-list" aria-label="Your platform invitations">
            {invitations.map(invitation => <li key={invitation.id}>
              <div className="invitation-recipient"><strong>{invitation.email}</strong>
                <small>Requested {localDate(invitation.requested_at)}</small>
                {invitation.kind && <small>Connect as {invitation.kind === "family" ? "Family" : "Friend"}</small>}
                {invitation.status === "pending" && <small>Expires {localDate(invitation.expires_at)}</small>}
              </div>
              <span className={`invitation-status ${invitation.status}`}>{statusLabels[invitation.status]}</span>
              {invitation.status === "pending" && <Button variant="quiet compact" type="button" busy={revoking === invitation.id} disabled={revoking !== null} onClick={() => void revoke(invitation)}>Revoke invitation</Button>}
            </li>)}
          </ul>
        )}
        {cursor && <Button variant="quiet compact" type="button" busy={listBusy} onClick={() => void load(true)}>Load more invitations</Button>}
      </div>
    </section>
  );
}
