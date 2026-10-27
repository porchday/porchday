import React, { useEffect, useState } from "react";
import { get, type Json } from "./api";
import { Alert, Button, Field, useAction } from "./ui";

export function groupInviteChoices(connections: Json, memberId: string, members: Json[]) {
  const existing = new Set(members.map(member => member.member_id));
  const handles = new Map<string, string>(connections.handles.map((person: Json) => [person.id, person.handle]));
  return connections.items.flatMap((connection: Json) => {
    const id = connection.member_a === memberId ? connection.member_b : connection.member_a;
    const handle = handles.get(id);
    return id !== memberId && !existing.has(id) && handle ? [{ id, handle }] : [];
  }).sort((a: { handle: string }, b: { handle: string }) => a.handle.localeCompare(b.handle));
}

export function GroupInviteForm({ memberId, members, onInvite }: {
  memberId: string;
  members: Json[];
  onInvite: (handle: string) => Promise<void>;
}) {
  const [connections, setConnections] = useState<Json | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [manual, setManual] = useState(false);
  const [selected, setSelected] = useState("");
  const [handle, setHandle] = useState("");
  const action = useAction();
  useEffect(() => {
    let active = true;
    setLoadError(false);
    setConnections(null);
    get("/connections").then(result => { if (active) setConnections(result); })
      .catch(() => { if (active) setLoadError(true); });
    const reload = () => setAttempt(value => value + 1);
    window.addEventListener("porchday:connections-changed", reload);
    return () => { active = false; window.removeEventListener("porchday:connections-changed", reload); };
  }, [memberId, attempt]);
  const choices = connections ? groupInviteChoices(connections, memberId, members) : [];
  const target = manual ? handle.trim().replace(/^@/, "") : choices.find((choice: { id: string }) => choice.id === selected)?.handle || "";
  return (
    <form className="form-stack" onSubmit={event => {
      event.preventDefault();
      if (!target || action.busy) return;
      action.run(async () => {
        await onInvite(target);
        setSelected("");
        setHandle("");
      }, "Invitation sent. Share the group details again after they join.");
    }}>
      {manual ? (
        <Field label="Invite by exact handle" value={handle} onChange={event => setHandle(event.target.value)} required />
      ) : (
        <>
          <label className="field">
            <span>Invite a connection</span>
            <select value={selected} onChange={event => setSelected(event.target.value)} required disabled={!connections || !choices.length || action.busy}>
              <option value="">{!connections && !loadError ? "Loading connections…" : "Choose a connection"}</option>
              {choices.map((choice: { id: string; handle: string }) => <option key={choice.id} value={choice.id}>@{choice.handle}</option>)}
            </select>
          </label>
          {connections && !choices.length && <p>No connections available to invite. People already in this group are excluded.</p>}
          {loadError && <div><Alert>Couldn’t load your connections.</Alert><Button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div>}
        </>
      )}
      <div className="inline-form">
        <Button variant="primary compact" busy={action.busy} disabled={!target}>Invite</Button>
        <Button type="button" variant="outline compact" disabled={action.busy} onClick={() => setManual(value => !value)}>
          {manual ? "Choose from connections" : "Use an exact handle instead"}
        </Button>
      </div>
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
    </form>
  );
}
