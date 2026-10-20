// Creation and placement of every FarSight window.
import { BrowserWindow, screen, type Display } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReminderPosition, Settings } from "../shared/types";

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

export const preloadPath = () => join(__dirname, "../preload/preload.js");
const pageUrl = (page: string, query: Record<string, string> = {}) => {
  const url = pathToFileURL(join(__dirname, "../renderer", page));
  url.search = new URLSearchParams(query).toString();
  return url.toString();
};

function baseWindow(opts: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    ...opts,
  });
}

/** Full-screen break overlay for one display. */
export function createBreakWindow(display: Display, settings: Settings, primary: boolean): BrowserWindow {
  const blur = settings.breakBackground === "blur";
  const { x, y, width, height } = display.bounds;
  const win = baseWindow({
    x,
    y,
    width,
    height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    transparent: blur,
    backgroundColor: blur ? "#00000000" : "#0b1020",
    ...(blur && isMac ? { vibrancy: "fullscreen-ui" as const, visualEffectState: "active" as const } : {}),
    ...(blur && isWin ? { backgroundMaterial: "acrylic" as const } : {}),
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setBounds(display.bounds);
  win.loadURL(pageUrl("break.html", { primary: primary ? "1" : "0" }));
  win.once("ready-to-show", () => {
    win.showInactive();
    if (primary) win.focus();
  });
  return win;
}

/** Small floating countdown that follows the cursor. */
export function createCountdownWindow(): BrowserWindow {
  const win = baseWindow({
    width: 150,
    height: 56,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.loadURL(pageUrl("countdown.html"));
  return win;
}

export type ToastKind = "heads-up" | "returned" | "paused" | "wellness" | "notice" | "info";

/** Notification-style card (heads-up, idle return notice, smart pause notice, wellness reminders). */
export function createToastWindow(kind: ToastKind, payload: unknown, position: ReminderPosition): BrowserWindow {
  const size =
    kind === "wellness" || kind === "notice"
      ? { width: 340, height: 92 }
      : { width: 420, height: kind === "heads-up" ? 150 : 124 };
  const win = baseWindow({
    ...size,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: kind === "heads-up" || kind === "returned",
    hasShadow: false,
    backgroundColor: "#00000000",
  });
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (kind === "notice") {
    // Small notices appear next to the pointer, where the user just clicked.
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x + 12, p.y + 12);
  } else placeToast(win, position);
  win.loadURL(pageUrl("toast.html", { kind, payload: JSON.stringify(payload) }));
  win.once("ready-to-show", () => win.showInactive());
  return win;
}

export function placeToast(win: BrowserWindow, position: ReminderPosition): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const [w, h] = win.getSize();
  const m = 16;
  const xs = { left: area.x + m, center: area.x + Math.round((area.width - w) / 2), right: area.x + area.width - w - m };
  const ys = { top: area.y + m, bottom: area.y + area.height - h - m };
  const [v, hpos] = position.split("-") as ["top" | "bottom", "left" | "center" | "right"];
  win.setPosition(xs[hpos], ys[v]);
}

export function createSettingsWindow(tab?: string): BrowserWindow {
  const win = baseWindow({
    width: 920,
    height: 660,
    minWidth: 760,
    minHeight: 520,
    title: "FarSight Settings",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    ...(isMac ? { vibrancy: "sidebar" as const, transparent: true } : { backgroundColor: "#1b1d24" }),
  });
  win.loadURL(pageUrl("settings.html", tab ? { tab } : {}));
  win.once("ready-to-show", () => win.show());
  return win;
}

export const POPOVER_SIZE = { width: 400, height: 590 };

/** The menu-bar / tray panel (Now and Stats tabs). */
export function createPopoverWindow(): BrowserWindow {
  const win = baseWindow({
    ...POPOVER_SIZE,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    hasShadow: true,
    backgroundColor: "#00000000",
    ...(isMac ? { vibrancy: "popover" as const, visualEffectState: "active" as const, roundedCorners: true } : {}),
    ...(isWin ? { backgroundMaterial: "acrylic" as const, roundedCorners: true } : {}),
  });
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.loadURL(pageUrl("popover.html"));
  return win;
}

/** Place the popover under the tray icon (macOS menu bar) or above it (Windows taskbar). */
export function placePopover(win: BrowserWindow, trayBounds: Electron.Rectangle): void {
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const area = display.workArea;
  const { width, height } = POPOVER_SIZE;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const trayAtBottom = trayBounds.y > display.bounds.y + display.bounds.height / 2;
  let y = trayAtBottom ? trayBounds.y - height - 8 : trayBounds.y + trayBounds.height + 6;
  if (trayBounds.width === 0) {
    // Some Windows shells report empty bounds: fall back to the bottom-right corner.
    x = area.x + area.width - width - 12;
    y = area.y + area.height - height - 12;
  }
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - width - 8);
  y = Math.min(Math.max(y, area.y + 4), area.y + area.height - height - 4);
  win.setPosition(x, y);
}

/** Hidden window that synthesises and plays sounds with Web Audio. */
export function createAudioWindow(): BrowserWindow {
  const win = baseWindow({ width: 10, height: 10, skipTaskbar: true, focusable: false });
  win.loadURL(pageUrl("audio.html"));
  return win;
}
