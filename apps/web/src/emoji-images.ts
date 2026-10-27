import { base64ToBytes } from "@porchday/crypto";
import {
  customReaction,
  validateCustomPng,
  CUSTOM_EMOJI_MAX_BYTES,
} from "@porchday/crypto/reactions";
import type { CustomEmoji } from "./emoji-library";
import { jpegSource, photoSourceMime } from "./photo-safety";

const INPUT_BYTES = 5 * 1024 * 1024,
  INPUT_PIXELS = 16_000_000;
function dimensions(width: number, height: number) {
  if (!width || !height || width * height > INPUT_PIXELS)
    throw new Error("Choose an image with no more than 16 megapixels.");
  return { width, height };
}
/** Bound decoder input first; animated containers are intentionally unsupported. */
export function emojiSourceDimensions(bytes: Uint8Array, mime: string) {
  if (!bytes.length || bytes.length > INPUT_BYTES)
    throw new Error("Choose an image no larger than 5 MB.");
  if (mime === "image/jpeg") {
    const size = jpegSource(bytes);
    return dimensions(size.width, size.height);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
  if (mime === "image/png") {
    if (
      bytes.length < 33 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, i) => bytes[i] === value,
      ) ||
      word(12) !== "IHDR"
    )
      throw new Error("This PNG image is invalid.");
    const size = dimensions(view.getUint32(16), view.getUint32(20));
    for (let at = 8, count = 0; at < bytes.length; ) {
      if (++count > 4096 || at + 12 > bytes.length)
        throw new Error("This PNG image is invalid.");
      const length = view.getUint32(at),
        type = word(at + 4);
      if (["acTL", "fcTL", "fdAT"].includes(type))
        throw new Error(
          "Animated images are not supported. Choose a static image.",
        );
      if (at + 12 + length > bytes.length)
        throw new Error("This PNG image is invalid.");
      at += length + 12;
    }
    return size;
  }
  if (mime === "image/webp") {
    if (
      bytes.length < 20 ||
      word(0) !== "RIFF" ||
      word(8) !== "WEBP" ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      throw new Error("This WebP image is invalid.");
    let size: { width: number; height: number } | null = null;
    for (let at = 12, count = 0; at < bytes.length; ) {
      if (++count > 4096 || at + 8 > bytes.length)
        throw new Error("This WebP image is invalid.");
      const type = word(at),
        length = view.getUint32(at + 4, true),
        data = at + 8;
      if (data + length > bytes.length)
        throw new Error("This WebP image is invalid.");
      if (
        ["ANIM", "ANMF"].includes(type) ||
        (type === "VP8X" && bytes[data] & 2)
      )
        throw new Error(
          "Animated images are not supported. Choose a static image.",
        );
      if (type === "VP8X" && length >= 10)
        size = dimensions(
          1 +
            bytes[data + 4] +
            (bytes[data + 5] << 8) +
            (bytes[data + 6] << 16),
          1 +
            bytes[data + 7] +
            (bytes[data + 8] << 8) +
            (bytes[data + 9] << 16),
        );
      else if (
        !size &&
        type === "VP8L" &&
        length >= 5 &&
        bytes[data] === 0x2f
      ) {
        const bits = view.getUint32(data + 1, true);
        size = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      } else if (
        !size &&
        type === "VP8 " &&
        length >= 10 &&
        bytes[data + 3] === 0x9d &&
        bytes[data + 4] === 1 &&
        bytes[data + 5] === 0x2a
      )
        size = dimensions(
          view.getUint16(data + 6, true) & 0x3fff,
          view.getUint16(data + 8, true) & 0x3fff,
        );
      at = data + length + (length % 2);
    }
    if (size) return size;
    throw new Error("This WebP image is invalid.");
  }
  throw new Error("Choose a static PNG, JPEG, or WebP image.");
}

const canvasPngChunks = new Set([
  "IHDR",
  "PLTE",
  "tRNS",
  "IDAT",
  "IEND",
  "sRGB",
  "gAMA",
  "cHRM",
  "pHYs",
]);
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
/** Only for our own sRGB canvas output, never received or imported PNG bytes. */
export function stripCanvasPngMetadata(bytes: Uint8Array): Uint8Array {
  const invalid = () => new Error("Could not normalize this image.");
  if (
    bytes.length < 45 ||
    bytes.length > 1024 * 1024 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  )
    throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let total = 8,
    count = 0,
    ended = false,
    dataStarted = false,
    dataEnded = false;
  for (let at = 8; at < bytes.length; ) {
    if (++count > 4096 || ended || at + 12 > bytes.length) throw invalid();
    const length = view.getUint32(at),
      end = at + 8 + length;
    if (end + 4 > bytes.length) throw invalid();
    const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (
      !/^[A-Za-z]{4}$/.test(kind) ||
      bytes[at + 6] & 32 ||
      (count === 1 && kind !== "IHDR") ||
      ["acTL", "fcTL", "fdAT"].includes(kind)
    )
      throw invalid();
    let crc = 0xffffffff;
    for (let index = at + 4; index < end; index++)
      crc = pngCrcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
    if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(end)) throw invalid();
    if (kind === "IDAT") {
      if (dataEnded) throw invalid();
      dataStarted = true;
    } else if (dataStarted) dataEnded = true;
    if (canvasPngChunks.has(kind)) {
      parts.push(bytes.subarray(at, end + 4));
      total += length + 12;
    } else if (!(bytes[at + 4] & 32)) throw invalid(); // Unknown critical data must never be discarded.
    if (kind === "IEND") {
      if (length !== 0 || end + 4 !== bytes.length) throw invalid();
      ended = true;
    }
    at = end + 4;
  }
  if (!ended) throw invalid();
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  // Oversized valid canvas output is retried at a smaller size by the caller.
  if (output.length <= CUSTOM_EMOJI_MAX_BYTES) validateCustomPng(output);
  return output;
}

export async function prepareCustomEmoji(
  file: File,
  name: string,
): Promise<CustomEmoji> {
  if (file.size > INPUT_BYTES)
    throw new Error("Choose an image no larger than 5 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer()),
    mime = photoSourceMime(bytes),
    expected = emojiSourceDimensions(bytes, mime),
    source = mime === "image/jpeg" ? jpegSource(bytes).bytes : bytes;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([source as BlobPart], { type: mime }),
    );
  } catch {
    throw new Error(
      "This browser could not decode this image. Export it as a standard JPEG or PNG and try again.",
    );
  }
  try {
    const sameDimensions =
      bitmap.width === expected.width && bitmap.height === expected.height;
    // Browser decoding applies a phone JPEG's EXIF rotation before drawing.
    const orientedJpeg =
      mime === "image/jpeg" &&
      bitmap.width === expected.height &&
      bitmap.height === expected.width;
    if (!sameDimensions && !orientedJpeg)
      throw new Error("This image has inconsistent dimensions.");
    for (const limit of [128, 96, 64, 48]) {
      const ratio = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const context = canvas.getContext("2d", { colorSpace: "srgb" });
      if (!context)
        throw new Error("Image processing is unavailable in this browser.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(new Error("Could not process this image.")),
          "image/png",
        ),
      );
      const png = stripCanvasPngMetadata(
        new Uint8Array(await blob.arrayBuffer()),
      );
      if (png.length <= CUSTOM_EMOJI_MAX_BYTES) {
        validateCustomPng(png);
        return (await customReaction(name, png)) as CustomEmoji;
      }
    }
    throw new Error("This image could not fit the custom emoji size limit.");
  } finally {
    bitmap.close();
  }
}

export async function validateCustomEmojiPixels(item: CustomEmoji) {
  const bytes = base64ToBytes(item.custom.png),
    expected = validateCustomPng(bytes);
  const bitmap = await createImageBitmap(
    new Blob([bytes as BlobPart], { type: "image/png" }),
  );
  try {
    if (bitmap.width !== expected.width || bitmap.height !== expected.height)
      throw new Error("This custom emoji has inconsistent dimensions.");
  } finally {
    bitmap.close();
  }
}
