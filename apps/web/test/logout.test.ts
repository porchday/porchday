import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  forget: vi.fn(),
  unsubscribe: vi.fn(),
  auth: vi.fn(),
}));
vi.mock("@porchday/crypto/browser", () => ({ forgetAllDevices: mocks.forget }));
vi.mock("../src/push", () => ({ unsubscribeCurrentPush: mocks.unsubscribe }));
vi.mock("../src/api", () => ({ auth: mocks.auth }));
import { signOutSafely } from "../src/logout";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.forget.mockResolvedValue(undefined);
  mocks.unsubscribe.mockResolvedValue(undefined);
  mocks.auth.mockResolvedValue({ ok: true });
});
describe("sign-out confidentiality and session state", () => {
  it("clears local keys and unsubscribes the browser before confirming server sign-out", async () => {
    await signOutSafely();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.forget).toHaveBeenCalledOnce();
    expect(mocks.auth).toHaveBeenCalledWith("sign-out", {});
    expect(mocks.forget.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.auth.mock.invocationCallOrder[0],
    );
  });
  it("still clears local keys but reports when a network error leaves revocation unconfirmed", async () => {
    mocks.auth.mockRejectedValue(new Error("network"));
    await expect(signOutSafely()).rejects.toThrow(
      "session may still be active",
    );
    expect(mocks.forget).toHaveBeenCalledOnce();
  });
  it("treats an already expired session as signed out", async () => {
    mocks.auth.mockRejectedValue({ status: 401 });
    await expect(signOutSafely()).resolves.toBeUndefined();
    expect(mocks.forget).toHaveBeenCalledOnce();
  });
});
