import { defineConfig } from "vite";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
export default defineConfig({
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787" } },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("openpgp")) return "encryption";
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
      closeBundle() {
        const dist = resolve(import.meta.dirname, "dist");
        const assets = readdirSync(resolve(dist, "assets"))
          .filter((name) => /\.(js|css)$/.test(name))
          .map((name) => "/assets/" + name);
        const shell = [
          "/",
          "/icon.svg",
          "/icon-192.png",
          "/icon-512.png",
          "/apple-touch-icon.png",
          "/manifest.webmanifest",
          "/fonts.css",
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
