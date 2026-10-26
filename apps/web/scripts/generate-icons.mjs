// Rasterize the shared, repository-owned corn mark for browsers, PWA and iOS.
// Uses the project's Playwright Chromium; no network access or remote assets.
import { chromium } from "playwright";
import PathKitInit from "pathkit-wasm";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
const publicDir = new URL("../public/", import.meta.url);
const iosAssets = new URL("../../ios/Porchday/Assets.xcassets/", import.meta.url);
const svg = await readFile(new URL("icon.svg", publicDir), "utf8");
// Resolve husk cutouts into ordinary vector outlines, avoiding a rasterized mask.
const PathKit = await PathKitInit({
  wasmBinary: await readFile(new URL(import.meta.resolve("pathkit-wasm/bin/pathkit.wasm"))),
});
const paths = [...svg.matchAll(/<path\b([^>]+)\/>/g)];
const shape = PathKit.NewPath();
for (const [index, [, attributes]] of paths.entries()) {
  const path = PathKit.FromSVGString(attributes.match(/d="([^"]+)"/)[1]);
  const width = attributes.match(/stroke-width="([^"]+)"/);
  if (width) path.stroke({ width: Number(width[1]), cap: PathKit.StrokeCap.ROUND, join: PathKit.StrokeJoin.ROUND });
  if (!shape.op(path, index < 5 ? PathKit.PathOp.UNION : PathKit.PathOp.DIFFERENCE)) {
    throw new Error("Could not resolve corn outline");
  }
  path.delete();
}
const transform = svg.match(/<g transform="([^"]+)"/)[1];
await writeFile(new URL("logo.svg", publicDir), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 12 168 168">
  <path fill="#974013" transform="${transform}" d="${shape.toSVGString()}"/>
</svg>
`);
shape.delete();
const browser = await chromium.launch({ headless: true });
try {
  for (const size of [180, 192, 512, 1024]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.route("**/*", route => route.abort());
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    const output = new URL(size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`, publicDir);
    await writeFile(output, await page.screenshot({ type: "png", omitBackground: false }));
    await page.close();
  }
  await copyFile(new URL("icon-1024.png", publicDir), new URL("AppIcon.appiconset/icon-1024.png", iosAssets));
  const mark = new URL("PorchdayMark.imageset/", iosAssets);
  await mkdir(mark, { recursive: true });
  await copyFile(new URL("icon-512.png", publicDir), new URL("corn.png", mark));
  await writeFile(new URL("Contents.json", mark), JSON.stringify({
    images: [{ filename: "corn.png", idiom: "universal" }],
    info: { author: "xcode", version: 1 },
  }, null, 2) + "\n");
} finally {
  await browser.close();
}
