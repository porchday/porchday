import React, { useEffect, useState } from "react";
import { get, post, items, localDate, type Json } from "./api";
import { Alert, Button, Empty, Icon, Loading, useAction } from "./ui";
import { PublicHeader, PublicFooter } from "./Public";
export function Appeals({ onLogout }: { onLogout: () => Promise<void> }) {
  const [actions, setActions] = useState<Json[] | null>(null);
  const action = useAction();
  async function refresh() {
    setActions(items(await get("/api/member-appeals")));
  }
  useEffect(() => {
    action.run(refresh);
  }, []);
  return (
    <>
      <PublicHeader />
      <main id="main-content" className="narrow-page">
        <span className="eyebrow">A HUMAN SECOND LOOK</span>
        <h1>Ask for a review.</h1>
        <p>
          If your account was restricted, you can ask an independent moderator
          to reconsider the decision. A security hold uses the separate
          stolen-account recovery process.
        </p>
        <section className="panel">
          <Alert>{action.error}</Alert>
          <Alert success>{action.notice}</Alert>
          {actions === null ? (
            action.busy ? (
              <Loading text="Finding your account decisions…" />
            ) : (
              <p>
                Sign in to see eligible decisions. If your established login
                method is no longer available, use account recovery below.
              </p>
            )
          ) : actions.length ? (
            actions.map((a) => (
              <div className="member-row" key={a.id}>
                <Icon name="shield" />
                <div className="member-info">
                  <strong>
                    {String(a.action || "Account action").replaceAll("_", " ")}
                  </strong>
                  <small>
                    {String(a.reason_code || "Review required").replaceAll(
                      "_",
                      " ",
                    )}{" "}
                    · {localDate(a.created_at)}
                  </small>
                </div>
                <Button
                  variant="outline compact"
                  busy={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await post("/api/member-appeals", { action_id: a.id });
                      await refresh();
                    }, "An independent review was requested. You will not be reviewed by the moderator who made the original decision.")
                  }
                >
                  Request review
                </Button>
              </div>
            ))
          ) : (
            <Empty icon="shield" title="No eligible decisions here.">
              There are no account actions available for appeal in this channel.
            </Empty>
          )}
        </section>
        <div className="button-row">
          <a href="/stolen-account" className="button outline">
            My account was stolen
          </a>
          <a href="/app" className="button quiet">
            Return to Porchday
          </a>
          <Button variant="quiet" onClick={onLogout}>
            Sign out
          </Button>
        </div>
      </main>
      <PublicFooter />
    </>
  );
}
