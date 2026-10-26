import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountDeletionReceipt, completeDeletionInCurrentSession, deletionContextMatches, DeletionUnconfirmedError, requestAccountDeletion } from "../src/account-deletion";
import { IntegrationGrantDetails } from "../src/Integrations";

afterEach(() => vi.unstubAllGlobals());
function reply(body: unknown, status = 200) {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("account deletion acknowledgement", () => {
  it("ignores an old account response and never signs out its replacement", async () => {
    const steps = {canStart: () => false, start: vi.fn(), cleanup: vi.fn(), receiptIsCurrent: () => true, finish: vi.fn(), end: vi.fn()};
    await completeDeletionInCurrentSession(steps);
    expect(steps.start).not.toHaveBeenCalled(); expect(steps.cleanup).not.toHaveBeenCalled(); expect(steps.finish).not.toHaveBeenCalled();
  });
  it("rejects a pending response after departure and return even before a new login completes", async () => {
    const original = {route:"/app/settings/data", authentication:1, navigation:2};
    const current = {...original, navigation:4};
    const cleanup = vi.fn();
    await completeDeletionInCurrentSession({
      canStart: () => deletionContextMatches(original, current),
      start: vi.fn(), cleanup, receiptIsCurrent: () => true, finish: vi.fn(), end: vi.fn(),
    });
    expect(cleanup).not.toHaveBeenCalled();
  });
  it("does not recreate a receipt after leaving while cleanup is pending", async () => {
    let current = true;
    let resolve!: () => void;
    const steps = {canStart: () => true, start: vi.fn(), cleanup: () => new Promise<void>(done => {resolve = done;}), receiptIsCurrent: () => current, finish: vi.fn(), end: vi.fn()};
    const pending = completeDeletionInCurrentSession(steps);
    current = false; resolve(); await pending;
    expect(steps.start).toHaveBeenCalledOnce(); expect(steps.finish).not.toHaveBeenCalled(); expect(steps.end).toHaveBeenCalledOnce();
  });
  it.each([{}, null, [], {ok: false}, {ok: "true"}, {ok: true, pending: true}])("does not turn an unknown response into accepted deletion", async body => {
    const fetcher = reply(body);
    await expect(requestAccountDeletion()).rejects.toBeInstanceOf(DeletionUnconfirmedError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves uncertain server and network failures without retrying or exposing raw details", async () => {
    const fetcher = reply({error: {message: "private server detail"}}, 503);
    await expect(requestAccountDeletion()).rejects.toThrow("Deletion was not confirmed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValue(new Error("private network detail"));
    await expect(requestAccountDeletion()).rejects.toThrow("Do not submit it again");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("preserves a clear recent-auth rejection and accepts only the acknowledged request", async () => {
    const fetcher = reply({error: {code: "RECENT_AUTH_REQUIRED"}}, 409);
    await expect(requestAccountDeletion()).rejects.toThrow("sign out and sign in again");
    fetcher.mockResolvedValue(new Response('{"ok":true}', {status:200}));
    await expect(requestAccountDeletion()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenLastCalledWith("/api/v1/account", expect.objectContaining({method:"DELETE", credentials:"same-origin", cache:"no-store", body:'{"confirm":"DELETE"}'}));
  });
  it("distinguishes accepted access revocation from unfinished background cleanup", () => {
    const html = renderToStaticMarkup(createElement(AccountDeletionReceipt, {receipt: {clearing: false, cleanupUnconfirmed: false}, onClose() {}}));
    expect(html).toContain("Account deletion accepted");
    expect(html).toContain("have been revoked");
    expect(html).toContain("Completion has not been verified");
    expect(html).toContain("within seven days");
    expect(html).toContain('role="status"');
    expect(html).toContain('tabindex="-1"');
    const direct = renderToStaticMarkup(createElement(AccountDeletionReceipt, {receipt:null, onClose() {}}));
    expect(direct).toContain("No deletion confirmation");
    expect(direct).not.toContain("have been revoked");
    expect(direct).not.toContain("Account deletion accepted");
    const uncertain = renderToStaticMarkup(createElement(AccountDeletionReceipt, {receipt:{clearing:false, cleanupUnconfirmed:true}, onClose() {}}));
    expect(uncertain).toContain("Local sign-out cleanup could not be confirmed");
    expect(uncertain).not.toContain("you are signed out");
  });
  it("retains integration purpose, requested scopes and last use after consent", () => {
    const grant = {name:"Photo archive",purpose:"Save a local copy of my own photos",scopes:["media:read","export:read"],last_used_at:"2026-10-25T12:00:00.000Z"};
    const html = renderToStaticMarkup(createElement(IntegrationGrantDetails, {grant}));
    expect(html).toContain(grant.name); expect(html).toContain(grant.purpose);
    expect(html).toContain("media:read, export:read"); expect(html).not.toContain("Not used yet");
  });
});
