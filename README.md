# FarSight

A cross-platform (macOS + Windows) screen-break and eye-health app.

FarSight lives in the menu bar / system tray, follows the 20-20-20 rule by
default, and holds breaks while you're in a meeting, presenting, or away.

The interface is a menu-bar popover with Now / Stats tabs, translucent dark glass panels,
rounded bold numerals, pill buttons, gradient icon tiles, a two-arc Screen Score gauge, and
italic serif break titles. Headings use
[Instrument Serif](https://github.com/Instrument/instrument-serif) (SIL Open Font License,
see `src/renderer/fonts/OFL.txt`).

## How to install

Download the latest build from the [Releases page](https://github.com/shakil9099/far-sight/releases),
or build it yourself (see [Building installers](#building-installers)).

### macOS

1. Pick the DMG for your Mac (Apple menu → **About This Mac** → *Chip*):

   | Your chip | File |
   | --- | --- |
   | Apple Silicon (M1, M2, M3, M4…) | `FarSight-<version>-arm64.dmg` |
   | Intel | `FarSight-<version>-x64.dmg` |

2. Open the DMG and drag **FarSight** into **Applications**.
3. Launch FarSight from Applications or Spotlight. The panel opens and an eye icon
   appears in the menu bar.
4. First launch only: FarSight isn't notarized by Apple yet, so macOS may say it
   "can't be opened". Right-click **FarSight.app** → **Open** → **Open**, or run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/FarSight.app
   ```

5. Optional: **Settings → General → Launch at login**.

If you can't see the menu-bar icon (it can hide behind the notch on MacBooks), open
FarSight again from Applications to bring up its panel.

### Windows

1. Download `FarSight-<version>-win-x64.exe` (installer) or `FarSight-<version>-win-x64.zip`.
2. Run the installer, or unzip and run `FarSight.exe`.
3. If SmartScreen warns about an unrecognised app, click **More info → Run anyway**
   (the app isn't code-signed yet).
4. FarSight runs in the system tray (click **^** next to the clock if the icon is hidden).

## Quick start (development)

```bash
npm install
npm start            # build + run (works from VS Code terminals too)
npm test             # engine, scheduling and platform unit tests
npm run screenshots  # renders every window state into ./screenshots
```

## Building installers

| Target | Command | Output (`release/`) |
| --- | --- | --- |
| macOS (Apple Silicon + Intel) | `npm run dist:mac` | `FarSight-<v>-arm64.dmg`, `FarSight-<v>-x64.dmg` |
| Windows installer | `npm run dist:win` | `FarSight-<v>-win-x64.exe` (NSIS) + `.zip` |
| Windows zip only | `npm run dist:win-zip` | `FarSight-<v>-win-x64.zip` |

Notes:

- Building the Windows **NSIS installer on an Apple Silicon Mac** needs Rosetta
  (`softwareupdate --install-rosetta`), because electron-builder's `makensis` is x86-64 only.
  Without it, use `dist:win-zip`, build on Windows, or use the included GitHub Actions
  workflow (`.github/workflows/build.yml`), which builds both platforms on native runners.
- Builds are unsigned. On macOS, right-click → Open the first time (or sign/notarize with
  your Developer ID). On Windows, SmartScreen will warn until the exe is code-signed.

## Features

| Feature | macOS | Windows | How |
| --- | :-: | :-: | --- |
| Work timer, short + long breaks (every Nth) | ✅ | ✅ | `src/shared/engine.ts` |
| Heads-up card with Start now / +1m / +5m / +15m / Skip | ✅ | ✅ | `toast.html` |
| Countdown that follows the cursor | ✅ | ✅ | `countdown.html` |
| Full-screen break on every display (gradient / blur / image) | ✅ | ✅ | vibrancy on macOS, acrylic on Windows 11 |
| Casual / Balanced / Hardcore enforcement, snooze & skip limits, advance skips | ✅ | ✅ | engine |
| Double-Esc action, "hold until End Break" | ✅ | ✅ | `break.ts` |
| Idle pause, idle reset (counts as a natural break), return notice with Undo | ✅ | ✅ | `powerMonitor.getSystemIdleTime()` |
| Pause on screen lock and sleep | ✅ | ✅ | `powerMonitor` events |
| Smart pause: deep-focus apps (frontmost app list) | ✅ | ✅ | `lsappinfo` / Win32 `GetForegroundWindow` |
| Smart pause: meetings via microphone in use | ✅ | ✅ | CoreAudio helper / Windows CapabilityAccessManager registry |
| Smart pause: fullscreen apps | — | ✅ | foreground window covers its monitor |
| Office hours, planned breaks (fixed times) | ✅ | ✅ | engine + `platform.ts` |
| Blink & posture reminders | ✅ | ✅ | engine wellness timers |
| Stats, hourly chart, 7-day history, Screen Score | ✅ | ✅ | `src/shared/stats.ts` |
| Automations: run a command on break start/end | ✅ | ✅ | `sh` / `cmd` (osascript, `shortcuts run`, PowerShell) |
| Lock screen when a break starts | ✅ | ✅ | `pmset displaysleepnow` / `LockWorkStation` |
| Global shortcuts, launch at login | ✅ | ✅ | Electron |
| Synthesised break sounds (no audio files) | ✅ | ✅ | Web Audio, `audio.ts` |
| Timer state survives restarts | ✅ | ✅ | `timer-state.json` |

Not implemented yet: iPhone/iPad sync, Live Activities, calendar-event pause,
Focus-mode filters, website usage tracking.

## Architecture

```text
src/shared/engine.ts     pure state machine: tick(now, context) -> events (unit tested)
src/shared/stats.ts      per-day stats + Screen Score
src/main/main.ts         tray menu, 1 Hz loop, IPC commands, shortcuts
src/main/activity.ts     frontmost app / fullscreen / microphone detection per OS
src/main/windows.ts      break, countdown, toast, settings and audio windows
native/mac-mic.c         CoreAudio "is any physical mic running" helper (universal binary)
src/renderer/*           UI pages (plain TypeScript + CSS, bundled by esbuild)
```

Settings, stats and timer state are JSON files in the OS app-data folder
(`~/Library/Application Support/FarSight`, `%APPDATA%\FarSight`). Nothing leaves the machine.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE).
