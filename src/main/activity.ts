// Detects what the user is doing so breaks can be held off (deep focus apps,
// meetings, fullscreen video/games). macOS uses `lsappinfo` (no permissions needed);
// Windows uses one long-running PowerShell process polling Win32 APIs.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";

export interface ActivitySample {
  frontApp: string | null;
  frontAppId: string | null;
  fullscreen: boolean;
  /** Apps currently using the microphone (Windows only). */
  micApps: string[];
}

const EMPTY: ActivitySample = { frontApp: null, frontAppId: null, fullscreen: false, micApps: [] };

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
$micRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
while ($true) {
  $name = $null; $fs = $false; $mic = @()
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
  @{ app = $name; fs = $fs; mic = $mic } | ConvertTo-Json -Compress
  Start-Sleep -Seconds 2
}
`;

export class ActivityMonitor {
  private latest: ActivitySample = EMPTY;
  private timer: NodeJS.Timeout | null = null;
  private ps: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;

  private macMicActive = false;
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

  /** CoreAudio helper (native/mac-mic.c): prints 1 while a physical microphone is in use. */
  private startMacMicHelper(): void {
    const bin = app.isPackaged ? join(process.resourcesPath, "bin", "farsight-mic") : join(app.getAppPath(), "build", "bin", "farsight-mic");
    if (!existsSync(bin)) return;
    const helper = spawn(bin, []);
    this.micHelper = helper;
    createInterface({ input: helper.stdout }).on("line", (line) => (this.macMicActive = line.trim() === "1"));
    helper.on("exit", () => {
      if (this.micHelper === helper) this.micHelper = null;
      this.macMicActive = false;
      if (!this.stopped) setTimeout(() => !this.stopped && this.startMacMicHelper(), 10_000);
    });
  }

  sample(): ActivitySample {
    return this.latest;
  }

  private pollMac(): void {
    execFile("/bin/sh", ["-c", "lsappinfo info -only name -only bundleid `lsappinfo front`"], { timeout: 2500 }, (err, out) => {
      if (err) return;
      // First line: "App Name" ASN:0x0-0x3c03c: (in front)   then   bundleID="com.example.app"
      const name = /^\s*"([^"]*)"\s+ASN:/m.exec(out)?.[1] ?? null;
      const id = /bundleID="([^"]*)"/.exec(out)?.[1] ?? null;
      this.latest = { frontApp: name, frontAppId: id, fullscreen: false, micApps: this.macMicActive ? ["Microphone"] : [] };
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
        const j = JSON.parse(line) as { app: string | null; fs: boolean; mic: string[] | string | null };
        const mic = Array.isArray(j.mic) ? j.mic : j.mic ? [j.mic] : [];
        this.latest = { frontApp: j.app, frontAppId: j.app, fullscreen: !!j.fs, micApps: mic };
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

/** Case-insensitive match of an app against a user list (by name or bundle id). */
export function matchesApp(sample: ActivitySample, list: string[]): string | null {
  const candidates = [sample.frontApp, sample.frontAppId].filter(Boolean).map((s) => s!.toLowerCase());
  for (const entry of list) {
    const e = entry.toLowerCase();
    if (candidates.some((c) => c === e || c.includes(e))) return entry;
  }
  return null;
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
