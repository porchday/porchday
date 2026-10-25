// Rasterize the shared, repository-owned corn mark for browsers, PWA and iOS.
// Uses the project's Playwright Chromium; no network access or remote assets.
import { chromium } from "playwright";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
const publicDir = new URL("../public/", import.meta.url);
const iosAssets = new URL("../../ios/Porchday/Assets.xcassets/", import.meta.url);
const svg = await readFile(new URL("icon.svg", publicDir), "utf8");
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
