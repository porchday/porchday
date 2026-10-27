import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emojiSourceDimensions,
  prepareCustomEmoji,
  validateCustomEmojiPixels,
  stripCanvasPngMetadata,
} from "../src/emoji-images";
import { custom, tinyPng, pngChunk } from "./emoji-fixtures";
import { customPngBytes, validateCustomPng } from "@porchday/crypto/reactions";
import webkitFixture from "./fixtures/webkit-canvas-png.json";

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
function browser(
  width: number,
  height: number,
  fail = false,
  encoded?: Uint8Array,
) {
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
              : new Blob([encoded ?? tinyPng(4, canvas.width, canvas.height)], {
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
  it("normalizes actual Safari canvas EXIF output without changing pixels, alpha or safe color chunks", async () => {
    const original = Buffer.from(webkitFixture.png, "base64"),
      chunks: { kind: string; bytes: Uint8Array }[] = [];
    for (let at = 8; at < original.length; ) {
      const end = at + original.readUInt32BE(at) + 12;
      chunks.push({
        kind: original.subarray(at + 4, at + 8).toString("ascii"),
        bytes: original.subarray(at, end),
      });
      at = end;
    }
    expect(chunks.map((chunk) => chunk.kind)).toContain("eXIf");
    expect(() => validateCustomPng(original)).toThrow(/Unsupported/);
    const result = stripCanvasPngMetadata(original);
    expect(result).toEqual(
      new Uint8Array(
        Buffer.concat([
          original.subarray(0, 8),
          ...chunks
            .filter((chunk) => chunk.kind !== "eXIf")
            .map((chunk) => chunk.bytes),
        ]),
      ),
    );
    expect(validateCustomPng(result)).toEqual({ width: 64, height: 64 });
    const { close } = browser(64, 64, false, original);
    const prepared = await prepareCustomEmoji(
      new File([original], "webkit.png", { type: "image/png" }),
      "orange",
    );
    expect(customPngBytes(prepared.custom.png)).toEqual(result);
    expect(close).toHaveBeenCalledOnce();
    // Receiving an unsupported PNG never invokes upload-only normalization.
    await expect(
      validateCustomEmojiPixels({
        ...prepared,
        custom: { ...prepared.custom, png: webkitFixture.png },
      }),
    ).rejects.toThrow(/Unsupported/);
    expect(Buffer.from(webkitFixture.png, "base64")).toEqual(original);
  });
  it("checks stripped chunk CRCs and rejects malformed core, animation, trailing bytes and oversize canvas data", () => {
    const original = tinyPng(),
      badExif = pngChunk("eXIf", new Uint8Array(68));
    badExif[badExif.length - 1] ^= 1;
    const withChunk = (chunk: Uint8Array) =>
      Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]);
    const idatStart = 33,
      idatEnd = idatStart + original.readUInt32BE(idatStart) + 12;
    for (const bytes of [
      withChunk(badExif),
      withChunk(pngChunk("acTL", new Uint8Array(8))),
      withChunk(pngChunk("ABCD", new Uint8Array())),
      Buffer.concat([original, Buffer.of(0)]),
      original.subarray(0, -1),
      new Uint8Array(1024 * 1024 + 1),
      Buffer.concat([
        original.subarray(0, idatEnd),
        pngChunk("eXIf", new Uint8Array(68)),
        original.subarray(idatStart),
      ]),
      Buffer.concat([
        original.subarray(0, 33),
        pngChunk("IEND", new Uint8Array()),
      ]),
    ])
      expect(() => stripCanvasPngMetadata(bytes)).toThrow();
  });
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
  it("imports JPEG aliases and missing MIME labels using only the primary image, while keeping emoji limits", async () => {
    const primary = jpeg(320, 240),
      // MPF directory plus an appended, oversized auxiliary image.
      source = Uint8Array.from([
        255, 216, 255, 226, 0, 6, 77, 80, 70, 0,
        ...primary.slice(2), ...jpeg(65000, 65000),
      ]);
    for (const type of ["image/pjpeg", "image/jpg", "", "application/octet-stream"]) {
      const { close } = browser(320, 240);
      const result = await prepareCustomEmoji(
        new File([source], "photo.jfif", { type }),
        "photo",
      );
      const decoded = vi.mocked(createImageBitmap).mock.calls[0][0] as Blob;
      expect(decoded.type).toBe("image/jpeg");
      expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(primary);
      expect(validateCustomPng(customPngBytes(result.custom.png))).toEqual({
        width: 128,
        height: 96,
      });
      expect(close).toHaveBeenCalledOnce();
    }
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    await expect(prepareCustomEmoji(
      new File([jpeg(5000, 4000)], "large.jfif", { type: "image/pjpeg" }),
      "large",
    )).rejects.toThrow(/16 megapixels/);
    expect(decode).not.toHaveBeenCalled();
  });
  it("offers export guidance when the native decoder lacks the source JPEG codec", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("unsupported codec")));
    await expect(prepareCustomEmoji(
      new File([jpeg(320, 240)], "photo.jfif", { type: "image/pjpeg" }),
      "photo",
    )).rejects.toThrow(/Export it as a standard JPEG or PNG/);
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
