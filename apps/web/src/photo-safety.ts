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
