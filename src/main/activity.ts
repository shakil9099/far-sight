// Detects what the user is doing so breaks can be held off (deep focus apps,
// meetings, video playback, fullscreen apps). macOS uses `lsappinfo` plus the native
// helper in native/mac-mic.c (no permissions needed); Windows uses one long-running
// PowerShell process polling Win32 APIs and the system media sessions.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import type { ActivitySample } from "./smartpause";

export type { ActivitySample } from "./smartpause";
export { matchesApp } from "./smartpause";

const VIDEO_GRACE_MS = 6000;

const EMPTY: ActivitySample = { frontApp: null, frontAppId: null, fullscreen: false, micApps: [], videoApps: [] };

const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FsWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
}
"@
# System media sessions (browsers, video players) for video playback detection.
$mediaMgr = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${"`"}1' })[0]
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $task = $asTask.MakeGenericMethod($mgrType).Invoke($null, @($mgrType::RequestAsync()))
  [void]$task.Wait(5000)
  $mediaMgr = $task.Result
} catch { $mediaMgr = $null }
$micRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
while ($true) {
  $name = $null; $fs = $false; $mic = @(); $video = @()
  $h = [FsWin]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero -and $h -ne [FsWin]::GetShellWindow() -and $h -ne [FsWin]::GetDesktopWindow()) {
    $procId = 0; [void][FsWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $p = Get-Process -Id $procId
    if ($p) { $name = $p.ProcessName; if ($p.MainWindowTitle) { $title = $p.MainWindowTitle } }
    $r = New-Object FsWin+RECT; [void][FsWin]::GetWindowRect($h, [ref]$r)
    $mi = New-Object FsWin+MONITORINFO; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    $m = [FsWin]::MonitorFromWindow($h, 2)
    if ([FsWin]::GetMonitorInfo($m, [ref]$mi)) {
      $fs = ($r.L -le $mi.rcMonitor.L -and $r.T -le $mi.rcMonitor.T -and $r.R -ge $mi.rcMonitor.R -and $r.B -ge $mi.rcMonitor.B) -and ($name -ne 'explorer')
    }
  }
  Get-ChildItem $micRoot -Recurse | ForEach-Object {
    $stop = (Get-ItemProperty $_.PSPath).LastUsedTimeStop
    if ($stop -eq 0) { $mic += ($_.PSChildName -replace '^.*#', '' -replace '\.exe$', '') }
  }
  if ($mediaMgr) {
    foreach ($s in $mediaMgr.GetSessions()) {
      $pi = $s.GetPlaybackInfo()
      if ([string]$pi.PlaybackStatus -eq 'Playing' -and [string]$pi.PlaybackType -ne 'Music') {
        $video += ($s.SourceAppUserModelId -replace '^.*!', '' -replace '\.exe$', '')
      }
    }
  }
  @{ app = $name; fs = $fs; mic = $mic; video = $video } | ConvertTo-Json -Compress
  Start-Sleep -Seconds 2
}
`;

export class ActivityMonitor {
  private latest: ActivitySample = EMPTY;
  private timer: NodeJS.Timeout | null = null;
  private ps: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;

  /** Last frontmost app that wasn't FarSight itself (its own windows take focus briefly). */
  private lastExternalFront: { name: string | null; id: string | null } = { name: null, id: null };
  private macMicActive = false;
  private macVideoApps: string[] = [];
  private micHelper: ChildProcessWithoutNullStreams | null = null;

  start(): void {
    this.stopped = false;
    if (process.platform === "darwin") {
      this.pollMac();
      this.timer = setInterval(() => this.pollMac(), 3000);
      this.startMacMicHelper();
    } else if (process.platform === "win32") {
      this.startWindows();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ps?.kill();
    this.ps = null;
    this.micHelper?.kill();
    this.micHelper = null;
  }

  /** Native helper (native/mac-mic.c): prints {"mic":0|1,"video":[app names]} every 2 s. */
  private startMacMicHelper(): void {
    const bin = app.isPackaged ? join(process.resourcesPath, "bin", "farsight-mic") : join(app.getAppPath(), "build", "bin", "farsight-mic");
    if (!existsSync(bin)) return;
    const helper = spawn(bin, []);
    this.micHelper = helper;
    createInterface({ input: helper.stdout }).on("line", (line) => {
      try {
        const j = JSON.parse(line) as { mic: number; video: string[] };
        this.macMicActive = j.mic === 1;
        this.macVideoApps = Array.isArray(j.video) ? j.video : [];
        this.latest = { ...this.latest, micApps: this.macMicActive ? ["Microphone"] : [], videoApps: this.macVideoApps };
      } catch {
        /* ignore partial lines */
      }
    });
    helper.on("exit", () => {
      if (this.micHelper === helper) this.micHelper = null;
      this.macMicActive = false;
      this.macVideoApps = [];
      if (!this.stopped) setTimeout(() => !this.stopped && this.startMacMicHelper(), 10_000);
    });
  }

  /** When each app was last reported playing video. */
  private videoSeenAt = new Map<string, number>();

  sample(): ActivitySample {
    return { ...this.latest, videoApps: this.steadyVideo(this.latest.videoApps) };
  }

  /** Smooth over brief gaps (buffering, next clip) so the pause doesn't flicker. */
  private steadyVideo(current: string[]): string[] {
    const now = Date.now();
    for (const a of current) this.videoSeenAt.set(a, now);
    for (const [a, t] of this.videoSeenAt) if (now - t > VIDEO_GRACE_MS) this.videoSeenAt.delete(a);
    return [...this.videoSeenAt.keys()];
  }

  /** When FarSight's own window is in front, keep reporting the app that was in front before it. */
  private external(name: string | null, id: string | null): { name: string | null; id: string | null } {
    const self = (v: string | null) => !!v && (/^(farsight|electron)$/i.test(v) || v === "app.farsight.desktop" || v === "com.github.Electron");
    if (self(name) || self(id)) return this.lastExternalFront;
    this.lastExternalFront = { name, id };
    return this.lastExternalFront;
  }

  private pollMac(): void {
    execFile("/bin/sh", ["-c", "lsappinfo info -only name -only bundleid `lsappinfo front`"], { timeout: 2500 }, (err, out) => {
      if (err) return;
      // First line: "App Name" ASN:0x0-0x3c03c: (in front)   then   bundleID="com.example.app"
      const front = this.external(/^\s*"([^"]*)"\s+ASN:/m.exec(out)?.[1] ?? null, /bundleID="([^"]*)"/.exec(out)?.[1] ?? null);
      const name = front.name;
      const id = front.id;
      this.latest = {
        frontApp: name,
        frontAppId: id,
        fullscreen: false,
        micApps: this.macMicActive ? ["Microphone"] : [],
        videoApps: this.macVideoApps,
      };
    });
  }

  private startWindows(): void {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      windowsHide: true,
    });
    this.ps = ps;
    ps.stdin.write(WIN_SCRIPT);
    ps.stdin.end();
    createInterface({ input: ps.stdout }).on("line", (line) => {
      try {
        const j = JSON.parse(line) as { app: string | null; fs: boolean; mic: string[] | string | null; video: string[] | string | null };
        // ConvertTo-Json turns one-element arrays into plain strings.
        const list = (v: string[] | string | null) => (Array.isArray(v) ? v : v ? [v] : []);
        const front = this.external(j.app, j.app);
        this.latest = { frontApp: front.name, frontAppId: front.id, fullscreen: !!j.fs, micApps: list(j.mic), videoApps: list(j.video) };
      } catch {
        /* ignore partial lines */
      }
    });
    ps.on("exit", () => {
      if (this.ps === ps) this.ps = null;
      if (!this.stopped) setTimeout(() => !this.stopped && this.startWindows(), 10_000);
    });
  }
}

/** Running GUI apps, for the settings "Add an app" picker. */
export function listRunningApps(): Promise<string[]> {
  return new Promise((resolve) => {
    if (process.platform === "darwin") {
      execFile("lsappinfo", ["list"], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve([]);
        // Entries start with ` N) "Name" ASN:`; keep only regular (Foreground) apps.
        const names = out
          .split(/\n(?=\s*\d+\) ")/)
          .filter((entry) => entry.includes('type="Foreground"'))
          .map((entry) => /^\s*\d+\) "([^"]*)"/.exec(entry)?.[1] ?? "");
        resolve(uniq(names));
      });
    } else if (process.platform === "win32") {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty ProcessName"],
        { windowsHide: true },
        (err, out) => resolve(err ? [] : uniq(out.split(/\r?\n/))),
      );
    } else resolve([]);
  });
}

const uniq = (xs: string[]) => [...new Set(xs.map((s) => s.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
