import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { join } from "node:path";
import { Engine, type EngineEvent, type EngineState, type TickContext } from "../shared/engine";
import { mergeSettings } from "../shared/defaults";
import { formatClock, formatDuration } from "../shared/messages";
import { StatsBook } from "../shared/stats";
import type { DayStats, PauseReason, Settings } from "../shared/types";
import { ActivityMonitor, listRunningApps } from "./activity";
import { detectSmartPause, detectVideo, isQuietReason } from "./smartpause";
import { isOutsideOfficeHours, lockScreen, runAutomation } from "./platform";
import { JsonStore } from "./store";
import {
  createAudioWindow,
  createBreakWindow,
  createCountdownWindow,
  createPopoverWindow,
  createSettingsWindow,
  createToastWindow,
  placePopover,
  type ToastKind,
} from "./windows";

const isMac = process.platform === "darwin";
const SCREENSHOT_MODE = process.argv.includes("--screenshots");

// The hidden audio window plays break sounds without any user gesture.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

if (SCREENSHOT_MODE) app.setPath("userData", join(app.getPath("temp"), `farsight-screenshots-${process.pid}`));
else if (!app.requestSingleInstanceLock()) app.quit();

// ------------------------------------------------------------------ state

const settingsStore = new JsonStore<Partial<Settings>>("settings");
const engineStore = new JsonStore<EngineState>("timer-state");
const statsStore = new JsonStore<Record<string, DayStats>>("stats");

let settings: Settings;
let engine: Engine;
let stats: StatsBook;
const activity = new ActivityMonitor();

let tray: Tray | null = null;
let settingsWin: BrowserWindow | null = null;
let audioWin: BrowserWindow | null = null;
let countdownWin: BrowserWindow | null = null;
let popoverWin: BrowserWindow | null = null;
let popoverMenuOpen = false;
const breakWins = new Map<number, BrowserWindow>();
const toasts = new Map<ToastKind, BrowserWindow>();

let screenLocked = false;
let suspended = false;
let tickTimer: NodeJS.Timeout | null = null;
let followTimer: NodeJS.Timeout | null = null;

// ------------------------------------------------------------------ helpers

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

/** True while on a call or watching a video: FarSight stays silent and shows nothing. */
function isQuiet(): boolean {
  return isQuietReason(engine.snapshot().pause?.reason);
}

const REMINDER_SOUNDS = new Set(["nudge", "blink", "posture", "return"]);

function play(sound: string, volume?: number): void {
  if (!audioWin || audioWin.isDestroyed()) return;
  if (REMINDER_SOUNDS.has(sound) && isQuiet()) return;
  audioWin.webContents.send("sound", { sound, pair: settings.soundPair, volume });
}

function smartPause(): TickContext["smartPause"] {
  return detectSmartPause(activity.sample(), settings);
}

const PAUSE_TEXT: Record<PauseReason, string> = {
  manual: "Paused",
  idle: "Paused while you're away",
  "screen-locked": "Paused while your screen is locked",
  "deep-focus": "Paused for your focus app",
  meeting: "Paused for your meeting",
  fullscreen: "Paused while a fullscreen app is active",
  video: "Paused while you watch a video",
  "office-hours": "Outside office hours",
  suspended: "Paused while asleep",
};

function statusLine(): string {
  const snap = engine.snapshot();
  switch (snap.status) {
    case "stopped":
      return "FarSight is stopped";
    case "break":
      return `On a break · ${formatClock(snap.currentBreak!.duration - snap.currentBreak!.elapsed)} left`;
    case "paused": {
      const p = snap.pause!;
      const base = p.detail ? `${PAUSE_TEXT[p.reason]} (${p.detail})` : PAUSE_TEXT[p.reason];
      return p.until ? `${base} · resumes in ${formatDuration((p.until - Date.now()) / 1000)}` : base;
    }
    case "working":
      return `${snap.nextBreakIsLong ? "Long break" : "Break"} in ${formatDuration(snap.remaining)}`;
  }
}

// ------------------------------------------------------------------ tray

function trayIcon(): Electron.NativeImage {
  const dir = join(__dirname, "../tray");
  if (isMac) {
    const img = nativeImage.createFromPath(join(dir, "trayTemplate.png"));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(join(dir, nativeTheme.shouldUseDarkColors ? "tray-light.png" : "tray-dark.png"));
}

function updateTray(): void {
  if (!tray) return;
  const snap = engine.snapshot();
  const text =
    snap.status === "working"
      ? formatClock(snap.remaining)
      : snap.status === "break"
        ? formatClock(snap.currentBreak!.duration - snap.currentBreak!.elapsed)
        : snap.status === "paused"
          ? "❚❚"
          : "";
  if (isMac) tray.setTitle(settings.menuBarDisplay === "icon" ? "" : ` ${text}`, { fontType: "monospacedDigit" });
  tray.setToolTip(`FarSight — ${statusLine()}`);
}

function buildMenu(): Menu {
  const snap = engine.snapshot();
  const summary = stats.summary(Date.now(), settings.workDuration);
  const stopped = snap.status === "stopped";
  const onBreak = snap.status === "break";
  const items: MenuItemConstructorOptions[] = [
    { label: statusLine(), enabled: false },
    { type: "separator" },
    {
      label: "Start break now",
      enabled: !stopped && !onBreak,
      submenu: [
        { label: "Short break", click: () => command("startBreak", "short") },
        { label: "Long break", click: () => command("startBreak", "long") },
        { type: "separator" },
        ...[1, 2, 5, 10, 15, 30].map((m) => ({ label: `Custom · ${m} min`, click: () => command("startBreak", "custom", m * 60) })),
      ],
    },
    {
      label: "Snooze next break",
      enabled: snap.canSnooze && !stopped,
      submenu: [60, 300, 900].map((s) => ({ label: `+ ${s / 60} min`, click: () => command("snooze", s) })),
    },
    {
      label: onBreak ? "Skip this break" : `Skip next break (${Math.max(0, settings.advanceSkipsPerDay - snap.advanceSkipsToday)} left today)`,
      enabled: snap.canSkip,
      click: () => command("skip"),
    },
    snap.status === "paused" && snap.pause?.reason === "manual"
      ? { label: "Resume", click: () => command("resume") }
      : {
          label: "Pause",
          enabled: !stopped && !onBreak,
          submenu: [
            ...[15, 30, 60, 120].map((m) => ({ label: `For ${formatDuration(m * 60)}`, click: () => command("pause", m * 60) })),
            { label: "Until I resume", click: () => command("pause", null) },
          ],
        },
    { label: "Restart timers", enabled: !stopped, click: () => command("restart") },
    stopped ? { label: "Start FarSight", click: () => command("start") } : { label: "Stop FarSight", click: () => command("stop") },
    { type: "separator" },
    { label: `Screen score: ${summary.score ?? "—"}  ·  ${formatDuration(summary.today.screenTimeSec)} today`, click: () => openSettings("stats") },
    { label: "Settings…", accelerator: "CommandOrControl+,", click: () => openSettings() },
    { type: "separator" },
    { label: "Quit FarSight", accelerator: "CommandOrControl+Q", click: () => app.quit() },
  ];
  return Menu.buildFromTemplate(items);
}

function pauseMenu(): Menu {
  return Menu.buildFromTemplate([
    ...[15, 30, 60, 120].map((m) => ({ label: `Pause for ${formatDuration(m * 60)}`, click: () => command("pause", m * 60) })),
    { label: "Until I resume", click: () => command("pause", null) },
  ]);
}

function customBreakMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "Long break now", click: () => command("startBreak", "long") },
    { type: "separator" },
    ...[1, 2, 5, 10, 15, 30].map((m) => ({ label: `Custom break · ${m} min`, click: () => command("startBreak", "custom", m * 60) })),
  ]);
}

function togglePopover(): void {
  if (popoverWin && !popoverWin.isDestroyed() && popoverWin.isVisible()) {
    popoverWin.hide();
    return;
  }
  if (!popoverWin || popoverWin.isDestroyed()) {
    popoverWin = createPopoverWindow();
    popoverWin.on("blur", () => {
      // Keep it open while one of its own native menus is showing.
      if (popoverMenuOpen) return;
      popoverWin?.hide();
    });
    popoverWin.once("ready-to-show", () => {
      if (tray) placePopover(popoverWin!, tray.getBounds());
      popoverWin?.show();
      popoverWin?.focus();
    });
    return;
  }
  if (tray) placePopover(popoverWin, tray.getBounds());
  popoverWin.show();
  popoverWin.focus();
}

function popupFromPopover(menu: Menu): void {
  if (!popoverWin || popoverWin.isDestroyed()) return;
  popoverMenuOpen = true;
  menu.popup({ window: popoverWin, callback: () => (popoverMenuOpen = false) });
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.on("click", togglePopover);
  tray.on("right-click", () => tray?.popUpContextMenu(buildMenu()));
  updateTray();
  nativeTheme.on("updated", () => tray?.setImage(trayIcon()));
}

// ------------------------------------------------------------------ windows

function openSettings(tab?: string): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (tab) settingsWin.webContents.send("open-tab", tab);
    return;
  }
  if (isMac) app.dock?.show();
  settingsWin = createSettingsWindow(tab);
  settingsWin.on("closed", () => {
    settingsWin = null;
    if (isMac) app.dock?.hide();
  });
}

function showToast(kind: ToastKind, payload: unknown, autoCloseMs?: number): void {
  // Nothing automatic pops up during calls or videos; replies to the user's own clicks still show.
  if (isQuiet() && kind !== "notice") return;
  closeToast(kind);
  const win = createToastWindow(kind, payload, kind === "wellness" ? settings.reminderPosition : "top-right");
  toasts.set(kind, win);
  win.on("closed", () => toasts.get(kind) === win && toasts.delete(kind));
  if (autoCloseMs) setTimeout(() => !win.isDestroyed() && win.close(), autoCloseMs);
}

function closeToast(kind: ToastKind): void {
  const w = toasts.get(kind);
  if (w && !w.isDestroyed()) w.close();
  toasts.delete(kind);
}

function showCountdown(): void {
  if (countdownWin && !countdownWin.isDestroyed()) return;
  countdownWin = createCountdownWindow();
  countdownWin.once("ready-to-show", () => countdownWin?.showInactive());
  const follow = () => {
    if (!countdownWin || countdownWin.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    countdownWin.setPosition(p.x + 18, p.y + 22);
  };
  follow();
  followTimer = setInterval(follow, 50);
}

function hideCountdown(): void {
  if (followTimer) clearInterval(followTimer);
  followTimer = null;
  if (countdownWin && !countdownWin.isDestroyed()) countdownWin.close();
  countdownWin = null;
}

function openBreakWindows(): void {
  closeBreakWindows();
  const primary = screen.getPrimaryDisplay();
  for (const d of screen.getAllDisplays()) {
    const w = createBreakWindow(d, settings, d.id === primary.id);
    breakWins.set(d.id, w);
    if (settings.disciplineLevel === "hardcore") {
      w.on("blur", () => engine.snapshot().status === "break" && !w.isDestroyed() && d.id === primary.id && w.focus());
    }
  }
}

function closeBreakWindows(): void {
  for (const w of breakWins.values()) if (!w.isDestroyed()) w.destroy();
  breakWins.clear();
}

// ------------------------------------------------------------------ engine events

function handle(events: EngineEvent[]): void {
  const now = Date.now();
  for (const ev of events) {
    switch (ev.type) {
      case "focus-tick":
        if (settings.statsEnabled) stats.addFocus(now, ev.seconds);
        break;
      case "session-end":
        if (settings.statsEnabled) stats.endSession(now, ev.lengthSec);
        break;
      case "heads-up":
        showToast("heads-up", { secondsLeft: ev.secondsLeft, isLong: ev.isLong });
        if (settings.reminderSoundsEnabled) play("nudge", settings.reminderVolume);
        break;
      case "countdown":
        showCountdown();
        break;
      case "break-start":
        hideCountdown();
        closeToast("heads-up");
        openBreakWindows();
        play("start");
        if (settings.lockOnBreak) setTimeout(() => engine.snapshot().status === "break" && lockScreen(), 5000);
        for (const a of settings.automations) if (a.enabled && a.trigger === "break-start") void runAutomation(a);
        break;
      case "break-complete":
        play("end");
        break;
      case "break-end":
        closeBreakWindows();
        if (ev.result === "completed") {
          if (!settings.holdBreakUntilEnded) play("end");
          if (settings.statsEnabled && (ev.info.kind === "short" || ev.info.kind === "long")) stats.breakTaken(now);
        } else if (ev.result === "skipped" && settings.statsEnabled) stats.breakSkipped(now);
        for (const a of settings.automations) if (a.enabled && a.trigger === "break-end") void runAutomation(a);
        break;
      case "skipped-in-advance":
        hideCountdown();
        closeToast("heads-up");
        if (settings.statsEnabled) stats.breakSkipped(now);
        break;
      case "snoozed":
        hideCountdown();
        closeToast("heads-up");
        if (settings.statsEnabled) stats.snoozed(now);
        break;
      case "returned":
        if (ev.mode === "reset" && settings.statsEnabled) stats.naturalBreak(now);
        if (settings.showReturnNotice && ev.awaySec >= 60) {
          showToast("returned", { awaySec: ev.awaySec, mode: ev.mode }, 10_000);
          if (settings.reminderSoundsEnabled) play("return", settings.reminderVolume);
        }
        break;
      case "paused":
        if (isQuietReason(ev.reason)) {
          // Calls and videos: clear anything on screen and stay silent.
          hideCountdown();
          for (const k of ["heads-up", "wellness", "returned", "paused"] as const) closeToast(k);
        } else if (ev.reason === "deep-focus" || ev.reason === "fullscreen") {
          hideCountdown();
          closeToast("heads-up");
          showToast("paused", { reason: ev.reason, detail: ev.detail }, 6000);
        }
        break;
      case "wellness":
        showToast("wellness", { kind: ev.kind }, 6000);
        if (settings.reminderSoundsEnabled) play(ev.kind, settings.reminderVolume);
        break;
      case "resumed":
      case "day-rollover":
        break;
    }
  }
  if (events.length) {
    engineStore.writeSoon(() => engine.serialize(), 2000);
    statsStore.writeSoon(() => stats.days, 10_000);
  }
}

let lastTickAt: number | null = null;

function tick(): void {
  const now = Date.now();
  const dt = lastTickAt == null ? 0 : Math.min(5, Math.max(0, (now - lastTickAt) / 1000));
  lastTickAt = now;

  const sample = activity.sample();
  const video = detectVideo(sample, settings);
  const pause = smartPause();
  // On a call or watching a video there's no keyboard/mouse input, but the user is still at
  // the screen: don't let idle detection pause/reset the session (or count it as a break).
  const engaged = isQuietReason(pause?.reason) || (video != null && !settings.videoPauseEnabled);
  const ctx: TickContext = {
    idleSec: engaged ? 0 : powerMonitor.getSystemIdleTime(),
    screenLocked,
    suspended,
    outsideOfficeHours: isOutsideOfficeHours(settings, new Date(now)),
    smartPause: pause,
  };
  handle(engine.tick(now, ctx));
  const snap = engine.snapshot();
  if (process.env.FARSIGHT_DEBUG) {
    console.log(
      `[tick] ${snap.status}${snap.pause ? `/${snap.pause.reason}` : ""} work=${snap.workElapsed.toFixed(1)} front=${sample.frontApp} video=${JSON.stringify(sample.videoApps)} idle=${ctx.idleSec}`,
    );
  }
  if (video && settings.statsEnabled && snap.status !== "stopped" && !screenLocked && !suspended && dt > 0) {
    stats.addVideo(now, dt, video);
    statsStore.writeSoon(() => stats.days, 10_000);
  }
  if (snap.status !== "working") hideCountdown();
  broadcast("state", snap);
  updateTray();
}

// ------------------------------------------------------------------ commands (tray, IPC, shortcuts)

function command(name: string, ...args: unknown[]): unknown {
  const now = Date.now();
  switch (name) {
    case "getState":
      return engine.snapshot();
    case "getSettings":
      return settings;
    case "getStats":
      return stats.summary(now, settings.workDuration);
    case "getPlatform":
      return { platform: process.platform, version: app.getVersion() };
    case "setSettings": {
      settings = mergeSettings({ ...settings, ...(args[0] as Partial<Settings>) });
      settingsStore.writeNow(settings);
      engine.updateSettings(settings);
      applySystemSettings();
      broadcast("settings", settings);
      return settings;
    }
    case "resetSettings":
      settings = mergeSettings({ hasCompletedOnboarding: true });
      settingsStore.writeNow(settings);
      engine.updateSettings(settings);
      applySystemSettings();
      broadcast("settings", settings);
      return settings;
    case "startBreak":
      handle(engine.startBreak(args[0] as "short" | "long" | "custom", now, args[1] as number | undefined));
      break;
    case "snooze":
      if (!engine.canSnooze()) {
        showToast("notice", { icon: "zzz", text: settings.disciplineLevel === "hardcore" ? "Snoozing is off in Hardcore" : "No snoozes left!" }, 2500);
        break;
      }
      handle(engine.snooze(args[0] as number));
      break;
    case "openSettings":
      popoverWin?.hide();
      openSettings(args[0] as string | undefined);
      break;
    case "popupPauseMenu":
      popupFromPopover(pauseMenu());
      break;
    case "popupCustomMenu":
      popupFromPopover(customBreakMenu());
      break;
    case "skip":
      handle(engine.skip());
      break;
    case "endBreak":
      handle(engine.endBreak());
      break;
    case "pause":
      handle(engine.pause(now, args[0] as number | null));
      break;
    case "resume":
      handle(engine.resume());
      break;
    case "restart":
      handle(engine.restart());
      break;
    case "stop":
      handle(engine.stop());
      break;
    case "start":
      handle(engine.resume());
      break;
    case "undoReturn":
      engine.undoReturnReset();
      closeToast("returned");
      break;
    case "closeToast":
      closeToast(args[0] as ToastKind);
      break;
    case "listApps":
      return listRunningApps();
    case "pickImage":
      return dialog
        .showOpenDialog({ properties: ["openFile"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] })
        .then((r) => (r.canceled ? null : r.filePaths[0]));
    case "previewWellness":
      handle([{ type: "wellness", kind: args[0] as "blink" | "posture" }]);
      break;
    case "previewSound":
      play(args[0] as string);
      break;
    case "testAutomation":
      return runAutomation({ id: "test", name: "test", trigger: "break-start", command: String(args[0]), enabled: true });
    case "openExternal":
      void shell.openExternal(String(args[0]));
      break;
    case "quit":
      app.quit();
      break;
    default:
      throw new Error(`unknown command ${name}`);
  }
  tick();
  return engine.snapshot();
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  const bind = (accel: string, fn: () => void) => {
    if (!accel) return;
    try {
      globalShortcut.register(accel, fn);
    } catch (err) {
      console.warn(`could not register shortcut ${accel}`, err);
    }
  };
  bind(settings.shortcuts.startBreak, () => command("startBreak", "short"));
  bind(settings.shortcuts.togglePause, () =>
    engine.snapshot().status === "paused" ? command("resume") : command("pause", null),
  );
  bind(settings.shortcuts.snooze, () => command("snooze", 300));
  bind(settings.shortcuts.skip, () => command("skip"));
}

function applySystemSettings(): void {
  if (!SCREENSHOT_MODE && app.isPackaged && app.getLoginItemSettings().openAtLogin !== settings.launchAtLogin) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  }
  registerShortcuts();
}

// ------------------------------------------------------------------ boot

// Launching FarSight again (e.g. from Finder/Start menu) reveals the panel — handy when the
// menu-bar icon is hidden behind a MacBook notch.
app.on("second-instance", () => togglePopover());
app.on("window-all-closed", () => {
  /* keep running in the tray */
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  activity.stop();
  try {
    engineStore.writeNow(engine.serialize());
    statsStore.writeNow(stats.days);
  } catch {
    /* best effort */
  }
});

app.whenReady().then(async () => {
  if (isMac) app.dock?.hide();
  app.setAppUserModelId("app.farsight.desktop");
  // FarSight's UI is designed dark; keep native vibrancy and controls consistent with it.
  nativeTheme.themeSource = "dark";

  settings = mergeSettings(settingsStore.read());
  stats = new StatsBook(statsStore.read());
  stats.prune(Date.now());
  engine = new Engine(settings, Date.now(), engineStore.read());

  ipcMain.handle("cmd", (_e, name: string, args: unknown[]) => command(name, ...(args ?? [])));

  if (SCREENSHOT_MODE) {
    const { runScreenshots } = await import("./screenshots");
    // Seed a sample day so the Stats views have data to draw.
    stats.addFocus(Date.now(), 3 * 3600);
    stats.endSession(Date.now(), 1200);
    stats.endSession(Date.now(), 2400);
    for (let i = 0; i < 6; i++) stats.breakTaken(Date.now());
    stats.breakSkipped(Date.now());
    stats.breakSkipped(Date.now());
    stats.addVideo(Date.now(), 47 * 60, "Brave Browser");
    stats.addVideo(Date.now(), 12 * 60, "VLC");
    createTray();
    await runScreenshots({ command, openBreakWindows, closeBreakWindows, showToast, showCountdown, openSettings, togglePopover, engine, settings });
    return;
  }

  powerMonitor.on("lock-screen", () => (screenLocked = true));
  powerMonitor.on("unlock-screen", () => (screenLocked = false));
  powerMonitor.on("suspend", () => (suspended = true));
  powerMonitor.on("resume", () => (suspended = false));
  screen.on("display-added", () => engine.snapshot().status === "break" && openBreakWindows());
  screen.on("display-removed", () => engine.snapshot().status === "break" && openBreakWindows());

  audioWin = createAudioWindow();
  activity.start();
  createTray();
  applySystemSettings();

  // Restore an in-progress break after relaunch.
  if (engine.snapshot().status === "break") openBreakWindows();

  tick();
  tickTimer = setInterval(tick, 1000);

  if (!settings.hasCompletedOnboarding || process.argv.includes("--dev")) openSettings(settings.hasCompletedOnboarding ? undefined : "welcome");
  else if (!app.getLoginItemSettings().wasOpenedAtLogin) {
    // Manual launch: show the panel once so the user can see FarSight started.
    setTimeout(togglePopover, 600);
  }
});

export type Command = typeof command;
void tickTimer;
