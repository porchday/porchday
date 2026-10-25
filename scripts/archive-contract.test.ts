import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { encryptArchive, decryptArchive, randomSecret } from "@porchday/crypto";
import {
  unpackArchive, packArchive, validateSet, eligibleEntries, checksum,
  preservedPhotoDeadline, type PortableArchive,
} from "../apps/web/src/archive.ts";
import { jpegDimensions } from "../apps/web/src/photo-safety.ts";
import type { ArchiveEncryption, ArchiveManifestV1 } from "../docs/archive/importer.ts";

const directory = new URL("../docs/archive/", import.meta.url);
const fixture = (path: string) => new Uint8Array(readFileSync(new URL(`sample/${path}`, directory)));
const schema = JSON.parse(readFileSync(new URL("archive-v1.schema.json", directory), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<ArchiveManifestV1>(schema);
const single = unpackArchive(fixture("porchday-synthetic.zip"));
const parts = [1, 2].map(n => unpackArchive(fixture(`multipart/porchday-synthetic-00${n}.zip`)));
const cryptoInterface: ArchiveEncryption = { encryptArchive, decryptArchive };

describe("portable archive contract and fictional examples", () => {
  it("validates standalone and both multipart manifests with Draft2020-12 formats enabled", () => {
    expect(ajv.validateSchema(schema), JSON.stringify(ajv.errors)).toBe(true);
    for (const part of [single, ...parts])
      expect(validate(part.archive), JSON.stringify(validate.errors)).toBe(true);
    expect(single.archive).toEqual(JSON.parse(readFileSync(new URL("sample/archive.json", directory), "utf8")));
    expect(() => validateSet([single.archive])).not.toThrow();
  });

  it("rejects unsupported versions, incomplete metadata, malformed UTC dates and unsafe photo paths", () => {
    const mutations: ((a: PortableArchive) => void)[] = [
      a => { a.version = 2 as never; },
      a => { Reflect.deleteProperty(a, "groups"); },
      a => { a.member_id = "not-a-uuid"; },
      a => { a.posts[0].created_at = "2026-99-01T10:00:00.000Z"; },
      a => { a.posts[0].created_at = "2026-01-01T10:00:00+00:00"; },
      a => { a.media[0].path = "../photo.jpg"; },
      a => { a.media[0].sha256 = "bad"; },
      a => { a.media[0].width = 2401; },
      a => { a.connections[0].kind = "influencer"; },
      a => { a.archive_set = { id: "set", index: 1, total: null, complete: true }; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(single.archive); mutate(changed);
      expect(validate(changed)).toBe(false);
    }
    const additive = structuredClone(single.archive);
    additive.posts[0].payload.future_optional_field = { note: "inert data" };
    expect(validate(additive)).toBe(true);
    expect(unpackArchive(packArchive(additive, single.files)).archive.posts[0].payload.future_optional_field)
      .toEqual({ note: "inert data" });
  });

  it("matches exact synthetic JPEG bytes, dimensions and the documented optional native name field", async () => {
    for (const part of [single, ...parts]) {
      for (const photo of part.archive.media) {
        expect(photo.path).toBe(`photos/${photo.id}.jpg`);
        const bytes = part.files[photo.path];
        expect(bytes).toBeDefined();
        expect(await checksum(bytes)).toBe(photo.sha256);
        expect(jpegDimensions(bytes)).toEqual({ width: photo.width, height: photo.height });
        const altered = bytes.slice(); altered[altered.length - 1] ^= 1;
        expect(await checksum(altered)).not.toBe(photo.sha256);
      }
    }
    const nativeShaped = structuredClone(single.archive);
    delete nativeShaped.media[0].name;
    nativeShaped.posts[0].payload.provenance = { member_id: single.archive.member_id, source_id: single.archive.posts[0].id };
    expect(validate(nativeShaped), JSON.stringify(validate.errors)).toBe(true);
    expect(unpackArchive(packArchive(nativeShaped, single.files)).archive.media[0]).not.toHaveProperty("name");
  });

  it("preserves the complete set including cross-part photos and rejects missing or mixed parts", () => {
    expect(() => validateSet(parts.map(p => p.archive))).not.toThrow();
    expect(parts[0].archive.media).toEqual([]);
    const referenced = parts[0].archive.posts[0].payload.media[0].id;
    expect(parts[1].archive.media[0].id).toBe(referenced);
    for (const section of ["posts", "comments", "reactions", "media", "connections", "groups"])
      expect(parts.flatMap(p => p.archive[section])).toEqual(single.archive[section]);
    expect(parts.map(p => p.archive.profile).filter(Boolean)).toEqual([single.archive.profile]);
    expect(() => validateSet([parts[0].archive])).toThrow(/completion/);
    const wrongOwner = structuredClone(parts[1].archive);
    wrongOwner.member_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(() => validateSet([parts[0].archive, wrongOwner])).toThrow(/different source accounts/);
    const html = strFromU8(parts[1].files["index.html"]);
    expect(html).toContain("index-part-001.html");
    expect(html).toContain("index-part-002.html");
    for (const [index, part] of parts.entries())
      expect(JSON.parse(strFromU8(part.files[`archive-part-00${index + 1}.json`]))).toEqual(part.archive);
  });

  it("skips the historical expired comment and never extends a shorter photo deadline", () => {
    const now = Date.parse("2026-10-25T00:00:00.000Z");
    const entries = eligibleEntries(parts.map(p => p.archive), now);
    expect(entries.map(e => e.journal_kind)).toEqual(["post", "reaction"]);
    expect(single.archive.comments[0].parent_id).toBe("88888888-8888-4888-8888-888888888888");
    const photoDeadline = "2026-10-25T01:00:00.000Z";
    const postDeadline = "2026-10-26T00:00:00.000Z";
    expect(preservedPhotoDeadline(photoDeadline, postDeadline, now)).toBe(photoDeadline);
    expect(() => preservedPhotoDeadline(single.archive.comments[0].expires_at, null, now)).toThrow(/expired/);
  });

  it("wraps the same portable bytes with an independent ephemeral secret, without adding identity proof", async () => {
    const original = fixture("porchday-synthetic.zip");
    const wrapped = await cryptoInterface.encryptArchive(original);
    expect(wrapped.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const decrypted = await cryptoInterface.decryptArchive(wrapped.ciphertext, wrapped.secret);
    expect(decrypted).toEqual(original);
    expect(validate(unpackArchive(decrypted).archive)).toBe(true);
    await expect(cryptoInterface.decryptArchive(wrapped.ciphertext, randomSecret())).rejects.toThrow();
    const tampered = wrapped.ciphertext.slice(); tampered[tampered.length - 1] ^= 1;
    await expect(cryptoInterface.decryptArchive(tampered, wrapped.secret)).rejects.toThrow();
    // A portable plaintext manifest deliberately has no service identity signature.
    expect(single.archive).not.toHaveProperty("signature");
    expect(single.archive).not.toHaveProperty("encryptedPrivateKey");
    expect(single.archive).not.toHaveProperty("recoverySecret");
  });

  it("keeps checked-in HTML aligned with the producer and typechecks documented crypto/API interfaces", () => {
    expect(readFileSync(new URL("sample/index.html", directory), "utf8"))
      .toBe(strFromU8(unzipSync(packArchive(single.archive, single.files))["index.html"]));
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      "-p", fileURLToPath(new URL("tsconfig.json", directory)),
    ], { stdio: "pipe", timeout: 20_000 });
  });
});
