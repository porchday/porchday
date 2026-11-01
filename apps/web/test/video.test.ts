import { describe, it, expect } from "vitest";
import { videoMime, MAX_VIDEO_BYTES, isVideo } from "../src/video";
import { validMediaPath, archiveMediaHtml, packArchive, unpackArchive, emptyArchive, checksum } from "../src/archive";
const mp4 = (brand: string) => new Uint8Array([0,0,0,20,...new TextEncoder().encode("ftyp" + brand),0,0,0,0,...new TextEncoder().encode(brand)]);
describe("video container and archive boundaries", () => {
  it("detects supported containers from bytes", () => {
    expect(videoMime(mp4("isom"))).toBe("video/mp4");
    expect(videoMime(mp4("qt  "))).toBe("video/quicktime");
    expect(videoMime(new Uint8Array([0x1a,0x45,0xdf,0xa3,0x42,0x82,0x84,119,101,98,109]))).toBe("video/webm");
  });
  it("rejects oversize, empty, invalid and image-only containers", () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(MAX_VIDEO_BYTES+1), mp4("avif"), mp4("heic"), new TextEncoder().encode("not a video"), mp4("isom").slice(0,18)])
      expect(() => videoMime(bytes)).toThrow();
    expect(isVideo("text/html")).toBe(false);
  });
  it("binds archive extension to MIME and rejects traversal", () => {
    expect(validMediaPath("photos/abc.mp4", "video/mp4")).toBe(true);
    expect(validMediaPath("photos/abc.mov", "video/quicktime")).toBe(true);
    expect(validMediaPath("photos/abc.webm", "video/webm")).toBe(true);
    expect(validMediaPath("photos/abc.jpg", "image/jpeg")).toBe(true);
    expect(validMediaPath("photos/abc.jpg", "video/mp4")).toBe(false);
    expect(validMediaPath("photos/../abc.mp4", "video/mp4")).toBe(false);
    expect(validMediaPath("photos/abc.html", "text/html")).toBe(false);
  });
});

it("roundtrips video archives and renders a safe playable local video", async () => {
  const data = mp4("isom"), manifest = emptyArchive("member", "test");
  manifest.media.push({ id: "clip", path: "photos/clip.mp4", mime: "video/mp4", sha256: await checksum(data) });
  const restored = unpackArchive(packArchive(manifest, { "photos/clip.mp4": data }));
  expect(restored.files["photos/clip.mp4"]).toEqual(data);
  const html = archiveMediaHtml({ id: "clip", mime: "video/mp4", alt: '<script>bad</script>' });
  expect(html).toContain('<video src="photos/clip.mp4" controls');
  expect(html).not.toContain('<script>');
  expect(archiveMediaHtml({id:'../clip', mime:'video/mp4'})).toBe("");
});
