//! Daily usage statistics and the Screen Score (0-100).
use crate::engine::{day_key, local};
use crate::types::*;
use chrono::Timelike;
use std::collections::BTreeMap;

/// Screen Score: 60% session pacing (sessions within the target length) + 40% break discipline
/// (taken vs skipped, snoozes as a partial miss). None until there are 15 minutes of screen time.
pub fn score_parts(day: &DayStats, target_session_sec: f64) -> Option<ScoreParts> {
    if day.screen_time_sec < 15.0 * 60.0 {
        return None;
    }
    let sessions: Vec<f64> = day.sessions.iter().copied().filter(|s| *s >= 60.0).collect();
    let mut pacing = 1.0;
    if !sessions.is_empty() {
        let (mut weighted, mut total) = (0.0, 0.0);
        for len in &sessions {
            let q = if *len <= target_session_sec { 1.0 } else { (target_session_sec / len).max(0.0) };
            weighted += q * len;
            total += len;
        }
        pacing = weighted / total;
    }
    let good = (day.breaks_taken + day.natural_breaks) as f64;
    let bad = day.breaks_skipped as f64 + day.snoozes as f64 * 0.25;
    let discipline = if good + bad == 0.0 { 1.0 } else { good / (good + bad) };
    Some(ScoreParts {
        score: (100.0 * (0.6 * pacing + 0.4 * discipline)).round() as u32,
        pacing,
        discipline,
        pacing_penalty: (60.0 * (1.0 - pacing)).round() as u32,
        discipline_penalty: (40.0 * (1.0 - discipline)).round() as u32,
    })
}

#[derive(Default)]
pub struct StatsBook {
    pub days: BTreeMap<String, DayStats>,
}

impl StatsBook {
    pub fn new(days: BTreeMap<String, DayStats>) -> Self {
        StatsBook { days }
    }

    pub fn day(&mut self, now: f64) -> &mut DayStats {
        let key = day_key(now);
        let d = self.days.entry(key.clone()).or_insert_with(|| DayStats { date: key, ..Default::default() });
        if d.hourly.len() != 24 {
            d.hourly.resize(24, 0.0);
        }
        d
    }

    pub fn add_focus(&mut self, now: f64, seconds: f64) {
        let hour = local(now).hour() as usize;
        let d = self.day(now);
        d.screen_time_sec += seconds;
        d.hourly[hour] += seconds;
    }

    pub fn add_video(&mut self, now: f64, seconds: f64, app: &str) {
        let d = self.day(now);
        d.video_sec += seconds;
        *d.video_apps.entry(app.to_string()).or_insert(0.0) += seconds;
    }

    pub fn end_session(&mut self, now: f64, length_sec: f64) {
        if length_sec < 30.0 {
            return;
        }
        let d = self.day(now);
        d.sessions.push(length_sec.round());
        d.longest_session_sec = d.longest_session_sec.max(length_sec.round());
    }

    pub fn break_taken(&mut self, now: f64) {
        self.day(now).breaks_taken += 1;
    }
    pub fn break_skipped(&mut self, now: f64) {
        self.day(now).breaks_skipped += 1;
    }
    pub fn natural_break(&mut self, now: f64) {
        self.day(now).natural_breaks += 1;
    }
    pub fn snoozed(&mut self, now: f64) {
        self.day(now).snoozes += 1;
    }

    /// Drop days older than `keep_days`.
    pub fn prune(&mut self, now: f64, keep_days: i64) {
        let cutoff = day_key(now - keep_days as f64 * 86_400_000.0);
        self.days.retain(|k, _| *k >= cutoff);
    }

    pub fn summary(&mut self, now: f64, target_session_sec: f64) -> StatsSummary {
        let today = self.day(now).clone();
        let history = (0..7)
            .rev()
            .map(|i| {
                let key = day_key(now - i as f64 * 86_400_000.0);
                let d = self.days.get(&key).cloned().unwrap_or(DayStats { date: key.clone(), ..Default::default() });
                HistoryDay { date: key, score: score_parts(&d, target_session_sec).map(|p| p.score), screen_time_sec: d.screen_time_sec }
            })
            .collect();
        let parts = score_parts(&today, target_session_sec);
        StatsSummary { score: parts.as_ref().map(|p| p.score), parts, today, history }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_needs_screen_time_and_rewards_breaks() {
        let mut d = DayStats { date: "2026-10-20".into(), ..Default::default() };
        assert!(score_parts(&d, 1200.0).is_none());
        d.screen_time_sec = 3600.0;
        d.sessions = vec![1200.0, 1200.0, 1200.0];
        d.breaks_taken = 3;
        assert_eq!(score_parts(&d, 1200.0).unwrap().score, 100);
        d.sessions = vec![3600.0];
        d.breaks_taken = 0;
        d.breaks_skipped = 3;
        assert_eq!(score_parts(&d, 1200.0).unwrap().score, 20);
    }

    #[test]
    fn hourly_buckets_video_and_legacy_days() {
        let now = chrono::TimeZone::with_ymd_and_hms(&chrono::Local, 2026, 10, 20, 10, 0, 0).unwrap().timestamp_millis() as f64;
        let legacy: BTreeMap<String, DayStats> = serde_json::from_str(r#"{"2026-10-20":{"date":"2026-10-20","screenTimeSec":10,"hourly":[]}}"#).unwrap();
        let mut book = StatsBook::new(legacy);
        book.add_focus(now, 30.0);
        book.add_focus(now, 30.0);
        book.add_video(now, 120.0, "Brave Browser");
        book.add_video(now, 30.0, "VLC");
        let d = book.day(now);
        assert_eq!(d.hourly[10], 60.0);
        assert_eq!(d.video_sec, 150.0);
        assert_eq!(d.video_apps["Brave Browser"], 120.0);
        assert_eq!(book.summary(now, 1200.0).history.len(), 7);
    }
}
