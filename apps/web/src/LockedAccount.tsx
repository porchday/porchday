import React, { useRef, useState } from "react";
import { del, get, items, type Json, type Member } from "./api";
import { Alert, Button, Field, Icon, useAction } from "./ui";
import { signOutSafely } from "./logout";
import { DeletionUnconfirmedError, requestAccountDeletion } from "./account-deletion";

/** Account access and deletion never depend on possessing encryption keys. */
export function LockedAccount({ member, onAccountDeleted }: { member: Member; onAccountDeleted: () => Promise<void> }) {
  const action = useAction();
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [groups, setGroups] = useState<Json[]>([]);
  const [deletionUnconfirmed, setDeletionUnconfirmed] = useState(false);
  const deletionAttempt = useRef(false);
  async function signOut() {
    await signOutSafely();
    location.assign("/login");
  }
  return (
    <section className="panel form-stack locked-account">
      <h2>Your account is still yours.</h2>
      <p>
        Signed in as <strong>@{member.handle}</strong>. You can sign in again
        for a fresh security session, report a stolen account, or delete your
        account without unlocking content.
      </p>
      <div className="button-row">
        <Button
          variant="outline"
          busy={action.busy}
          onClick={() => action.run(signOut)}
        >
          <Icon name="logout" size={16} />
          Sign out
        </Button>
        <a href="/stolen-account" className="text-link">
          My account was stolen
        </a>
        <a href="/appeals" className="text-link">
          Appeals
        </a>
      </div>
      <details
        open={deleting}
        onToggle={(e) => setDeleting(e.currentTarget.open)}
      >
        <summary>Delete this account without unlocking</summary>
        <div className="form-stack">
          <p>
            Deletion removes your encrypted content and connections. It cannot
            be undone. Exporting readable content requires your recovery secret
            first. Transfer or delete groups you own before deleting your
            account.
          </p>
          <Button
            variant="outline compact"
            busy={action.busy}
            onClick={() =>
              action.run(async () =>
                setGroups(items(await get("/owned-groups"))),
              )
            }
          >
            Check groups I own
          </Button>
          {groups.map((group) => (
            <div className="member-row" key={group.id}>
              <span className="member-info">
                Owned group <small>{group.id}</small>
              </span>
              <Button
                variant="danger compact"
                onClick={() => {
                  if (
                    window.confirm(
                      "Permanently delete this group and its contents?",
                    )
                  )
                    action.run(async () => {
                      await del(`/groups/${group.id}`);
                      setGroups((old) => old.filter((g) => g.id !== group.id));
                    });
                }}
              >
                Delete group
              </Button>
            </div>
          ))}
          <Field
            label="Type DELETE to confirm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
          />
          <Button
            variant="danger"
            disabled={confirmText !== "DELETE" || deletionUnconfirmed || groups.length > 0}
            busy={action.busy}
            onClick={() =>
              action.run(async () => {
                if (deletionAttempt.current) return;
                deletionAttempt.current = true;
                try { await requestAccountDeletion(); }
                catch (error) {
                  if (error instanceof DeletionUnconfirmedError) setDeletionUnconfirmed(true);
                  else deletionAttempt.current = false;
                  throw error;
                }
                await onAccountDeleted();
              })
            }
          >
            Permanently delete my account
          </Button>
          {action.busy && <p role="status">Submitting your deletion request…</p>}
          <p className="small-copy">
            Requires a recent sign-in. A security hold can temporarily pause
            deletion while ownership is reviewed.
          </p>
        </div>
      </details>
      <Alert>{action.error}</Alert>
    </section>
  );
}
