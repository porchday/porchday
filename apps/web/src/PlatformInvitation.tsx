import React, { useRef, useState } from "react";
import { ApiError, post } from "./api";
import { Alert, Button, Field } from "./ui";

export function PlatformInvitation({ canInvite }: { canInvite: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current || !canInvite) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await post("/platform-invitations", { email: email.trim() });
      if (result.accepted !== true) throw new Error("UNCONFIRMED");
      setEmail("");
      setNotice("Invitation requested. If the address is eligible, Porchday will email a signup link and code.");
    } catch (failure) {
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
      setBusy(false);
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
    </section>
  );
}
