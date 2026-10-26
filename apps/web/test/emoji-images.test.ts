import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emojiSourceDimensions,
  prepareCustomEmoji,
  validateCustomEmojiPixels,
} from "../src/emoji-images";
import { custom, tinyPng, pngChunk } from "./emoji-fixtures";
import { customPngBytes, validateCustomPng } from "@porchday/crypto/reactions";

afterEach(() => vi.unstubAllGlobals());
function jpeg(width: number, height: number) {
  return new Uint8Array([
    255,
    216,
    255,
    192,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    17,
    0,
    255,
    218,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    1,
    255,
    217,
  ]);
}
function webp(animated = false) {
  const value = Buffer.alloc(30);
  value.write("RIFF");
  value.writeUInt32LE(22, 4);
  value.write("WEBPVP8X", 8);
  value.writeUInt32LE(10, 16);
  value[20] = animated ? 2 : 0;
  value[24] = 63;
  value[27] = 31;
  return value;
}
function browser(width: number, height: number, fail = false) {
  const close = vi.fn(),
    draw = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close })),
  );
  vi.stubGlobal("document", {
    createElement: vi.fn(() => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: draw }),
        toBlob(callback: (value: Blob | null) => void) {
          callback(
            fail
              ? null
              : new Blob([tinyPng(4, canvas.width, canvas.height)], {
                  type: "image/png",
                }),
          );
        },
      };
      return canvas;
    }),
  });
  return { close, draw };
}
describe("static custom image normalization", () => {
  it("bounds PNG/JPEG/WebP headers before decoding and refuses animation and other formats", async () => {
    expect(emojiSourceDimensions(tinyPng(), "image/png")).toEqual({
      width: 1,
      height: 1,
    });
    expect(emojiSourceDimensions(jpeg(320, 240), "image/jpeg")).toEqual({
      width: 320,
      height: 240,
    });
    expect(emojiSourceDimensions(webp(), "image/webp")).toEqual({
      width: 64,
      height: 32,
    });
    const png = tinyPng();
    const animated = Buffer.concat([
      png.subarray(0, 33),
      pngChunk("acTL", new Uint8Array(8)),
      png.subarray(33),
    ]);
    const huge = png.slice();
    huge.writeUInt32BE(5000, 16);
    huge.writeUInt32BE(5000, 20);
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    for (const [bytes, mime] of [
      [animated, "image/png"],
      [webp(true), "image/webp"],
      [huge, "image/png"],
      [jpeg(5000, 5000), "image/jpeg"],
      [Buffer.from("<svg/>"), "image/svg+xml"],
      [new Uint8Array(5 * 1024 * 1024 + 1), "image/png"],
    ] as const) {
      await expect(
        prepareCustomEmoji(new File([bytes], "image", { type: mime }), "image"),
      ).rejects.toThrow();
    }
    expect(decode).not.toHaveBeenCalled();
  });
  it("accepts EXIF-rotated JPEG dimensions and encodes a bounded PNG with no source metadata", async () => {
    const { close, draw } = browser(240, 320);
    const result = await prepareCustomEmoji(
      new File([jpeg(320, 240)], "phone.jpg", { type: "image/jpeg" }),
      "phone",
    );
    expect(result.custom.name).toBe("phone");
    expect(validateCustomPng(customPngBytes(result.custom.png))).toEqual({
      width: 96,
      height: 128,
    });
    expect(draw.mock.calls[0].slice(1)).toEqual([0, 0, 96, 128]);
    expect(close).toHaveBeenCalledOnce();
  });
  it("releases decoded resources on mismatch and failed encoding", async () => {
    let handle = browser(20, 30);
    await expect(
      prepareCustomEmoji(
        new File([tinyPng()], "a.png", { type: "image/png" }),
        "a",
      ),
    ).rejects.toThrow(/inconsistent/);
    expect(handle.close).toHaveBeenCalledOnce();
    handle = browser(1, 1, true);
    await expect(
      prepareCustomEmoji(
        new File([tinyPng()], "a.png", { type: "image/png" }),
        "a",
      ),
    ).rejects.toThrow(/process/);
    expect(handle.close).toHaveBeenCalledOnce();
  });
  it("validates received bytes before decoding and closes the bitmap after success or mismatch", async () => {
    const item = await custom(),
      handle = browser(1, 1);
    await validateCustomEmojiPixels(item);
    expect(handle.close).toHaveBeenCalledOnce();
    await expect(
      validateCustomEmojiPixels({
        ...item,
        custom: { ...item.custom, png: btoa("<svg/>") },
      }),
    ).rejects.toThrow();
    expect(createImageBitmap).toHaveBeenCalledOnce();
    const wrong = browser(2, 1);
    await expect(validateCustomEmojiPixels(item)).rejects.toThrow(
      /inconsistent/,
    );
    expect(wrong.close).toHaveBeenCalledOnce();
  });
});
