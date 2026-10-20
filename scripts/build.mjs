// Bundles the UI pages with esbuild into dist/renderer (Tauri's frontendDist).
// `--release` minifies and drops source maps.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src/renderer");
const out = join(root, "dist/renderer");
const release = process.argv.includes("--release");

// Modules imported by pages, not pages themselves.
const SHARED = new Set(["api.ts", "icons.ts", "gauge.ts"]);

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: readdirSync(src)
    .filter((f) => f.endsWith(".ts") && !SHARED.has(f))
    .map((f) => join(src, f)),
  outdir: out,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: release,
  sourcemap: release ? false : "inline",
  logLevel: "info",
});

for (const f of readdirSync(src)) {
  if (f.endsWith(".html") || f.endsWith(".css")) cpSync(join(src, f), join(out, f));
}
cpSync(join(src, "fonts"), join(out, "fonts"), { recursive: true });
