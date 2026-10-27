// File-picker hints only. Actual uploads are identified by their file signature.
export const PHOTO_ACCEPT =
  "image/jpeg,image/pjpeg,image/jpg,image/mpo,.jpg,.jpeg,.jpe,.jfif,.jif,.jfi,.mpo,image/png,image/webp";
export const PHOTO_SOURCE_MAX_BYTES = 50 * 1024 * 1024;

export function photoSourceMime(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    return "image/png";
  if (
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  throw new Error("Choose a JPEG, PNG, or WebP photo.");
}

/**
 * Upload-only preflight: bound the primary image before native decoding. Camera
 * JPEGs may append previews, depth maps or gain maps; those are never decoded or
 * uploaded. EXIF orientation and color profiles stay until pixels are rendered.
 * This intentionally does not replace validation of received/archive photos.
 */
export function jpegSource(bytes: Uint8Array) {
  return primaryJpeg(bytes, false);
}

function primaryJpeg(bytes: Uint8Array, stripMetadata: boolean) {
  const invalid = () =>
    new Error(
      "This JPEG could not be read. Try exporting it as a standard JPEG or PNG.",
    );
  if (bytes.length > PHOTO_SOURCE_MAX_BYTES)
    throw new Error("Each source photo must be 50 MB or smaller.");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw invalid();
  let offset = 2,
    markers = 0,
    scan = false,
    keptStart = 0;
  let frame: { width: number; height: number } | null = null;
  const parts: Uint8Array[] = [];
  while (offset < bytes.length) {
    const markerStart = offset;
    if (++markers > 4096 || bytes[offset++] !== 0xff) throw invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scan) throw invalid();
      parts.push(bytes.subarray(keptStart, offset));
      const primary = new Uint8Array(
        parts.reduce((total, part) => total + part.length, 0),
      );
      let at = 0;
      for (const part of parts) {
        primary.set(part, at);
        at += part.length;
      }
      return { ...frame, bytes: primary };
    }
    if (marker === 0x01) continue; // Standalone arithmetic-coding marker.
    // Deferred dimensions and hierarchical/multiple frames cannot be bounded
    // from one primary frame header, so do not pass them to a native decoder.
    if (
      [0x00, 0xd8, 0xdc, 0xde, 0xdf].includes(marker) ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > bytes.length
    )
      throw invalid();
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw invalid();
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      const precision = bytes[offset + 2],
        lossless = marker === 0xc3 || marker === 0xcb;
      if (
        frame ||
        ![0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb].includes(marker) ||
        length < 11 ||
        (marker === 0xc0
          ? precision !== 8
          : lossless
            ? precision < 2 || precision > 16
            : ![8, 12].includes(precision))
      )
        throw invalid();
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4],
        width = (bytes[offset + 5] << 8) | bytes[offset + 6],
        components = bytes[offset + 7];
      if (components < 1 || components > 4 || length !== 8 + components * 3)
        throw invalid();
      if (!width || !height || width * height > 40_000_000)
        throw new Error("This photo exceeds the 40-megapixel safety limit.");
      frame = { width, height };
    }
    // MPF offsets describe auxiliary images removed below. Do not expose a
    // dangling multi-image directory to the decoder; retain ICC APP2 segments.
    const mpf =
      marker === 0xe2 &&
      length >= 6 &&
      bytes[offset + 2] === 0x4d &&
      bytes[offset + 3] === 0x50 &&
      bytes[offset + 4] === 0x46 &&
      bytes[offset + 5] === 0;
    if (
      mpf ||
      (stripMetadata && ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe))
    ) {
      parts.push(bytes.subarray(keptStart, markerStart));
      keptStart = offset + length;
    }
    offset += length;
    if (marker === 0xda) {
      if (!frame) throw invalid();
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const start = offset++;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset];
        if (next === 0 || next === 1 || (next >= 0xd0 && next <= 0xd7)) {
          offset++;
          continue;
        }
        offset = start;
        break;
      }
    }
  }
  throw invalid();
}

/** Only our own sRGB canvas output; never normalize received image bytes. */
export function stripCanvasJpegMetadata(bytes: Uint8Array) {
  jpegDimensions(bytes);
  return primaryJpeg(bytes, true).bytes;
}

/** Validate the JPEG frame before handing untrusted decrypted bytes to a decoder. */
export function jpegDimensions(bytes: Uint8Array, maxDimension = 2400) {
  const invalid = () => new Error("This photo is not a supported JPEG image.");
  if (bytes.length > 20 * 1024 * 1024)
    throw new Error("This photo exceeds the 20 MB safety limit.");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw invalid();
  let offset = 2;
  let frame: { width: number; height: number } | null = null;
  let scan = false;
  let markers = 0;
  while (offset < bytes.length) {
    if (++markers > 4096 || bytes[offset++] !== 0xff) throw invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scan || offset !== bytes.length) throw invalid();
      return frame;
    }
    // Embedded frames, deferred dimensions, and hierarchical JPEGs are unsupported.
    if (
      [0x00, 0xd8, 0xdc, 0xde, 0xdf].includes(marker) ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > bytes.length
    )
      throw invalid();
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw invalid();
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (
        frame ||
        ![0xc0, 0xc1, 0xc2].includes(marker) ||
        length < 11 ||
        bytes[offset + 2] !== 8
      )
        throw invalid();
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const components = bytes[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + components * 3)
        throw invalid();
      if (
        !width ||
        !height ||
        width > maxDimension ||
        height > maxDimension ||
        width * height > 40_000_000
      )
        throw new Error("This photo exceeds the safe dimensions.");
      frame = { width, height };
    }
    offset += length;
    if (marker === 0xda) {
      if (!frame) throw invalid();
      scan = true;
      // Skip bounded entropy-coded bytes, preserving the next real marker.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const start = offset++;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
          offset++;
          continue;
        }
        offset = start;
        break;
      }
    }
  }
  throw invalid();
}

export async function validatedPhoto(bytes: Uint8Array) {
  const dimensions = jpegDimensions(bytes);
  const blob = new Blob([bytes as BlobPart], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  try {
    // A decoder/header disagreement is malformed input, never a reason to trust it.
    if (
      bitmap.width !== dimensions.width ||
      bitmap.height !== dimensions.height
    )
      throw new Error("This photo has inconsistent dimensions.");
  } finally {
    bitmap.close();
  }
  return { blob, ...dimensions };
}
