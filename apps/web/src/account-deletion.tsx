import React, { useEffect, useRef } from "react";
import { ApiError, request } from "./api";
import { Button, Logo } from "./ui";

export class DeletionUnconfirmedError extends Error {
  constructor() {
    super("Deletion was not confirmed. The request may have reached the service. Do not submit it again until support has checked its status.");
  }
}

export async function requestAccountDeletion() {
  let result: unknown;
  try {
    result = await request("/account", {
      method: "DELETE",
      body: JSON.stringify({ confirm: "DELETE" }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408)
      throw error;
    throw new DeletionUnconfirmedError();
  }
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).length !== 1 || (result as { ok?: unknown }).ok !== true)
    throw new DeletionUnconfirmedError();
}

export type DeletionReceipt = { clearing: boolean; cleanupUnconfirmed: boolean };
export type DeletionContext = { route: string; authentication: number; navigation: number };
export function deletionContextMatches(expected: DeletionContext, current: DeletionContext) {
  return expected.route === current.route && expected.authentication === current.authentication && expected.navigation === current.navigation;
}

/** A delayed response must never clear a later login or recreate a dismissed receipt. */
export async function completeDeletionInCurrentSession(steps: {
  canStart: () => boolean;
  start: () => void;
  cleanup: () => Promise<void>;
  receiptIsCurrent: () => boolean;
  finish: (cleanupUnconfirmed: boolean) => void;
  end: () => void;
}) {
  if (!steps.canStart()) return;
  steps.start();
  let cleanupUnconfirmed = false;
  try { await steps.cleanup(); } catch { cleanupUnconfirmed = true; }
  if (steps.receiptIsCurrent()) steps.finish(cleanupUnconfirmed);
  steps.end();
}

export function AccountDeletionReceipt({ receipt, onClose }: {
  receipt: DeletionReceipt | null;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <main id="main-content" className="narrow-page">
      <Logo />
      <section className="panel form-stack">
        <h1 ref={heading} tabIndex={-1}>
          {receipt ? "Account deletion accepted" : "No deletion confirmation"}
        </h1>
        {receipt ? <>
          <p>Your deletion request was confirmed. Account access, sessions, and integration grants have been revoked.</p>
          <p>Encrypted data and identity cleanup run in the background. Completion has not been verified on this screen.</p>
          <p>Encrypted backups age out within seven days. Copies saved by you or other people cannot be recalled.</p>
          <p role="status" aria-live="polite">
            {receipt.clearing ? "Clearing this browser’s keys and signing out…" : receipt.cleanupUnconfirmed
              ? "Local sign-out cleanup could not be confirmed. Close this tab. Your deletion request remains accepted."
              : "This browser’s encryption keys have been cleared and you are signed out."}
          </p>
          <p className="small-copy">This confirmation is kept only in this tab until you leave or reload it.</p>
        </> : <p>This tab has no confirmed deletion request. Opening this page does not delete an account or establish that deletion succeeded.</p>}
        <Button variant="outline" disabled={receipt?.clearing} onClick={onClose}>Return to homepage</Button>
      </section>
    </main>
  );
}
