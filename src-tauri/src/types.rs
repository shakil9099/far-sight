//! Data types shared with the UI. Serialised as camelCase JSON to match `src/shared/types.ts`.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeOfDay {
    pub hour: u32,
    pub minute: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaySchedule {
    pub enabled: bool,
    pub start: TimeOfDay,
    pub end: TimeOfDay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisciplineLevel {
    Casual,
    Balanced,
    Hardcore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EscapeAction {
    Skip,
    Snooze,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedBreak {
    pub id: String,
    pub name: String,
    pub time: TimeOfDay,
    pub duration_min: u32,
    pub days: Vec<u32>,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    pub name: String,
    /// "break-start" | "break-end"
    pub trigger: String,
    pub command: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    pub start_break: String,
    pub toggle_pause: String,
    pub snooze: String,
    pub skip: String,
}

/// All user settings. Durations are in seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub work_duration: f64,
    pub short_break_duration: f64,
    pub long_break_enabled: bool,
    pub long_break_duration: f64,
    pub long_break_every: u32,

    pub countdown_enabled: bool,
    pub countdown_threshold: f64,
    pub reminder_enabled: bool,
    pub reminder_threshold: f64,

    pub discipline_level: DisciplineLevel,
    pub skip_delay: f64,
    pub snooze_limit_per_break: u32,
    pub snooze_limit_per_day: u32,
    pub advance_skips_per_day: u32,
    pub escape_action: EscapeAction,
    pub hold_break_until_ended: bool,

    pub idle_pause_enabled: bool,
    pub idle_time_for_pause: f64,
    pub idle_reset_enabled: bool,
    pub idle_time_for_reset: f64,
    pub show_return_notice: bool,
    pub wait_for_typing_to_finish: bool,

    pub deep_focus_apps: Vec<String>,
    pub meeting_apps: Vec<String>,
    pub pause_for_fullscreen: bool,
    pub smart_pause_cooldown: f64,
    pub video_pause_enabled: bool,
    pub video_frontmost_only: bool,
    pub video_excluded_apps: Vec<String>,

    pub office_hours_enabled: bool,
    pub office_hours: BTreeMap<u32, DaySchedule>,

    pub planned_breaks: Vec<PlannedBreak>,
    pub automations: Vec<Automation>,

    pub blink_reminder_enabled: bool,
    pub blink_reminder_frequency: f64,
    pub posture_reminder_enabled: bool,
    pub posture_reminder_frequency: f64,
    pub reminder_position: String,
    pub reminders_during_pause: bool,

    pub break_background: String,
    pub gradient: i32,
    pub background_image: Option<String>,
    pub show_clock: bool,
    pub hide_title: bool,
    pub hide_subtitle: bool,
    pub custom_short_titles: Vec<String>,
    pub custom_long_titles: Vec<String>,
    pub lock_on_break: bool,

    pub sound_pair: String,
    pub break_sounds_volume: f64,
    pub reminder_sounds_enabled: bool,
    pub reminder_volume: f64,

    pub launch_at_login: bool,
    pub menu_bar_display: String,
    pub stats_enabled: bool,
    pub shortcuts: Shortcuts,
    pub has_completed_onboarding: bool,
    pub settings_version: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BreakKind {
    Short,
    Long,
    Custom,
    Planned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PauseReason {
    Manual,
    Idle,
    ScreenLocked,
    DeepFocus,
    Meeting,
    Fullscreen,
    Video,
    OfficeHours,
    Suspended,
}

impl PauseReason {
    /// Smart pauses: the user is busy, breaks wait and resume afterwards.
    pub fn is_smart(self) -> bool {
        matches!(self, PauseReason::DeepFocus | PauseReason::Meeting | PauseReason::Fullscreen | PauseReason::Video)
    }
    /// On a call or watching a video: FarSight shows nothing and plays no reminder sounds.
    pub fn is_quiet(self) -> bool {
        matches!(self, PauseReason::Meeting | PauseReason::Video)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakInfo {
    pub kind: BreakKind,
    pub title: String,
    pub message: String,
    pub duration: f64,
    pub elapsed: f64,
    pub started_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planned_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PauseInfo {
    pub reason: PauseReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub until: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Stopped,
    Working,
    Paused,
    Break,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSnapshot {
    pub status: Status,
    pub work_elapsed: f64,
    pub work_duration: f64,
    pub remaining: f64,
    pub next_break_is_long: bool,
    pub breaks_taken: u32,
    pub pause: Option<PauseInfo>,
    pub current_break: Option<BreakInfo>,
    pub snoozes_this_break: u32,
    pub snoozes_today: u32,
    pub skips_today: u32,
    pub advance_skips_today: u32,
    pub can_skip: bool,
    pub can_snooze: bool,
    /// Seconds until Skip unlocks; -1 when it never will (Hardcore).
    pub skip_unlocks_in: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DayStats {
    pub date: String,
    pub screen_time_sec: f64,
    pub breaks_taken: u32,
    pub breaks_skipped: u32,
    pub natural_breaks: u32,
    pub snoozes: u32,
    pub sessions: Vec<f64>,
    pub longest_session_sec: f64,
    pub hourly: Vec<f64>,
    pub video_sec: f64,
    pub video_apps: BTreeMap<String, f64>,
}

impl Default for DayStats {
    fn default() -> Self {
        DayStats {
            date: String::new(),
            screen_time_sec: 0.0,
            breaks_taken: 0,
            breaks_skipped: 0,
            natural_breaks: 0,
            snoozes: 0,
            sessions: vec![],
            longest_session_sec: 0.0,
            hourly: vec![0.0; 24],
            video_sec: 0.0,
            video_apps: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreParts {
    pub score: u32,
    pub pacing: f64,
    pub discipline: f64,
    pub pacing_penalty: u32,
    pub discipline_penalty: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDay {
    pub date: String,
    pub score: Option<u32>,
    pub screen_time_sec: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSummary {
    pub today: DayStats,
    pub score: Option<u32>,
    pub parts: Option<ScoreParts>,
    pub history: Vec<HistoryDay>,
}
