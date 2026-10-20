// Compiles the macOS CoreAudio microphone helper (universal arm64 + x86_64).
// On other platforms this is a no-op: Windows detects microphone use via the registry.
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "native/mac-mic.c");
const out = join(root, "build/bin/farsight-mic");

if (process.platform === "darwin") {
  if (!existsSync(out) || statSync(out).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(join(root, "build/bin"), { recursive: true });
    execFileSync("clang", ["-O2", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0", "-framework", "CoreAudio", "-framework", "IOKit", "-framework", "CoreFoundation", "-o", out, src], {
      stdio: "inherit",
    });
    console.log("built build/bin/farsight-mic");
  }
} else if (!existsSync(out)) {
  console.log("skipping macOS mic helper (not on macOS)");
}
