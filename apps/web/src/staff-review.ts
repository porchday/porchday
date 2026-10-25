export type ReviewValidation = { field: "evidenceReference" | "reason"; message: string };

export function reviewValidation(recovery: boolean, reference: string, reason: string): ReviewValidation | null {
  if (recovery && (reference.trim().length < 10 || reference.trim().length > 500))
    return { field: "evidenceReference", message: "Enter a corroborating evidence reference between 10 and 500 characters, excluding surrounding spaces." };
  const length = recovery ? reason.trim().length : reason.length;
  if (length < (recovery ? 10 : 3) || length > (recovery ? 1000 : 60))
    return { field: "reason", message: recovery
      ? "Enter a reason between 10 and 1,000 characters, excluding surrounding spaces."
      : "Enter a reason code between 3 and 60 characters." };
  return null;
}

export const reviewUnconfirmed = "We could not confirm whether the decision was recorded. Refresh this case and check the recorded reviews before submitting again.";

export function recoveryReviewNotice(data: unknown, decision: string): string {
  const value = data as { ok?: unknown; approvals?: unknown; restoreLinkQueued?: unknown } | null;
  if (value?.ok !== true || !Number.isSafeInteger(value.approvals) || (value.approvals as number) < 0 ||
      typeof value.restoreLinkQueued !== "boolean") throw new Error(reviewUnconfirmed);
  if (decision !== "restore") {
    if (value.restoreLinkQueued) throw new Error(reviewUnconfirmed);
    return "The review was recorded. No restoration email was queued for this decision.";
  }
  const approvals = value.approvals as number;
  if (value.restoreLinkQueued && approvals >= 2)
    return `The review was recorded with ${approvals} distinct authorized approvals. A restoration email was queued; delivery is not yet confirmed. The newest link replaces earlier restoration links and expires 30 minutes after it was issued. Ask the claimant to use the newest email.`;
  if (!value.restoreLinkQueued && approvals < 2)
    return `The review was recorded with ${approvals} distinct authorized ${approvals === 1 ? "approval" : "approvals"}. Two distinct authorized reviewers are required before a restoration email can be queued.`;
  throw new Error(reviewUnconfirmed);
}
