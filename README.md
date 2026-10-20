# FarSight

A cross-platform (macOS + Windows) screen-break and eye-health app, built with
[Tauri](https://tauri.app): a ~4 MB download that uses ~170 MB of memory and almost no CPU.

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

1. Download `FarSight_<version>_universal.dmg`. It runs natively on both Apple Silicon
   (M1, M2, M3, M4…) and Intel Macs, macOS 11 or newer.
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

1. Download `FarSight_<version>_x64-setup.exe`.
2. Run the installer (it installs for your user account; no admin rights needed). Windows 10
   and 11 already include the WebView2 runtime FarSight uses; if it's missing, the installer
   downloads it.
3. If SmartScreen warns about an unrecognised app, click **More info → Run anyway**
   (the app isn't code-signed yet).
4. FarSight runs in the system tray (click **^** next to the clock if the icon is hidden).

## Quick start (development)

Requires [Node.js](https://nodejs.org) 24+ and [Rust](https://rustup.rs) (stable). On Windows,
also the "Desktop development with C++" workload from Visual Studio Build Tools.

```bash
npm install
npm run dev          # build the UI and run the app (debug build)
npm test             # Rust unit tests: timer engine, stats, smart pause, settings, sounds
npm run typecheck    # TypeScript checks for the UI pages
```

Debug helpers: `FARSIGHT_DEBUG=1` prints every timer tick and UI page load/error to the
terminal, and a debug build run with `--self-test` opens every window, saves PNG snapshots
to `./screenshots` (macOS) and quits:

```bash
cd src-tauri && cargo build && FARSIGHT_DEBUG=1 ./target/debug/farsight --self-test
```

## Building installers

| Target | Command (run on that OS) | Output |
| --- | --- | --- |
| macOS universal DMG | `npm run dist:mac` | `src-tauri/target/universal-apple-darwin/release/bundle/dmg/` |
| Windows installer | `npm run dist:win` | `src-tauri/target/release/bundle/nsis/` |

Notes:

- `dist:mac` needs both Rust targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
- Windows installers must be built on Windows. The GitHub Actions workflow
  (`.github/workflows/build.yml`) builds both platforms on native runners when you push a
  `v*` tag or run it manually.
- Builds are unsigned (macOS uses an ad-hoc signature). On macOS, right-click → Open the first time (or sign/notarize with
  your Developer ID). On Windows, SmartScreen will warn until the exe is code-signed.

## Features

| Feature | macOS | Windows | How |
| --- | :-: | :-: | --- |
| Work timer, short + long breaks (every Nth) | ✅ | ✅ | `src-tauri/src/engine.rs` |
| Heads-up card with Start now / +1m / +5m / +15m / Skip | ✅ | ✅ | `toast.html` |
| Countdown that follows the cursor | ✅ | ✅ | `countdown.html` |
| Full-screen break on every display, above fullscreen apps (gradient / blur / image) | ✅ | ✅ | vibrancy on macOS, acrylic on Windows 11 |
| Casual / Balanced / Hardcore enforcement, snooze & skip limits, advance skips | ✅ | ✅ | engine |
| Double-Esc action, "hold until End Break" | ✅ | ✅ | `break.ts` |
| Idle pause, idle reset (counts as a natural break), return notice with Undo | ✅ | ✅ | CoreGraphics idle time / Win32 `GetLastInputInfo` |
| Pause on screen lock and sleep | ✅ | ✅ | `CGSessionCopyCurrentDictionary` / input-desktop check |
| Smart pause: deep-focus apps (frontmost app list) | ✅ | ✅ | `NSWorkspace` / Win32 `GetForegroundWindow` |
| Smart pause: calls (Teams, WhatsApp, Zoom…) via microphone in use or video call; no notifications during calls or videos | ✅ | ✅ | CoreAudio / Windows CapabilityAccessManager registry |
| Smart pause: video playback (frontmost or anywhere), video time in Stats | ✅ | ✅ | display-sleep power assertions (IOKit) / Windows media sessions |
| Smart pause: fullscreen apps | — | ✅ | foreground window covers its monitor |
| Office hours, planned breaks (fixed times) | ✅ | ✅ | engine + `platform.rs` |
| Blink & posture reminders: animated, centered (or any corner), optional screen dim, click-through | ✅ | ✅ | `reminder.html` |
| Stats, hourly chart, 7-day history, Screen Score, video time per app | ✅ | ✅ | `src-tauri/src/stats.rs` |
| Automations: run a command on break start/end | ✅ | ✅ | `sh` / `cmd` (osascript, `shortcuts run`, PowerShell) |
| Lock screen when a break starts | ✅ | ✅ | `pmset displaysleepnow` / `LockWorkStation` |
| Global shortcuts, launch at login | ✅ | ✅ | Tauri global-shortcut / autostart plugins |
| Synthesised break sounds (no audio files) | ✅ | ✅ | `sound.rs` → WAV, played with `afplay` / `PlaySound` |
| Timer state survives restarts | ✅ | ✅ | `timer-state.json` |

Not implemented yet: iPhone/iPad sync, Live Activities, calendar-event pause,
Focus-mode filters, website usage tracking.

## Architecture

```text
src-tauri/src/engine.rs      pure timer state machine: tick(now, context) -> events (unit tested)
src-tauri/src/stats.rs       per-day stats + Screen Score
src-tauri/src/smartpause.rs  calls / video / focus / fullscreen decisions (unit tested)
src-tauri/src/settings.rs    defaults and settings migration
src-tauri/src/app.rs         app state, 1 Hz loop, tray, menus, shortcuts, IPC commands
src-tauri/src/ui.rs          break overlays, countdown, cards, popover and settings windows
src-tauri/src/activity/      front app, idle, lock, mic, video per OS (mac.rs / win.rs)
src-tauri/native/macos.m     CoreAudio, IOKit, CoreGraphics and window-level helpers
src-tauri/src/sound.rs       synthesised sounds
src/renderer/*               UI pages (plain TypeScript + CSS, bundled by esbuild)
```

Settings, stats and timer state are JSON files in the OS app-data folder
(`~/Library/Application Support/app.farsight.desktop`, `%APPDATA%\app.farsight.desktop`).
Data from earlier versions is copied over automatically. Nothing leaves the machine.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE).
