import { defineConfig } from "vite";
import {buildSync} from "esbuild";
import { readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { versionPwaIcons } from "./scripts/pwa-icons";
import { buildDarkCss, SOURCES as DARK_SOURCES } from "./scripts/dark-css";
const cryptoRequire = createRequire(
  resolve(import.meta.dirname, "../../packages/crypto/package.json"),
);
const openpgpDistribution = resolve(
  dirname(cryptoRequire.resolve("openpgp")),
  "..",
);
const openpgpBytes = readFileSync(
  resolve(openpgpDistribution, "openpgp.min.mjs"),
);
const openpgpDirectory = `assets/openpgp-${createHash("sha256").update(openpgpBytes).digest("hex").slice(0, 16)}`;
const openpgpFile = `${openpgpDirectory}/openpgp.min.mjs`;
const sourceDirectory = resolve(import.meta.dirname, "src");
const darkCssId = "\0virtual:dark.css";
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      external: ["openpgp"],
      output: {
        paths: { openpgp: `/${openpgpFile}` },
        manualChunks(id) {
          if (id.includes("react-dom") || id.includes("/react/"))
            return "react";
        },
      },
    },
  },
  esbuild: { legalComments: "none" },
  plugins: [
    {
      // Generated from the light stylesheets on every dev load and build.
      name: "porchday-dark-css",
      resolveId(id) {
        if (id === "virtual:dark.css") return darkCssId;
      },
      load(id) {
        if (id !== darkCssId) return;
        for (const name of DARK_SOURCES)
          this.addWatchFile(resolve(sourceDirectory, name));
        return buildDarkCss(sourceDirectory);
      },
      handleHotUpdate({ file, server }) {
        if (!DARK_SOURCES.some((name) => file === resolve(sourceDirectory, name)))
          return;
        const dark = server.moduleGraph.getModuleById(darkCssId);
        if (dark) server.reloadModule(dark);
      },
    },
    {
      name: "porchday-private-safe-shell",
      generateBundle() {
        // Preserve the exact upstream browser module, notices and source map.
        // It remains replaceable independently from the application adapter.
        this.emitFile({
          type: "asset",
          fileName: openpgpFile,
          source: openpgpBytes,
        });
        this.emitFile({
          type: "asset",
          fileName: `${openpgpDirectory}/openpgp.min.mjs.map`,
          source: readFileSync(
            resolve(openpgpDistribution, "openpgp.min.mjs.map"),
          ),
        });
      },
      closeBundle() {
        const dist = resolve(import.meta.dirname, "dist");
        const htmlPath = resolve(dist, "index.html");
        const html = readFileSync(htmlPath, "utf8");
        const buildId = createHash("sha256").update(html).digest("hex").slice(0, 24);
        writeFileSync(htmlPath, html.replace("</head>", `<meta name="porchday-build" content="${buildId}"></head>`));
        // A same-origin public shell still works when the old homepage redirects.
        copyFileSync(resolve(dist, "index.html"), resolve(dist, "app-shell.html"));
        const installIcons = versionPwaIcons(dist);
        const previewWorker=buildSync({entryPoints:[resolve(sourceDirectory,"notification-preview-sw.ts")],bundle:true,format:"iife",platform:"browser",minify:true,write:false}).outputFiles[0].contents;
        const previewWorkerName=`assets/notification-preview-${createHash("sha256").update(previewWorker).digest("hex").slice(0,16)}.js`;
        writeFileSync(resolve(dist,previewWorkerName),previewWorker);
        const videoWorker=buildSync({entryPoints:[resolve(sourceDirectory,"video-sw.ts")],bundle:true,format:"iife",platform:"browser",minify:true,write:false}).outputFiles[0].contents;
        const videoWorkerName=`assets/video-playback-${createHash("sha256").update(videoWorker).digest("hex").slice(0,16)}.js`;
        writeFileSync(resolve(dist,videoWorkerName),videoWorker);
        const assets = readdirSync(resolve(dist, "assets"))
          .filter((name) => /\.(js|css)$/.test(name))
          .map((name) => "/assets/" + name);
        const shell = [
          "/app-shell",
          "/color-scheme.js",
          "/icon.svg",
          "/logo.svg",
          "/porch-pattern.svg",
          "/wallpaper-checker.svg",
          "/wallpaper-daisies.svg",
          "/wallpaper-diamonds.svg",
          "/icon-192.png",
          "/icon-512.png",
          ...installIcons,
          "/apple-touch-icon.png",
          "/manifest.webmanifest",
          "/fonts.css",
          "/third-party-notices.txt",
          `/${openpgpFile}`,
          ...assets,
        ];
        let sw = `importScripts("/${videoWorkerName}","/${previewWorkerName}");\n` + readFileSync(resolve(dist, "sw.js"), "utf8");
        const hash = createHash("sha256").update(sw);
        for (const path of [...shell].sort()) {
          hash.update(path);
          hash.update(
            readFileSync(
              resolve(dist, path === "/app-shell" ? "app-shell.html" : path.slice(1)),
            ),
          );
        }
        const version = hash.digest("hex").slice(0, 24);
        sw = sw
          .replace(
            /const CACHE = ["']porchday-shell-v1["'];/,
            `const CACHE = 'porchday-shell-${version}';`,
          )
          .replace(
            /const SHELL = \[[^;]+;/,
            `const SHELL = ${JSON.stringify(shell)};`,
          );
        writeFileSync(resolve(dist, "sw.js"), sw);
      },
    },
  ],
});
