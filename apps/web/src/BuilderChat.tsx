import React, { useEffect, useRef, useState } from "react";
import { ApiError, get, post, localDate, saveFile } from "./api";
import { Alert, Button, Empty, Icon, Loading, useAction } from "./ui";

/** See design/builder-chat.md. Only allowlisted members can load this page. */
export type BuilderMessage = {
  id: string;
  body: string;
  status: "queued" | "working" | "answered" | "timed_out" | "failed";
  progress: "reading" | "editing" | "testing" | "committing" | "working" | null;
  reply: string;
  commits: string[];
  created_at: string;
  completed_at: string | null;
};
export type BuilderState = {
  paused: boolean;
  online: boolean;
  disclosure: { version: number; accepted: boolean };
  ahead: number;
  sent_today: number;
  limits: { message_length: number; daily_messages: number };
  messages: BuilderMessage[];
};

const progressText: Record<NonNullable<BuilderMessage["progress"]>, string> = {
  reading: "Codex is reading files.",
  editing: "Codex is editing files.",
  testing: "Codex is running tests.",
  committing: "Codex is committing a change.",
  working: "Codex is working.",
};

export function builderStatus(state: BuilderState): string {
  const pending = state.messages.find((m) => m.status === "queued" || m.status === "working");
  if (pending?.status === "working") return progressText[pending.progress || "working"];
  if (state.paused) return "Builder chat is paused by the Porchday team.";
  if (pending && !state.online) return "Codex is offline right now. Your message will be answered when Codex is back.";
  if (pending)
    return state.ahead > 0
      ? `Waiting for Codex. ${state.ahead} ${state.ahead === 1 ? "message" : "messages"} ahead of yours.`
      : "Waiting for Codex to start.";
  return state.online
    ? "Codex is online."
    : "Codex is offline right now. You can send a message and it will be answered when Codex is back.";
}

/** Shows the navigation item only to allowlisted members; any error hides it. */
export async function builderChatAvailable(): Promise<boolean> {
  try {
    await get("/builder-chat");
    return true;
  } catch {
    return false;
  }
}

export function Disclosure({ version, onAccepted }: { version: number; onAccepted: () => Promise<void> }) {
  const [agreed, setAgreed] = useState(false);
  const action = useAction();
  return (
    <section className="panel builder-disclosure">
      <h2>Before you start</h2>
      <ul>
        <li>
          Your messages go to an AI coding agent (OpenAI Codex) that builds Porchday, running on a computer operated by a
          Porchday maintainer.
        </li>
        <li>
          Porchday’s operators can read everything you send and everything Codex replies. Builder chat is not encrypted
          on your device the way your posts are.
        </li>
        <li>Codex may change Porchday because of what you write, and changes can reach every member within about an hour.</li>
        <li>Don’t share passwords, recovery codes, private posts or anything about another person.</li>
        <li>Your messages are kept for 90 days and are deleted when you delete your account.</li>
      </ul>
      <Alert>{action.error}</Alert>
      <label className="check-field">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>I understand how builder chat works.</span>
      </label>
      <Button
        variant="primary"
        disabled={!agreed}
        busy={action.busy}
        onClick={() =>
          action.run(async () => {
            await post("/builder-chat/disclosure", { version });
            await onAccepted();
          })
        }
      >
        Continue
      </Button>
    </section>
  );
}

export function Exchange({ message }: { message: BuilderMessage }) {
  const outcome =
    message.status === "timed_out"
      ? "Codex ran out of time on this request."
      : message.status === "failed"
        ? "This message was not answered."
        : "";
  return (
    <li className="builder-exchange">
      <div className="builder-bubble mine">
        <small>You · {localDate(message.created_at)}</small>
        <p>{message.body}</p>
      </div>
      {(message.reply || message.status === "working" || outcome) && (
        <div className="builder-bubble codex" aria-busy={message.status === "working" || undefined}>
          <small>Codex{message.completed_at ? " · " + localDate(message.completed_at) : ""}</small>
          {message.reply && <p>{message.reply}</p>}
          {message.status === "working" && <p className="builder-progress">{progressText[message.progress || "working"]}</p>}
          {outcome && !message.reply.includes(outcome) && <p className="builder-progress">{outcome}</p>}
          {message.commits.length > 0 && (
            <p className="builder-commits">
              Committed{" "}
              {message.commits.map((hash, index) => (
                <React.Fragment key={hash}>
                  {index > 0 && ", "}
                  <a href={`https://github.com/porchday/porchday/commit/${hash}`} rel="noreferrer" target="_blank">
                    {hash.slice(0, 7)}
                  </a>
                </React.Fragment>
              ))}
              . Changes usually reach Porchday within about an hour.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function BuilderChat() {
  const [state, setState] = useState<BuilderState | null>(null);
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const action = useAction();
  const previous = useRef<{ status: string; id: string } | null>(null);

  async function refresh() {
    try {
      const next = await get<BuilderState>("/builder-chat");
      setState(next);
      // Announce state changes, not every streamed word.
      const latest = next.messages.at(-1);
      const key = latest ? { id: latest.id, status: latest.status + (latest.progress || "") } : null;
      if (previous.current && key && (previous.current.id !== key.id || previous.current.status !== key.status)) {
        setAnnouncement(latest!.status === "answered" ? "Codex replied: " + latest!.reply : builderStatus(next));
      }
      previous.current = key;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setMissing(true);
      else throw error;
    }
  }
  useEffect(() => {
    action.run(refresh);
  }, []);
  const pending = state?.messages.some((m) => m.status === "queued" || m.status === "working") ?? false;
  useEffect(() => {
    if (!state || missing) return;
    // Poll quickly only while a reply is on its way, and never in a hidden tab.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh().catch(() => {});
    }, pending ? 2000 : 15000);
    return () => clearInterval(timer);
  }, [pending, missing, state === null]);

  if (missing)
    return (
      <Empty title="Page not found" action={<a className="button primary" href="/app">Go Home</a>}>
        This page is unavailable.
      </Empty>
    );
  if (!state) return action.error ? <Alert>{action.error}</Alert> : <Loading />;
  const remaining = state.limits.message_length - text.length;
  const blocked = pending || state.paused || state.sent_today >= state.limits.daily_messages;
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim() || blocked) return;
    await action.run(async () => {
      await post("/builder-chat/messages", { message: text });
      setText("");
      await refresh();
    });
  }
  return (
    <>
      <div className="page-heading">
        <h1>Builder chat</h1>
      </div>
      <p className="builder-intro">
        Talk with Codex, the AI agent that builds Porchday. Ask what is being built, report a problem, or suggest a change.
      </p>
      {!state.disclosure.accepted ? (
        <Disclosure version={state.disclosure.version} onAccepted={refresh} />
      ) : (
        <section className="panel builder-chat">
          <p className={`builder-status ${state.online && !state.paused ? "online" : ""}`}>
            <Icon name={state.paused ? "lock" : "comment"} size={16} />
            {builderStatus(state)}
          </p>
          <div className="sr-only builder-announcement" role="status" aria-live="polite">
            {announcement}
          </div>
          {state.messages.length ? (
            <ol className="builder-thread" aria-label="Your builder chat messages">
              {state.messages.map((m) => (
                <Exchange key={m.id} message={m} />
              ))}
            </ol>
          ) : (
            <Empty icon="comment" title="No messages yet">
              Your conversation with Codex will appear here.
            </Empty>
          )}
          <Alert>{action.error}</Alert>
          <form className="builder-form" onSubmit={send} data-unsaved-draft={Boolean(text.trim()) || undefined}>
            <label htmlFor="builder-message">Message to Codex</label>
            <textarea
              id="builder-message"
              rows={4}
              maxLength={state.limits.message_length}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-describedby="builder-message-help"
            />
            <small id="builder-message-help">
              {remaining.toLocaleString()} characters left. {state.limits.daily_messages - state.sent_today} of{" "}
              {state.limits.daily_messages} messages left today.
              {pending ? " You can send another message after Codex answers this one." : ""}
            </small>
            <div className="button-row">
              <Button variant="primary" type="submit" busy={action.busy} disabled={blocked || !text.trim()}>
                Send to Codex
              </Button>
              <Button
                variant="quiet"
                type="button"
                onClick={() =>
                  action.run(async () => {
                    const data = await get("/builder-chat/export");
                    saveFile(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), "porchday-builder-chat.json");
                  })
                }
              >
                <Icon name="download" size={16} />
                Download my messages
              </Button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}
