// Deterministic rasterization of the repository-owned sunrise mark. No remote assets.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL("../public/", import.meta.url));
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(kind, data) {
  const name = Buffer.from(kind),
    out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}
function distance(x, y, a, b, c, d) {
  const t = Math.max(
    0,
    Math.min(
      1,
      ((x - a) * (c - a) + (y - b) * (d - b)) / ((c - a) ** 2 + (d - b) ** 2),
    ),
  );
  return Math.hypot(x - a - t * (c - a), y - b - t * (d - b));
}
const lines = [
  [43, 128, 149, 128],
  [63, 148, 129, 148],
  [96, 29, 96, 42],
  [43, 51, 53, 61],
  [149, 51, 139, 61],
  [24, 97, 38, 97],
  [154, 97, 168, 97],
];
for (const size of [180, 192, 512, 1024]) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      for (let sy = 0; sy < 3; sy++)
        for (let sx = 0; sx < 3; sx++) {
          const px = ((x + (sx + 0.5) / 3) * 192) / size,
            py = ((y + (sy + 0.5) / 3) * 192) / size;
          const arc =
            py <= 109 && Math.abs(Math.hypot(px - 96, py - 109) - 49) <= 4.5;
          const ends =
            Math.hypot(px - 47, py - 109) <= 4.5 ||
            Math.hypot(px - 145, py - 109) <= 4.5;
          if (arc || ends || lines.some((l) => distance(px, py, ...l) <= 4.5))
            coverage++;
        }
      const a = coverage / 9;
      [36, 78, 67].forEach(
        (c, k) =>
          (raw[row + 1 + x * 4 + k] = Math.round(
            c + ([246, 243, 234][k] - c) * a,
          )),
      );
      raw[row + 1 + x * 4 + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(
    dir + (size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`),
    png,
  );
}
