import React, { useEffect, useRef, useState } from "react";
import { ApiError, post, request, localDate, accessLost } from "./api";
import { Alert, Button, Field } from "./ui";

type Invitation = { id: string; email: string; requested_at: string; expires_at: string; status: "pending" | "joined" | "expired" };
const statusLabels = { pending: "Pending", joined: "Joined", expired: "Expired" };

export function PlatformInvitation({ canInvite }: { canInvite: boolean }) {
  const [email, setEmail] = useState("");
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
        "/platform-invitations" + (more && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), { signal: controller.signal });
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
      const result = await post("/platform-invitations", { email: email.trim() });
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

  return (
    <section className="panel">
      <h2>Invite someone</h2>
      <p>Invite someone who does not have a Porchday account. Invitations expire after seven days.</p>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Their email address" type="email" autoComplete="off"
          autoCapitalize="none" spellCheck={false} value={email}
          onChange={event => setEmail(event.target.value)} maxLength={254}
          disabled={busy || !canInvite} required />
        <Button variant="primary compact" type="submit" busy={busy} disabled={!canInvite}>
          Send invitation
        </Button>
        <Alert>{error}</Alert>
        <Alert success>{notice}</Alert>
      </form>
      <p className="small-copy">Up to 10 requests every 24 hours. Joining does not automatically connect your accounts.</p>
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
                {invitation.status === "pending" && <small>Expires {localDate(invitation.expires_at)}</small>}
              </div>
              <span className={`invitation-status ${invitation.status}`}>{statusLabels[invitation.status]}</span>
            </li>)}
          </ul>
        )}
        {cursor && <Button variant="quiet compact" type="button" busy={listBusy} onClick={() => void load(true)}>Load more invitations</Button>}
      </div>
    </section>
  );
}
