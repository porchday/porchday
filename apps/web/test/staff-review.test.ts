import { expect, test } from "vitest";
import { recoveryReviewNotice, reviewUnconfirmed, reviewValidation } from "../src/staff-review";

test("recovery input guidance matches trimmed server limits and identifies the field to focus", () => {
  expect(reviewValidation(true, "", "")).toMatchObject({ field: "evidenceReference" });
  expect(reviewValidation(true, "     short     ", "reason sufficiently long")).toMatchObject({ field: "evidenceReference" });
  expect(reviewValidation(true, "evidence reference", "    short    ")).toMatchObject({ field: "reason" });
  expect(reviewValidation(true, "a".repeat(501), "valid reason")).toMatchObject({ field: "evidenceReference" });
  expect(reviewValidation(true, "valid evidence", "a".repeat(1001))).toMatchObject({ field: "reason" });
  expect(reviewValidation(true, " " + "a".repeat(10) + " ", "b".repeat(10))).toBeNull();
  expect(reviewValidation(false, "", "abc")).toBeNull();
});

test("queued restoration distinguishes authorization count and delivery without claiming a new vote", () => {
  expect(recoveryReviewNotice({ ok: true, approvals: 1, restoreLinkQueued: false }, "restore")).toContain("1 distinct authorized approval");
  const queued = recoveryReviewNotice({ ok: true, approvals: 2, restoreLinkQueued: true }, "restore");
  expect(queued).toContain("queued; delivery is not yet confirmed");
  expect(queued).toContain("replaces earlier restoration links");
  expect(queued).toContain("30 minutes after it was issued");
  expect(recoveryReviewNotice({ ok: true, approvals: 0, restoreLinkQueued: false }, "hold")).toContain("No restoration email was queued");
});

test("unknown or inconsistent acknowledgements remain unconfirmed", () => {
  for (const data of [null, {}, { ok: true }, { ok: true, approvals: 1, restoreLinkQueued: true }, { ok: true, approvals: 2, restoreLinkQueued: false }, { ok: true, approvals: "2", restoreLinkQueued: true }])
    expect(() => recoveryReviewNotice(data, "restore")).toThrow(reviewUnconfirmed);
});
