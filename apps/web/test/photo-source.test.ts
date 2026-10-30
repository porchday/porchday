import { afterEach, describe, expect, it, vi } from "vitest";
import {
  jpegDimensions,
  jpegSource,
  photoSourceMime,
  stripCanvasJpegMetadata,
} from "../src/photo-safety";
import { preparePhoto } from "../src/Social";

// Structural fixtures test bounds before native decoding. Real format/decoder
// compatibility is covered by scripts/check-photo-compatibility.mjs.
function jpeg(width = 320, height = 240, marker = 0xc0, precision = 8) {
  return Uint8Array.from([
    255, 216, 255, marker, 0, 11, precision, height >> 8, height & 255,
    width >> 8, width & 255, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0,
    63, 0, 42, 255, 0, 17, 255, 208, 42, 255, 217,
  ]);
}
function segment(marker: number, text: string) {
  const content = new TextEncoder().encode(text), length = content.length + 2;
  return Uint8Array.from([255, marker, length >> 8, length & 255, ...content]);
}
function withSegments(bytes: Uint8Array, ...parts: Uint8Array[]) {
  return Uint8Array.from([255, 216, ...parts.flatMap(p => [...p]), ...bytes.slice(2)]);
}
afterEach(() => vi.unstubAllGlobals());

describe("source JPEG preflight", () => {
  it("isolates the first complete image and removes its MPF directory, preserving EXIF and ICC for decoding", () => {
    const exif = segment(0xe1, "Exif\0\0orientation"),
      icc = segment(0xe2, "ICC_PROFILE\0color"),
      mpf = segment(0xe2, "MPF\0offsets"),
      expected = withSegments(jpeg(), exif, icc),
      input = Uint8Array.from([
        ...withSegments(jpeg(), exif, mpf, icc),
        ...jpeg(65000, 65000), // An auxiliary image must never reach the decoder.
        0, 0, 0,
      ]);
    expect(jpegSource(input)).toEqual({ width: 320, height: 240, bytes: expected });
    expect(() => jpegDimensions(input)).toThrow();
    expect(jpegDimensions(expected)).toEqual({ width: 320, height: 240 });
  });
  it("preflights nonhierarchical JPEG processes while leaving actual codec support to the browser", () => {
    for (const [marker, precision] of [
      [0xc0, 8], [0xc1, 8], [0xc1, 12], [0xc2, 8], [0xc2, 12],
      [0xc3, 8], [0xc3, 16], [0xc9, 8], [0xca, 12], [0xcb, 16],
    ])
      expect(jpegSource(jpeg(32, 24, marker, precision)).width).toBe(32);
    // Received ciphertext still requires the normalized 8-bit photo format.
    expect(() => jpegDimensions(jpeg(32, 24, 0xc3))).toThrow();
    expect(() => jpegDimensions(jpeg(32, 24, 0xc1, 12))).toThrow();
  });
  it("rejects malformed, oversized, deferred, hierarchical and embedded frames before native decoding", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const badLength = jpeg();
    badLength[5] = 1;
    const primary = jpeg(),
      extraFrame = Uint8Array.from([...primary.slice(0, -2), ...jpeg().slice(2)]);
    for (const input of [
      jpeg(0, 100), jpeg(32, 24, 0xc0, 12),
      jpeg(32, 24, 0xc5), jpeg(32, 24, 0xc3, 17), badLength,
      primary.slice(0, -1), extraFrame,
      withSegments(primary, segment(0xdc, "deferred")),
      withSegments(primary, segment(0xde, "hierarchical")),
      withSegments(primary, ...Array.from({ length: 4097 }, () => segment(0xfe, ""))),
      new Uint8Array(50 * 1024 * 1024 + 1),
    ])
      await expect(preparePhoto(new File([input], "photo.jpg", { type: "image/jpeg" }))).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });
  it("removes all APP/comment metadata only from already normalized canvas output", () => {
    const clean = jpeg(),
      encoded = withSegments(clean, segment(0xe0, "JFIF"), segment(0xe1, "Exif\0\0"),
        segment(0xe2, "ICC_PROFILE\0"), segment(0xfe, "comment"));
    expect(stripCanvasJpegMetadata(encoded)).toEqual(clean);
    expect(() => stripCanvasJpegMetadata(jpeg(6000, 4000))).toThrow();
    expect(() => stripCanvasJpegMetadata(Uint8Array.from([...encoded, 0]))).toThrow();
  });
  it("recognizes supported containers by signature, never by filename or claimed MIME", () => {
    expect(photoSourceMime(jpeg())).toBe("image/jpeg");
    expect(photoSourceMime(Uint8Array.from([137,80,78,71,13,10,26,10]))).toBe("image/png");
    expect(photoSourceMime(new TextEncoder().encode("RIFF0000WEBP"))).toBe("image/webp");
    expect(() => photoSourceMime(new TextEncoder().encode("<svg/>"))).toThrow(/JPEG, PNG, or WebP/);
  });
});

function browser(width = 320, height = 240) {
  const close = vi.fn(), draw = vi.fn(),
    decode = vi.fn(async (_blob: Blob) => ({ width, height, close }));
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal("FileReader", class {
    result = "data:image/jpeg;base64,preview";
    onload: (() => void) | null = null;
    readAsDataURL() { this.onload?.(); }
  });
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas = {
        width: 0, height: 0,
        getContext: () => ({ drawImage: draw }),
        toBlob(callback: (value: Blob | null) => void) {
          callback(new Blob([withSegments(jpeg(canvas.width, canvas.height), segment(0xe1, "Exif\0\0canvas"))], { type: "image/jpeg" }));
        },
      };
      return canvas;
    },
  });
  return { close, draw, decode };
}

describe("photo upload normalization", () => {
  it("normalizes full-resolution sources and rotated photos above 40 MP", async () => {
    const input = jpeg(8064, 6048);
    expect(jpegSource(input)).toMatchObject({ width: 8064, height: 6048 });
    // The source allowance never broadens received/archive validation.
    expect(() => jpegDimensions(input)).toThrow(/safe dimensions/);
    for (const [width, height, expectedWidth, expectedHeight] of [
      [8064, 6048, 2400, 1800], [6048, 8064, 1800, 2400],
      [10000, 10000, 2400, 2400],
    ]) {
      const handle = browser(width, height);
      const bytes = width === 10000 ? jpeg(width, height) : input;
      const prepared = await preparePhoto(new File([bytes], "full-resolution.jpg"));
      expect(prepared).toMatchObject({ width: expectedWidth, height: expectedHeight });
      expect(jpegDimensions(new Uint8Array(await prepared.blob.arrayBuffer())))
        .toEqual({ width: expectedWidth, height: expectedHeight });
      expect(handle.close).toHaveBeenCalledOnce();
    }
  });
  it("accepts a 50 MiB source inclusively and rejects one extra byte before reading or decoding", async () => {
    const primary = jpeg(), input = new Uint8Array(50 * 1024 * 1024);
    input.set(primary);
    const { decode } = browser();
    const result = await preparePhoto(new File([input], "large.jpg", { type: "image/jpeg" }));
    expect(result).toMatchObject({ width: 320, height: 240 });
    expect(new Uint8Array(await decode.mock.calls[0][0].arrayBuffer())).toEqual(primary);
    expect(decode).toHaveBeenCalledOnce();
    // The larger source allowance must not broaden received/archive limits.
    expect(() => jpegDimensions(input)).toThrow(/20 MB/);
    const oversized = new File([input, new Uint8Array(1)], "too-large.jpg", { type: "image/jpeg" });
    const read = vi.spyOn(oversized, "arrayBuffer");
    await expect(preparePhoto(oversized)).rejects.toThrow(/50 MB or smaller/);
    expect(read).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledOnce();
    const tooLarge = new Uint8Array(50 * 1024 * 1024 + 1);
    tooLarge.set(primary);
    expect(() => jpegSource(tooLarge)).toThrow(/50 MB or smaller/);
  });
  it("accepts JPEG MIME aliases and empty/misleading MIME labels, decodes only the primary and writes a clean bounded JPEG", async () => {
    const primary = jpeg(),
      input = Uint8Array.from([...withSegments(primary, segment(0xe2, "MPF\0offsets")), ...jpeg()]);
    for (const type of ["image/jpeg", "image/pjpeg", "image/jpg", "", "application/octet-stream", "image/png"]) {
      const { decode, close } = browser();
      const result = await preparePhoto(new File([input], "photo.jfif", { type }), 100);
      const decoded = decode.mock.calls[0][0];
      expect(decoded.type).toBe("image/jpeg");
      expect(new Uint8Array(await decoded.arrayBuffer())).toEqual(primary);
      expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(jpeg(100, 75));
      expect(result).toMatchObject({ width: 100, height: 75 });
      expect(close).toHaveBeenCalledOnce();
    }
  });
  it("preserves EXIF axis changes but rejects unrelated decoder dimensions and always closes the bitmap", async () => {
    let handle = browser(240, 320);
    const rotated = await preparePhoto(new File([jpeg()], "photo.jpg"));
    expect(rotated).toMatchObject({ width: 240, height: 320 });
    expect(handle.close).toHaveBeenCalledOnce();
    handle = browser(10, 10);
    await expect(preparePhoto(new File([jpeg()], "photo.jpg"))).rejects.toThrow(/inconsistent/);
    expect(handle.close).toHaveBeenCalledOnce();
    handle = browser(320, 240);
    handle.draw.mockImplementation(() => { throw new Error("draw failed"); });
    await expect(preparePhoto(new File([jpeg()], "photo.jpg"))).rejects.toThrow(/draw failed/);
    expect(handle.close).toHaveBeenCalledOnce();
  });
  it("gives export guidance for browser-unsupported codecs and rejects renamed non-images", async () => {
    const decode = vi.fn().mockRejectedValue(new Error("codec unsupported"));
    vi.stubGlobal("createImageBitmap", decode);
    await expect(preparePhoto(new File([jpeg(32, 24, 0xc9)], "photo.jpg"))).rejects.toThrow(/Export it as a standard JPEG or PNG/);
    expect(decode).toHaveBeenCalledOnce();
    await expect(preparePhoto(new File(["<svg/>"], "photo.jpg", { type: "image/jpeg" }))).rejects.toThrow(/Choose a JPEG/);
    expect(decode).toHaveBeenCalledOnce();
  });
});
