import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Chrome treats installed icon URLs as immutable. Change URLs when bytes change. */
export function versionPwaIcons(directory: string): string[] {
  const manifestPath = join(directory, "manifest.webmanifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expected = new Set(["/icon-192.png", "/icon-512.png"]);
  if (!Array.isArray(manifest.icons) || manifest.icons.length !== expected.size)
    throw new Error("Expected both Porchday install icons.");
  const paths: string[] = [];
  for (const icon of manifest.icons) {
    if (!expected.delete(icon.src))
      throw new Error("Unexpected Porchday install icon source.");
    const bytes = readFileSync(join(directory, icon.src.slice(1)));
    const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const path = icon.src.replace(/\.png$/, `-${version}.png`);
    // Keep the original public aliases for existing clients and notifications.
    writeFileSync(join(directory, path.slice(1)), bytes);
    icon.src = path;
    paths.push(path);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest) + "\n");
  return paths;
}
