import { afterEach, describe, expect, it, vi } from "vitest";
import { completeRecovery, recoveryUnconfirmedMessage } from "../src/recovery-completion";

afterEach(() => vi.unstubAllGlobals());
const token = "a".repeat(64);
const password = "Synthetic local phrase 42!";
function reply(status: number, body: unknown) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("reviewed restoration responses", () => {
  it.each([
    [400, "INVALID_OR_USED_LINK", "Open the newest restoration email"],
    [400, "INVALID_RECOVERY", "between 12 and 128 characters"],
    [403, "REVIEW_REQUIRED", "review needs to be confirmed again"],
    [409, "CONTACT_UNAVAILABLE", "verified safe contact address"],
    [429, "RATE_LIMITED", "Wait at least 15 minutes"],
    [400, "PASSWORD_COMPROMISED", "has not appeared in known breaches"],
  ])("gives safe contextual guidance for %s %s without retry", async (status, code, text) => {
    const fetcher = reply(Number(status), { error: { code, message: "private-provider-detail" } });
    await expect(completeRecovery(token, password)).rejects.toThrow(String(text));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [503, { error: { code: "PRIVACY_CHECKPOINT_REQUIRED", message: "private-provider-detail" } }],
    [500, { error: { code: "UNEXPECTED", message: "private-provider-detail" } }],
    [500, { error: { code: "__proto__" } }],
    [201, { ok: true, signInRequired: true, encryptionRecoveryRequired: true }],
    [200, { ok: true }],
    [200, null],
  ])("keeps an ambiguous %s result unconfirmed", async (status, body) => {
    reply(status, body);
    await expect(completeRecovery(token, password)).rejects.toThrow(recoveryUnconfirmedMessage);
  });

  it("keeps unreadable or network-failed responses unconfirmed without provider text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private-network-detail")));
    await expect(completeRecovery(token, password)).rejects.toThrow(recoveryUnconfirmedMessage);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(completeRecovery(token, password)).rejects.toThrow(recoveryUnconfirmedMessage);
  });

  it("accepts only the confirmed completion response and sends credentials without caching", async () => {
    const fetcher = reply(200, { ok: true, signInRequired: true, encryptionRecoveryRequired: true });
    await expect(completeRecovery(token, password)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/account-recovery/complete", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, newPassword: password }),
    });
  });
});
