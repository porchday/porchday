import { defineConfig } from "vite";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
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
        const assets = readdirSync(resolve(dist, "assets"))
          .filter((name) => /\.(js|css)$/.test(name))
          .map((name) => "/assets/" + name);
        const shell = [
          "/",
          "/icon.svg",
          "/logo.svg",
          "/porch-pattern.svg",
          "/wallpaper-checker.svg",
          "/wallpaper-daisies.svg",
          "/wallpaper-diamonds.svg",
          "/icon-192.png",
          "/icon-512.png",
          "/apple-touch-icon.png",
          "/manifest.webmanifest",
          "/fonts.css",
          "/third-party-notices.txt",
          `/${openpgpFile}`,
          ...assets,
        ];
        let sw = readFileSync(resolve(dist, "sw.js"), "utf8");
        const hash = createHash("sha256").update(sw);
        for (const path of [...shell].sort()) {
          hash.update(path);
          hash.update(
            readFileSync(
              resolve(dist, path === "/" ? "index.html" : path.slice(1)),
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
