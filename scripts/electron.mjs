// Launches Electron with ELECTRON_RUN_AS_NODE removed. Terminals inside VS Code
// (itself an Electron app) export that variable, which would make Electron run as plain Node.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import electron from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Harmless macOS noise from the unsigned development Electron binary.
const NOISE = [/sandbox_extension_issue_file failed/];

const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "pipe"], env });
createInterface({ input: child.stderr }).on("line", (line) => {
  if (!NOISE.some((re) => re.test(line))) process.stderr.write(line + "\n");
});
console.log("FarSight is running — look for the eye icon in your menu bar / system tray. Press Ctrl+C to quit.");
child.on("exit", (code) => process.exit(code ?? 0));
