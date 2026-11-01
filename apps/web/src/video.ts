import { validatedPhoto } from "./photo-safety";
export const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";
export function isVideo(mime: unknown): mime is string {
  return mime === "video/mp4" || mime === "video/quicktime" || mime === "video/webm";
}
/** Detect containers from bytes, never trust a filename or supplied MIME. */
export function videoMime(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > MAX_VIDEO_BYTES)
    throw Error("Choose a video up to 10 MiB.");
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 16 && ascii(4, 8) === "ftyp") {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 16 && size <= bytes.length && size <= 4096) {
      const brands = [ascii(8, 12)];
      for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(i, i + 4));
      if (brands.includes("qt  ")) return "video/quicktime";
      if (brands.some(b => /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(b))) return "video/mp4";
    }
  }
  // EBML header plus the WebM DocType element (not arbitrary Matroska).
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    for (let i = 4; i < Math.min(bytes.length - 6, 4096); i++)
      if (bytes[i] === 0x42 && bytes[i+1] === 0x82 && bytes[i+2] === 0x84 && ascii(i+3, i+7) === "webm") return "video/webm";
  }
  throw Error("Choose an MP4, MOV or WebM video supported by your browser.");
}
export async function validatedVideo(bytes: Uint8Array) {
  const mime = videoMime(bytes);
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const video = document.createElement("video");
  const url = URL.createObjectURL(blob);
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(Error("Video preview timed out. Try a shorter clip.")), 15000);
      function finish(error?: Error) {
        clearTimeout(timeout); video.onloadeddata = null; video.onerror = null;
        error ? reject(error) : resolve();
      }
      video.onloadeddata = () => finish();
      video.onerror = () => finish(Error("This browser cannot play this video. Try an MP4 with H.264 video."));
      video.src = url;
    });
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height || width * height > 3840 * 2160 || Number.isNaN(video.duration) || video.duration <= 0)
      throw Error("Choose a playable video up to 4K resolution.");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 320 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw Error("Video preview is unavailable.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const poster = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
    return { blob, mime, width, height, poster };
  } finally {
    video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
  }
}
export async function validatedMedia(bytes: Uint8Array, mime: string) {
  if (mime === "image/jpeg") return { ...(await validatedPhoto(bytes)), mime };
  if (!isVideo(mime)) throw Error("Unsupported media format.");
  const media = await validatedVideo(bytes);
  if (media.mime !== mime) throw Error("Video format does not match its encrypted metadata.");
  return media;
}
export async function prepareVideo(file: File) {
  if (file.size > MAX_VIDEO_BYTES) throw Error("Choose a video up to 10 MiB.");
  const result = await validatedVideo(new Uint8Array(await file.arrayBuffer()));
  return { ...result, preview: URL.createObjectURL(result.blob) };
}
