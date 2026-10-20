//! OS helpers: locking the screen, automations, office hours.
use crate::engine::local;
use crate::types::Settings;
use chrono::{Datelike, Timelike};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Builds a command that never flashes a console window on Windows.
pub fn quiet_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Lock the session (Windows) or sleep the display, which locks if a password is required (macOS).
pub fn lock_screen() {
    #[cfg(windows)]
    let _ = quiet_command("rundll32.exe").arg("user32.dll,LockWorkStation").spawn();
    #[cfg(target_os = "macos")]
    let _ = Command::new("pmset").arg("displaysleepnow").spawn();
}

/// Run a user automation with the platform shell. Returns (success, output).
pub fn run_automation(command: &str) -> (bool, String) {
    #[cfg(windows)]
    let out = quiet_command("cmd").args(["/C", command]).output();
    #[cfg(not(windows))]
    let out = Command::new("/bin/sh").args(["-c", command]).output();
    match out {
        Ok(o) => {
            let mut text = String::from_utf8_lossy(&o.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&o.stderr));
            (o.status.success(), text.trim().chars().take(2000).collect())
        }
        Err(e) => (false, e.to_string()),
    }
}

pub fn is_outside_office_hours(s: &Settings, now_ms: f64) -> bool {
    if !s.office_hours_enabled {
        return false;
    }
    let now = local(now_ms);
    let Some(sched) = s.office_hours.get(&now.weekday().num_days_from_sunday()) else { return true };
    if !sched.enabled {
        return true;
    }
    let m = now.hour() * 60 + now.minute();
    let start = sched.start.hour * 60 + sched.start.minute;
    let end = sched.end.hour * 60 + sched.end.minute;
    if end > start {
        m < start || m >= end
    } else {
        m < start && m >= end // crosses midnight
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;
    use chrono::TimeZone;

    fn at(d: u32, h: u32) -> f64 {
        chrono::Local.with_ymd_and_hms(2026, 10, d, h, 0, 0).unwrap().timestamp_millis() as f64
    }

    #[test]
    fn office_hours_weekdays_and_midnight() {
        let s = Settings { office_hours_enabled: true, ..Default::default() };
        assert!(!is_outside_office_hours(&s, at(20, 10))); // Tue
        assert!(is_outside_office_hours(&s, at(20, 19)));
        assert!(is_outside_office_hours(&s, at(18, 12))); // Sun
        let mut night = s.clone();
        night.office_hours.insert(2, DaySchedule { enabled: true, start: TimeOfDay { hour: 22, minute: 0 }, end: TimeOfDay { hour: 2, minute: 0 } });
        assert!(!is_outside_office_hours(&night, at(20, 23)));
        assert!(!is_outside_office_hours(&night, at(20, 1)));
        assert!(is_outside_office_hours(&night, at(20, 12)));
        assert!(!is_outside_office_hours(&Settings::default(), at(18, 3)));
    }

    #[test]
    fn automation_reports_output() {
        let (ok, out) = run_automation("echo hello");
        assert!(ok);
        assert_eq!(out, "hello");
    }
}
