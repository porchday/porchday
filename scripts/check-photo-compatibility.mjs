/** Real browser JPEG decoder/upload regression check. Uses synthetic fixtures only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputFlag = process.argv.indexOf("--output-dir");
const outputDirectory = outputFlag < 0 ? null : resolve(process.argv[outputFlag + 1]);
if (outputDirectory) await mkdir(outputDirectory, { recursive: true });
const fixtures = JSON.parse(await readFile(
  new URL("../apps/web/test/fixtures/jpeg-variants.json", import.meta.url), "utf8",
)).fixtures;
for (const fixture of fixtures) {
  assert.equal(createHash("sha256").update(Buffer.from(fixture.base64, "base64")).digest("hex"), fixture.sha256);
}
const bundle = await build({
  stdin: {
    contents: `
      import { preparePhoto } from './apps/web/src/Social';
      import { jpegDimensions } from './apps/web/src/photo-safety';
      import { prepareCustomEmoji } from './apps/web/src/emoji-images';
      globalThis.photoCheck = { preparePhoto, jpegDimensions, prepareCustomEmoji };
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
});
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/check.js" ? "text/javascript" : "text/html");
  response.setHeader("Cache-Control", "no-store");
  response.end(request.url === "/check.js" ? bundle.outputFiles[0].contents : '<!doctype html><script src="/check.js"></script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.route("**/*", route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
      const page = await context.newPage();
      await page.goto(origin);
      const result = await page.evaluate(async fixtures => {
        const { preparePhoto, jpegDimensions, prepareCustomEmoji } = globalThis.photoCheck;
        const require = (condition, message) => { if (!condition) throw new Error(message); };
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const sourceBytes = fixture => Uint8Array.from(atob(fixture.base64), c => c.charCodeAt(0));
        const getPixels = async blob => {
          const bitmap = await createImageBitmap(blob);
          try {
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext("2d");
            context.drawImage(bitmap, 0, 0);
            const samples = [[.25, .25], [.75, .25], [.25, .75], [.75, .75]].map(([x, y]) =>
              Array.from(context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data).slice(0, 3));
            return { width: bitmap.width, height: bitmap.height, samples };
          } finally { bitmap.close(); }
        };
        const metadataMarkers = bytes => {
          const found = [];
          let offset = 2;
          while (offset < bytes.length) {
            require(bytes[offset++] === 0xff, "Output marker boundary invalid");
            while (bytes[offset] === 0xff) offset++;
            const marker = bytes[offset++];
            if (marker === 0xd9) return found;
            if (marker >= 0xe0 && marker <= 0xef || marker === 0xfe) found.push(marker);
            const length = (bytes[offset] << 8) | bytes[offset + 1];
            require(length >= 2, "Output marker length invalid");
            offset += length;
            if (marker === 0xda) {
              while (offset < bytes.length) {
                if (bytes[offset] !== 0xff) { offset++; continue; }
                const next = bytes[offset + 1];
                if (next === 0 || next >= 0xd0 && next <= 0xd7) { offset += 2; continue; }
                if (next === 0xff) { offset++; continue; }
                break;
              }
            }
          }
          throw new Error("Output lacks EOI");
        };
        const rows = [];
        for (const fixture of fixtures) {
          const bytes = sourceBytes(fixture);
          const file = new File([bytes], `${fixture.name}.jpg`, { type: "image/jpeg" });
          let native;
          try { native = await getPixels(file); } catch { native = null; }
          const browserDependent = ["arithmetic", "lossless", "twelve-bit"].includes(fixture.name);
          require(native || browserDependent, `${fixture.name}: required native decoding failed`);
          let prepared;
          try { prepared = await preparePhoto(file); } catch (error) {
            require(!native && browserDependent, `${fixture.name}: browser can decode but upload failed: ${error.message}`);
            require(/browser|decode|convert|export/i.test(error.message), `${fixture.name}: unsupported format needs an actionable error`);
            rows.push({ fixture: fixture.name, outcome: "browser cannot decode; useful error" });
            continue;
          }
          require(native, `${fixture.name}: upload unexpectedly succeeded without native decode`);
          const output = new Uint8Array(await prepared.blob.arrayBuffer());
          const dimensions = jpegDimensions(output);
          const expected = fixture.name === "exif-rotated" ? { width: 24, height: 32 } : { width: 32, height: 24 };
          require(same(dimensions, expected), `${fixture.name}: wrong normalized dimensions/orientation`);
          require(prepared.width === expected.width && prepared.height === expected.height, `${fixture.name}: reported dimensions differ`);
          require(metadataMarkers(output).length === 0, `${fixture.name}: output retained APP/COM metadata`);
          require(!new TextDecoder("latin1").decode(output).includes("PORCHDAY_SYNTHETIC"), `${fixture.name}: source metadata survived`);
          const normalized = await getPixels(prepared.blob);
          native.samples.forEach((sample, index) => sample.forEach((channel, color) => {
            require(Math.abs(channel - normalized.samples[index][color]) < 30, `${fixture.name}: primary-image pixel/color changed unexpectedly`);
          }));
          rows.push({ fixture: fixture.name, outcome: "normalized", width: prepared.width, height: prepared.height,
            outputBase64: btoa(String.fromCharCode(...output)) });
        }
        const baseline = sourceBytes(fixtures.find(fixture => fixture.name === "baseline"));
        for (const mime of ["", "image/jpg", "image/pjpeg", "application/octet-stream", "image/png"]) {
          const prepared = await preparePhoto(new File([baseline], "photo.jfif", { type: mime }));
          require(same(jpegDimensions(new Uint8Array(await prepared.blob.arrayBuffer())), { width: 32, height: 24 }), `JPEG MIME alias ${mime} failed`);
        }
        const reduced = await preparePhoto(new File([baseline], "photo.jpg"), 16);
        require(reduced.width === 16 && reduced.height === 12, "Thumbnail downscaling failed");
        // A complete primary JPEG plus camera padding exercises the inclusive
        // byte boundary without allocating a huge decoded image.
        const maximumSource = new Uint8Array(50 * 1024 * 1024);
        maximumSource.set(baseline);
        const maximumPrepared = await preparePhoto(new File([maximumSource], "maximum.jpg", { type: "image/jpeg" }));
        require(same(jpegDimensions(new Uint8Array(await maximumPrepared.blob.arrayBuffer())), { width: 32, height: 24 }), "Exactly 50 MiB must be accepted and normalized");
        for (const name of ["baseline", "exif-rotated", "mpf-multipicture"]) {
          const fixture = fixtures.find(fixture => fixture.name === name);
          const emoji = await prepareCustomEmoji(new File([sourceBytes(fixture)], "emoji.jfif"), "jpeg_fixture");
          require(emoji, `${name}: shared emoji JPEG importer failed`);
        }
        // Oversize rejection must happen before native decoding allocates pixels.
        const originalDecoder = globalThis.createImageBitmap;
        let decoderCalls = 0;
        globalThis.createImageBitmap = () => { decoderCalls++; throw new Error("Decoder must not be reached"); };
        try {
          for (const [bytes, upload, expected] of [
            [new Uint8Array(50 * 1024 * 1024 + 1), file => preparePhoto(file), /50 MB/],
            [new Uint8Array(5 * 1024 * 1024 + 1), file => prepareCustomEmoji(file, "oversized"), /5 MB/],
          ]) {
            let rejected = false;
            try { await upload(new File([bytes], "oversized.jpg", { type: "image/jpeg" })); }
            catch (error) { require(expected.test(error.message), "Incorrect byte-limit error"); rejected = true; }
            require(rejected, "Byte-limit input unexpectedly accepted");
          }
          // Mutate only dimensions of a real JPEG to exercise predecode guards.
          for (const [size, upload, expected] of [
            [7000, file => preparePhoto(file), /40.megapixel/],
            [5000, file => prepareCustomEmoji(file, "oversized"), /16 megapixels/],
          ]) {
            const bytes = baseline.slice();
            const frame = bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === 0xc0);
            require(frame > 0, "Baseline fixture lacks SOF0");
            bytes[frame + 5] = bytes[frame + 7] = size >> 8;
            bytes[frame + 6] = bytes[frame + 8] = size & 255;
            let rejected = false;
            try { await upload(new File([bytes], "oversized.jpg", { type: "image/jpeg" })); }
            catch (error) { require(expected.test(error.message), `Incorrect pixel-limit error: ${error.message}`); rejected = true; }
            require(rejected, "Pixel-limit input unexpectedly accepted");
          }
          require(decoderCalls === 0, "Oversized input reached native decoder");
        } finally { globalThis.createImageBitmap = originalDecoder; }
        return { rows, aliasChecks: 5, downscaleChecks: 1, inclusive50MiBChecks: 1, emojiChecks: 3, predecodeLimitChecks: 4 };
      }, fixtures);
      for (const row of result.rows) {
        if (row.outputBase64 && outputDirectory) {
          await writeFile(resolve(outputDirectory, `${name}-${row.fixture}.jpg`), Buffer.from(row.outputBase64, "base64"));
        }
        delete row.outputBase64;
      }
      console.log(JSON.stringify({ browser: name, version: browser.version(), ...result }, null, 2));
      await context.close();
    } finally { await browser.close(); }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
