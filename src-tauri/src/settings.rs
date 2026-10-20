//! Default settings and loading/migrating stored settings.
use crate::types::*;
use std::collections::BTreeMap;

pub const SETTINGS_VERSION: u32 = 3;

fn day(enabled: bool) -> DaySchedule {
    DaySchedule { enabled, start: TimeOfDay { hour: 9, minute: 0 }, end: TimeOfDay { hour: 18, minute: 0 } }
}

fn strings(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

impl Default for Settings {
    fn default() -> Self {
        let mut office_hours = BTreeMap::new();
        for d in 0..7 {
            office_hours.insert(d, day((1..=5).contains(&d)));
        }
        Settings {
            // 20-20-20 rule: every 20 minutes, look 20 feet away for 20 seconds.
            work_duration: 20.0 * 60.0,
            short_break_duration: 20.0,
            long_break_enabled: true,
            long_break_duration: 5.0 * 60.0,
            long_break_every: 3,

            countdown_enabled: true,
            countdown_threshold: 10.0,
            reminder_enabled: true,
            reminder_threshold: 60.0,

            discipline_level: DisciplineLevel::Balanced,
            skip_delay: 5.0,
            snooze_limit_per_break: 0,
            snooze_limit_per_day: 0,
            advance_skips_per_day: 3,
            escape_action: EscapeAction::Skip,
            hold_break_until_ended: false,

            idle_pause_enabled: true,
            idle_time_for_pause: 60.0,
            idle_reset_enabled: true,
            idle_time_for_reset: 5.0 * 60.0,
            show_return_notice: true,
            wait_for_typing_to_finish: true,

            deep_focus_apps: vec![],
            meeting_apps: strings(&[
                "zoom.us",
                "Zoom",
                "Microsoft Teams",
                "Teams",
                "ms-teams",
                "WhatsApp",
                "Slack",
                "Discord",
                "Webex",
                "FaceTime",
                "Skype",
                "Google Meet",
            ]),
            pause_for_fullscreen: true,
            smart_pause_cooldown: 30.0,
            video_pause_enabled: true,
            video_frontmost_only: true,
            video_excluded_apps: vec![],

            office_hours_enabled: false,
            office_hours,

            planned_breaks: vec![],
            automations: vec![],

            blink_reminder_enabled: false,
            blink_reminder_frequency: 5.0 * 60.0,
            posture_reminder_enabled: false,
            posture_reminder_frequency: 15.0 * 60.0,
            reminder_position: "center".into(),
            reminder_size: "medium".into(),
            reminder_duration: 5.0,
            reminder_dim: false,
            reminders_during_pause: false,

            break_background: "gradient".into(),
            gradient: 1,
            background_image: None,
            show_clock: true,
            hide_title: false,
            hide_subtitle: false,
            custom_short_titles: vec![],
            custom_long_titles: vec![],
            lock_on_break: false,

            sound_pair: "chime".into(),
            break_sounds_volume: 0.6,
            reminder_sounds_enabled: true,
            reminder_volume: 0.4,

            launch_at_login: false,
            menu_bar_display: "icon-and-text".into(),
            stats_enabled: true,
            shortcuts: Shortcuts {
                start_break: "CommandOrControl+Alt+B".into(),
                toggle_pause: "CommandOrControl+Alt+P".into(),
                snooze: "CommandOrControl+Alt+S".into(),
                skip: "CommandOrControl+Alt+K".into(),
            },
            has_completed_onboarding: false,
            settings_version: SETTINGS_VERSION,
        }
    }
}

/// Parse stored settings JSON (from any earlier version), filling gaps with defaults.
pub fn from_json(value: serde_json::Value) -> Settings {
    let stored_version = value.get("settingsVersion").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    let mut s: Settings = serde_json::from_value(value).unwrap_or_default();
    // Office hours may be stored partially; keep every weekday present.
    let defaults = Settings::default();
    for (d, sched) in defaults.office_hours {
        s.office_hours.entry(d).or_insert(sched);
    }
    if stored_version < 2 {
        // v2 added WhatsApp, Slack and Discord to the call apps.
        for app in ["WhatsApp", "Slack", "Discord"] {
            if !s.meeting_apps.iter().any(|a| a.eq_ignore_ascii_case(app)) {
                s.meeting_apps.push(app.into());
            }
        }
    }
    if stored_version < 3 {
        // v3 introduced centered, animated reminders as the default.
        s.reminder_position = "center".into();
    }
    s.settings_version = SETTINGS_VERSION;
    s
}

/// Apply a partial update (as sent by the settings UI) to the current settings.
pub fn merge_patch(current: &Settings, patch: serde_json::Value) -> Settings {
    let mut base = serde_json::to_value(current).expect("settings serialise");
    if let (Some(obj), Some(p)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }
    from_json(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn migrates_call_apps_from_v1() {
        let s = from_json(json!({ "meetingApps": ["Zoom", "slack"] }));
        assert_eq!(s.meeting_apps, vec!["Zoom", "slack", "WhatsApp", "Discord"]);
        let s = from_json(json!({ "meetingApps": ["Zoom"], "settingsVersion": 3 }));
        assert_eq!(s.meeting_apps, vec!["Zoom"]);
    }

    #[test]
    fn v3_centers_reminders_once() {
        assert_eq!(from_json(json!({ "reminderPosition": "top-right", "settingsVersion": 2 })).reminder_position, "center");
        assert_eq!(from_json(json!({ "reminderPosition": "top-right", "settingsVersion": 3 })).reminder_position, "top-right");
    }

    #[test]
    fn fills_missing_fields_and_applies_patches() {
        let s = from_json(json!({ "workDuration": 600 }));
        assert_eq!(s.work_duration, 600.0);
        assert_eq!(s.short_break_duration, 20.0);
        assert_eq!(s.office_hours.len(), 7);
        let p = merge_patch(&s, json!({ "disciplineLevel": "hardcore", "shortcuts": { "startBreak": "", "togglePause": "", "snooze": "", "skip": "" } }));
        assert_eq!(p.discipline_level, DisciplineLevel::Hardcore);
        assert_eq!(p.work_duration, 600.0);
        assert_eq!(p.shortcuts.start_break, "");
    }

    #[test]
    fn round_trips_camel_case_json() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert!(v.get("workDuration").is_some());
        assert!(v.get("officeHours").unwrap().get("1").is_some());
        assert_eq!(from_json(v), Settings::default());
    }
}
