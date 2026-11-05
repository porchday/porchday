import { afterEach, describe, expect, it, vi } from "vitest";
import { jpegDimensions, validatedPhoto } from "../src/photo-safety";

// A frame/scan structure for testing pre-decode limits, not a decodable image.
function jpeg(width = 320, height = 240, progressive = false) {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    progressive ? 0xc2 : 0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
    0xff,
    0xda,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    0x21,
    0xff,
    0,
    0x32,
    0xff,
    0xd0,
    0x43,
    0xff,
    0xd9,
  ]);
}
afterEach(() => vi.unstubAllGlobals());
describe("untrusted JPEG preflight", () => {
  it("reads baseline and progressive frames while skipping stuffed bytes and restart markers", () => {
    expect(jpegDimensions(jpeg())).toEqual({ width: 320, height: 240 });
    expect(jpegDimensions(jpeg(2400, 100, true))).toEqual({
      width: 2400,
      height: 100,
    });
  });
  it("rejects oversized frames, non-JPEG input, deferred dimensions and malformed lengths before decoding", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const truncated = jpeg().slice(0, 13);
    const badLength = jpeg();
    badLength[5] = 1;
    for (const bytes of [
      jpeg(65000, 65000),
      jpeg(0, 400),
      new Uint8Array([137, 80, 78, 71]),
      truncated,
      badLength,
    ])
      await expect(validatedPhoto(bytes)).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });
  it("rejects a second frame even when it occurs after entropy-coded data", () => {
    const first = jpeg();
    const second = jpeg(65000, 65000);
    const joined = new Uint8Array([...first.slice(0, -2), ...second.slice(2)]);
    expect(() => jpegDimensions(joined)).toThrow(/supported JPEG/);
    expect(() =>
      jpegDimensions(new Uint8Array([...first, ...first])),
    ).toThrow();
  });
  it("checks the decoder result and releases its bitmap on success and mismatch", async () => {
    const close = vi.fn();
    const decode = vi
      .fn()
      .mockResolvedValue({ width: 320, height: 240, close });
    vi.stubGlobal("createImageBitmap", decode);
    const result = await validatedPhoto(jpeg());
    expect(result.width).toBe(320);
    expect(result.blob.type).toBe("image/jpeg");
    expect(close).toHaveBeenCalledOnce();
    decode.mockResolvedValue({ width: 640, height: 480, close });
    await expect(validatedPhoto(jpeg())).rejects.toThrow(
      /inconsistent dimensions/,
    );
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("retains the received-photo area bound even with an explicit dimension override", () => {
    expect(jpegDimensions(jpeg(6000, 4000), 65535).width).toBe(6000);
    expect(() => jpegDimensions(jpeg(10000, 10000), 65535)).toThrow(
      /safe dimensions/,
    );
  });
});
