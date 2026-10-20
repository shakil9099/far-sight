// `npm run screenshots`: drives the real windows through their states and saves PNGs
// to ./screenshots for visual review. Uses a throwaway userData directory.
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "../shared/engine";
import type { Settings } from "../shared/types";
import type { ToastKind } from "./windows";

interface Ctx {
  command: (name: string, ...args: unknown[]) => unknown;
  openBreakWindows: () => void;
  closeBreakWindows: () => void;
  showToast: (kind: ToastKind, payload: unknown, ms?: number) => void;
  showCountdown: () => void;
  openSettings: (tab?: string) => void;
  togglePopover: () => void;
  engine: Engine;
  settings: Settings;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = join(process.cwd(), "screenshots");

async function capture(name: string, match: (w: BrowserWindow) => boolean): Promise<void> {
  await wait(900);
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && match(w));
  if (!win) {
    console.log(`[screenshots] no window for ${name}`);
    return;
  }
  const img = await win.webContents.capturePage();
  writeFileSync(join(out, `${name}.png`), img.toPNG());
  console.log(`[screenshots] ${name}.png ${img.getSize().width}x${img.getSize().height}`);
}

const byPage = (page: string) => (w: BrowserWindow) => w.webContents.getURL().includes(page);

export async function runScreenshots(ctx: Ctx): Promise<void> {
  mkdirSync(out, { recursive: true });
  ctx.command("setSettings", { hasCompletedOnboarding: true });

  ctx.openSettings("welcome");
  await capture("settings-welcome", byPage("settings.html"));
  for (const tab of ["general", "breaks", "smart-pause", "wellness", "appearance", "schedule", "stats", "automation", "about"]) {
    const win = BrowserWindow.getAllWindows().find(byPage("settings.html"))!;
    win.webContents.send("open-tab", tab);
    await capture(`settings-${tab}`, byPage("settings.html"));
  }
  BrowserWindow.getAllWindows().find(byPage("settings.html"))?.close();

  ctx.togglePopover();
  await capture("popover-now", byPage("popover.html"));
  BrowserWindow.getAllWindows().find(byPage("popover.html"))?.webContents.send("open-tab", "stats");
  await capture("popover-stats", byPage("popover.html"));
  BrowserWindow.getAllWindows().find(byPage("popover.html"))?.hide();

  ctx.showToast("notice", { icon: "zzz", text: "No snoozes left!" });
  await capture("toast-notice", byPage("kind=notice"));
  ctx.showToast("heads-up", { secondsLeft: 60, isLong: false });
  await capture("toast-heads-up", byPage("kind=heads-up"));
  ctx.showToast("returned", { awaySec: 480, mode: "reset" });
  await capture("toast-returned", byPage("kind=returned"));
  ctx.showToast("paused", { reason: "meeting", detail: "Zoom" });
  await capture("toast-paused", byPage("kind=paused"));
  ctx.showToast("wellness", { kind: "blink" });
  await capture("toast-blink", byPage("kind=wellness"));
  ctx.showToast("wellness", { kind: "posture" });
  await capture("toast-posture", byPage("kind=wellness"));

  ctx.showCountdown();
  await capture("countdown", byPage("countdown.html"));

  ctx.command("startBreak", "short");
  await wait(1500);
  await capture("break-short", byPage("primary=1"));
  ctx.command("snooze", 60);
  ctx.command("setSettings", { breakBackground: "gradient", gradient: 3 });
  ctx.command("startBreak", "long");
  await wait(1500);
  await capture("break-long", byPage("primary=1"));
  ctx.command("skip");

  await wait(300);
  app.exit(0);
}
