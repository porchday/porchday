import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { versionPwaIcons } from "../scripts/pwa-icons";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "porchday-icons-"));
  directories.push(directory);
  for (const file of ["manifest.webmanifest", "icon-192.png", "icon-512.png"])
    copyFileSync(join("apps/web/public", file), join(directory, file));
  return directory;
}

describe("installed PWA icon updates", () => {
  it("changes icon URLs while preserving app identity, icon metadata and legacy bytes", () => {
    const directory = fixture();
    const original = JSON.parse(readFileSync(join(directory, "manifest.webmanifest"), "utf8"));
    const aliases = original.icons.map((icon: { src: string }) => readFileSync(join(directory, icon.src.slice(1))));
    const paths = versionPwaIcons(directory);
    const updated = JSON.parse(readFileSync(join(directory, "manifest.webmanifest"), "utf8"));
    expect(updated).toEqual({ ...original, icons: original.icons.map((icon: object, index: number) => ({ ...icon, src: paths[index] })) });
    expect(updated.id).toBe("/app");
    expect(updated.start_url).toBe("/app");
    expect(updated.scope).toBe("/");
    for (const [index, path] of paths.entries()) {
      expect(path).toMatch(/^\/icon-(192|512)-[a-f0-9]{16}\.png$/);
      expect(path).not.toBe(original.icons[index].src);
      expect(readFileSync(join(directory, path.slice(1)))).toEqual(aliases[index]);
      expect(readFileSync(join(directory, original.icons[index].src.slice(1)))).toEqual(aliases[index]);
      expect(path).toContain(createHash("sha256").update(aliases[index]).digest("hex").slice(0, 16));
    }
    expect(versionPwaIcons(fixture())).toEqual(paths);
  });
  it("refuses unexpected or duplicate icon sources instead of copying arbitrary paths", () => {
    for (const src of ["/icon-512.png", "../../private.png", "https://elsewhere.test/icon.png"]) {
      const directory = fixture();
      const manifest = JSON.parse(readFileSync(join(directory, "manifest.webmanifest"), "utf8"));
      manifest.icons[0].src = src;
      writeFileSync(join(directory, "manifest.webmanifest"), JSON.stringify(manifest));
      expect(() => versionPwaIcons(directory)).toThrow(/Unexpected/);
    }
  });
});
