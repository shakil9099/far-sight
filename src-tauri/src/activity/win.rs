//! Windows: idle and lock via Win32; front app, fullscreen, microphone and media sessions from
//! one long-running PowerShell process (registry + WinRT media sessions).
use super::RawSample;
use crate::platform::quiet_command;
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::time::Duration;
use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_SWITCHDESKTOP};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

pub fn idle_seconds() -> f64 {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return 0.0;
    }
    let now = unsafe { GetTickCount() };
    now.wrapping_sub(info.dwTime) as f64 / 1000.0
}

/// The input desktop can't be opened while the lock screen (Winlogon desktop) is active.
pub fn screen_locked() -> bool {
    let desk = unsafe { OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP) };
    if desk.is_null() {
        return true;
    }
    unsafe { CloseDesktop(desk) };
    false
}

const SCRIPT: &str = r#"
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
$mediaMgr = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
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
    if ($p) { $name = $p.ProcessName }
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
  @{ app = $name; fs = $fs; mic = @($mic); video = @($video) } | ConvertTo-Json -Compress
  Start-Sleep -Seconds 2
}
"#;

#[derive(serde::Deserialize)]
struct Line {
    app: Option<String>,
    fs: Option<bool>,
    #[serde(default, deserialize_with = "one_or_many")]
    mic: Vec<String>,
    #[serde(default, deserialize_with = "one_or_many")]
    video: Vec<String>,
}

/// ConvertTo-Json writes one-element arrays as plain strings.
fn one_or_many<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(match <serde_json::Value as serde::Deserialize>::deserialize(d)? {
        serde_json::Value::String(s) => vec![s],
        serde_json::Value::Array(a) => a.into_iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        _ => vec![],
    })
}

pub fn start(on_sample: impl Fn(RawSample) + Send + 'static) {
    std::thread::Builder::new()
        .name("activity".into())
        .spawn(move || loop {
            let child = quiet_command("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn();
            if let Ok(mut child) = child {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(SCRIPT.as_bytes());
                }
                if let Some(out) = child.stdout.take() {
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        if let Ok(l) = serde_json::from_str::<Line>(&line) {
                            on_sample(RawSample {
                                front_app: l.app.clone(),
                                front_app_id: l.app,
                                fullscreen: l.fs.unwrap_or(false),
                                mic_apps: l.mic,
                                video_apps: l.video,
                            });
                        }
                    }
                }
                let _ = child.kill();
            }
            std::thread::sleep(Duration::from_secs(10)); // restart if PowerShell exits
        })
        .expect("spawn activity thread");
}

pub fn running_apps() -> Vec<String> {
    let out = quiet_command("powershell.exe")
        .args(["-NoProfile", "-Command", "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty ProcessName"])
        .output();
    let Ok(out) = out else { return vec![] };
    let mut names: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}
