// OS-specific helpers for macOS and Windows.
import { exec, execFile } from "node:child_process";
import type { Automation, DaySchedule, Settings, Weekday } from "../shared/types";

/** Lock the session (Windows) or put the display to sleep, which locks when a password is required (macOS). */
export function lockScreen(): void {
  if (process.platform === "win32") {
    execFile("rundll32.exe", ["user32.dll,LockWorkStation"], { windowsHide: true });
  } else if (process.platform === "darwin") {
    execFile("pmset", ["displaysleepnow"]);
  }
}

export function runAutomation(a: Automation): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(a.command, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout + stderr).trim().slice(0, 2000) || (err ? String(err.message) : "") });
    });
  });
}

export function isOutsideOfficeHours(settings: Settings, now: Date): boolean {
  if (!settings.officeHoursEnabled) return false;
  const sched: DaySchedule | undefined = settings.officeHours[now.getDay() as Weekday];
  if (!sched || !sched.enabled) return true;
  const m = now.getHours() * 60 + now.getMinutes();
  const start = sched.start.hour * 60 + sched.start.minute;
  const end = sched.end.hour * 60 + sched.end.minute;
  return end > start ? m < start || m >= end : m < start && m >= end; // end <= start: crosses midnight
}
