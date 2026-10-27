import React, { useEffect, useState } from "react";
import { get, localDate, type Json } from "./api";
import { Alert, Button, Empty, Loading, useAction } from "./ui";

/** Read-only operator view for the builder_chat staff role. Changes to the
 * allowlist and pause are made with scripts/builder-chat-access.ts and
 * infra/resources.json, never from this page. */
export function StaffBuilderChat() {
  const [view, setView] = useState<Json | null>(null);
  const action = useAction();
  const refresh = async () => setView(await get("/api/staff/builder-chat"));
  useEffect(() => {
    action.run(refresh);
  }, []);
  const seen = view?.bridge_seen_at ? Date.parse(view.bridge_seen_at) : 0;
  return (
    <section className="panel staff-builder-chat">
      <h2>Builder chat</h2>
      <Alert>{action.error}</Alert>
      {!view ? (
        <Loading />
      ) : (
        <>
          <p>
            {view.paused ? "Paused." : "Open."} Bridge{" "}
            {seen && Date.now() - seen < 30_000 ? "connected" : seen ? "last seen " + localDate(view.bridge_seen_at) : "never connected"}.{" "}
            {view.access.length} allowlisted {view.access.length === 1 ? "member" : "members"}:{" "}
            {view.access.map((a: Json) => "@" + a.handle).join(", ") || "none"}.
          </p>
          <Button variant="outline compact" busy={action.busy} onClick={() => action.run(refresh)}>
            Refresh
          </Button>
          <h3>Messages</h3>
          {view.messages.length ? (
            <table>
              <thead>
                <tr>
                  <th scope="col">Sent</th>
                  <th scope="col">Member</th>
                  <th scope="col">Status</th>
                  <th scope="col">Message and reply</th>
                  <th scope="col">Message ID and commits</th>
                </tr>
              </thead>
              <tbody>
                {view.messages.map((m: Json) => (
                  <tr key={m.id}>
                    <td>{localDate(m.created_at)}</td>
                    <td>@{m.handle}</td>
                    <td>{String(m.status).replace("_", " ")}</td>
                    <td>
                      <p className="staff-builder-text">{m.body}</p>
                      {m.reply && <p className="staff-builder-text muted">{m.reply}</p>}
                    </td>
                    <td>
                      <code>{m.id}</code>
                      {m.commits.map((hash: string) => (
                        <div key={hash}>
                          <code>{hash}</code>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty icon="comment" title="No builder chat messages">
              Messages appear here after an allowlisted member sends one.
            </Empty>
          )}
          <h3>Audit log</h3>
          <ul className="staff-builder-audit">
            {view.audit.map((entry: Json) => (
              <li key={entry.id}>
                {localDate(entry.created_at)} · {entry.event.replace("_", " ")}
                {entry.handle ? " · @" + entry.handle : ""}
                {entry.message_id ? " · " + entry.message_id : ""}
                {Object.keys(entry.detail || {}).length ? " · " + JSON.stringify(entry.detail) : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
