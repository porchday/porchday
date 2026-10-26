import { crc32, deflateSync } from "node:zlib";
import { customReaction } from "@porchday/crypto/reactions";
import type { CustomEmoji } from "../src/emoji-library";

export function pngChunk(type: string, data: Uint8Array) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
export function tinyPng(color = 1, width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      raw[offset] = color;
      raw[offset + 3] = 128;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}
export async function custom(color = 1, name = "my_image") {
  return (await customReaction(name, tinyPng(color))) as CustomEmoji;
}
