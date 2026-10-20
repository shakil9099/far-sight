// Bundles main, preload and renderer code with esbuild and copies static assets into dist/.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "renderer"), { recursive: true });

const common = { bundle: true, sourcemap: "inline", logLevel: "info", target: "es2023" };

await build({
  ...common,
  entryPoints: [join(root, "src/main/main.ts")],
  outfile: join(dist, "main/main.js"),
  platform: "node",
  format: "cjs",
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: [join(root, "src/preload/preload.ts")],
  outfile: join(dist, "preload/preload.js"),
  platform: "node",
  format: "cjs",
  external: ["electron"],
});

const pages = readdirSync(join(root, "src/renderer"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(root, "src/renderer", f));

await build({
  ...common,
  entryPoints: pages,
  outdir: join(dist, "renderer"),
  platform: "browser",
  format: "iife",
});

for (const f of readdirSync(join(root, "src/renderer"))) {
  if (f.endsWith(".html") || f.endsWith(".css")) {
    cpSync(join(root, "src/renderer", f), join(dist, "renderer", f));
  }
}
cpSync(join(root, "src/renderer/fonts"), join(dist, "renderer/fonts"), { recursive: true });
cpSync(join(root, "build/tray"), join(dist, "tray"), { recursive: true });

if (watch) console.log("watch mode not implemented; rerun npm run build");
