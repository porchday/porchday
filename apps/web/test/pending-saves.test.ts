import { afterEach, describe, expect, it, vi } from "vitest";
import { hasPendingSaves, pendingSaves, withPendingSave } from "../src/pending-saves";
import { get, post } from "../src/api";

afterEach(() => vi.unstubAllGlobals());
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
};

describe("pending saves", () => {
  it("retains the unload guard until concurrent saves have both settled", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const first = deferred(), second = deferred();
    const a = withPendingSave(() => first.promise);
    const b = withPendingSave(() => second.promise);
    expect(pendingSaves.getSnapshot()).toBe(2);
    expect(target.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
    first.resolve(new Response()); await a;
    expect(hasPendingSaves()).toBe(true);
    second.resolve(new Response()); await b;
    expect(hasPendingSaves()).toBe(false);
    expect(target.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
  });
  it("tracks API writes through response parsing and clears on failure, excluding reads", async () => {
    const read = deferred();
    vi.stubGlobal("fetch", vi.fn(() => read.promise));
    const reading = get("/fixture");
    expect(hasPendingSaves()).toBe(false);
    read.resolve(Response.json({})); await reading;
    const write = deferred();
    vi.stubGlobal("fetch", vi.fn(() => write.promise));
    const writing = post("/fixture");
    expect(hasPendingSaves()).toBe(true);
    write.resolve(Response.json({ error: "synthetic" }, { status: 500 }));
    await expect(writing).rejects.toThrow();
    expect(hasPendingSaves()).toBe(false);
  });
  it("clears the guard when encryption fails before a request exists", async () => {
    await expect(withPendingSave(async () => { throw new Error("encryption failed"); })).rejects.toThrow("encryption failed");
    expect(hasPendingSaves()).toBe(false);
  });
});
