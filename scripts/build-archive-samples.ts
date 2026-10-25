/** Regenerate only the checked-in synthetic examples, never a member export. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { zipSync, unzipSync } from "fflate";
import { packArchive, type PortableArchive } from "../apps/web/src/archive.ts";

const base = new URL("../docs/archive/sample/", import.meta.url);
const manifest: PortableArchive = JSON.parse(await readFile(new URL("archive.json", base), "utf8"));
if (manifest.handle !== "synthetic_neighbor" || manifest.member_id !== "11111111-1111-4111-8111-111111111111")
  throw new Error("This builder accepts the checked-in fictional fixture only.");
const photos: Record<string, Uint8Array> = {};
for (const photo of manifest.media)
  photos[photo.path] = await readFile(new URL(photo.path, base));

function deterministicZip(part: PortableArchive, files: Record<string, Uint8Array>) {
  // Keep the actual producer's contents; normalize ZIP timestamps only so a
  // regenerated example has stable bytes across runs and local time zones.
  const packed = unzipSync(packArchive(part, files));
  return { packed, zip: zipSync(packed, { level: 5, mtime: new Date(2026, 0, 1, 12, 0, 0) }) };
}
const single = deterministicZip(manifest, photos);
await writeFile(new URL("porchday-synthetic.zip", base), single.zip);
await writeFile(new URL("index.html", base), single.packed["index.html"]);
await mkdir(fileURLToPath(new URL("multipart/", base)), { recursive: true });
const setId = "99999999-9999-4999-8999-999999999999";
const first: PortableArchive = {
  ...manifest,
  archive_set: { id: setId, index: 1, total: null },
  media: [],
};
const last: PortableArchive = {
  ...manifest,
  archive_set: { id: setId, index: 2, total: 2, complete: true },
  profile: null, posts: [], comments: [], reactions: [], connections: [], groups: [],
};
for (const [part, files] of [[first, {}], [last, photos]] as const) {
  const index = String(part.archive_set!.index).padStart(3, "0");
  await writeFile(new URL(`multipart/porchday-synthetic-${index}.zip`, base), deterministicZip(part, files).zip);
}
console.log("Rebuilt one standalone and two multipart synthetic archive files.");
