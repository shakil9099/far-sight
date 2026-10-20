//! Break timer state machine. Pure logic: time and environment are passed in, so it runs
//! identically on macOS and Windows and is unit-tested below.
use crate::messages::break_copy;
use crate::types::*;
use chrono::{Datelike, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MAX_TICK_SEC: f64 = 5.0;

#[derive(Debug, Clone, Default)]
pub struct TickContext {
    /// Seconds since the last keyboard/mouse input.
    pub idle_sec: f64,
    pub screen_locked: bool,
    pub suspended: bool,
    pub outside_office_hours: bool,
    pub smart_pause: Option<(PauseReason, Option<String>)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    HeadsUp { seconds_left: f64, is_long: bool },
    Countdown,
    BreakStart(BreakInfo),
    BreakComplete,
    BreakEnd { info: BreakInfo, result: BreakResult },
    SkippedInAdvance,
    Snoozed,
    Paused { reason: PauseReason, detail: Option<String> },
    Resumed { reason: PauseReason },
    Returned { away_sec: f64, reset: bool },
    Wellness { blink: bool },
    SessionEnd { length_sec: f64 },
    FocusTick { seconds: f64 },
    DayRollover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakResult {
    Completed,
    Skipped,
    Snoozed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualPause {
    pub until: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentBreak {
    #[serde(flatten)]
    pub info: BreakInfo,
    #[serde(default)]
    pub complete_notified: bool,
}

/// Persisted across app restarts so a relaunch does not reset the cycle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineState {
    pub status: Status,
    pub work_elapsed: f64,
    pub session_elapsed: f64,
    pub breaks_taken: u32,
    pub manual_pause: Option<ManualPause>,
    pub current_break: Option<CurrentBreak>,
    pub snoozes_this_break: u32,
    pub day: String,
    pub snoozes_today: u32,
    pub skips_today: u32,
    pub advance_skips_today: u32,
    pub planned_fired: BTreeMap<String, String>,
}

impl Default for EngineState {
    fn default() -> Self {
        EngineState {
            status: Status::Working,
            work_elapsed: 0.0,
            session_elapsed: 0.0,
            breaks_taken: 0,
            manual_pause: None,
            current_break: None,
            snoozes_this_break: 0,
            day: String::new(),
            snoozes_today: 0,
            skips_today: 0,
            advance_skips_today: 0,
            planned_fired: BTreeMap::new(),
        }
    }
}

pub fn local(ms: f64) -> chrono::DateTime<Local> {
    Local.timestamp_millis_opt(ms as i64).single().unwrap_or_else(Local::now)
}

pub fn day_key(ms: f64) -> String {
    local(ms).format("%Y-%m-%d").to_string()
}

pub struct Engine {
    pub settings: Settings,
    s: EngineState,
    last_tick: Option<f64>,
    auto_pause: Option<(PauseReason, Option<String>)>,
    away_started_at: Option<f64>,
    smart_pause_cooldown_until: f64,
    heads_up_shown: bool,
    countdown_shown: bool,
    blink_elapsed: f64,
    posture_elapsed: f64,
    last_return: Option<(f64, f64)>,
    rand: Box<dyn FnMut() -> f64 + Send>,
}

impl Engine {
    pub fn new(settings: Settings, now: f64, restored: Option<EngineState>, rand: Box<dyn FnMut() -> f64 + Send>) -> Self {
        let mut s = restored.unwrap_or_else(|| EngineState { day: day_key(now), ..Default::default() });
        if s.day.is_empty() {
            s.day = day_key(now);
        }
        if s.status == Status::Break && s.current_break.is_none() {
            s.status = Status::Working;
        }
        // Automatic pauses are re-detected on the first tick; only manual pauses persist.
        if s.status == Status::Paused && s.manual_pause.is_none() {
            s.status = Status::Working;
        }
        if matches!(&s.manual_pause, Some(ManualPause { until: Some(u) }) if *u <= now) {
            s.manual_pause = None;
        }
        Engine {
            settings,
            s,
            last_tick: None,
            auto_pause: None,
            away_started_at: None,
            smart_pause_cooldown_until: 0.0,
            heads_up_shown: false,
            countdown_shown: false,
            blink_elapsed: 0.0,
            posture_elapsed: 0.0,
            last_return: None,
            rand,
        }
    }

    pub fn serialize(&self) -> EngineState {
        self.s.clone()
    }

    // ------------------------------------------------------------ queries

    pub fn next_break_is_long(&self) -> bool {
        let st = &self.settings;
        st.long_break_enabled && st.long_break_every > 0 && (self.s.breaks_taken + 1) % st.long_break_every == 0
    }

    fn remaining(&self) -> f64 {
        (self.settings.work_duration - self.s.work_elapsed).max(0.0)
    }

    fn skip_unlocks_in(&self) -> f64 {
        let Some(b) = &self.s.current_break else { return 0.0 };
        if matches!(b.info.kind, BreakKind::Custom | BreakKind::Planned) {
            return 0.0;
        }
        match self.settings.discipline_level {
            DisciplineLevel::Casual => 0.0,
            DisciplineLevel::Balanced => (self.settings.skip_delay - b.info.elapsed).max(0.0),
            DisciplineLevel::Hardcore => f64::INFINITY,
        }
    }

    pub fn can_skip(&self) -> bool {
        match self.s.status {
            Status::Break => self.skip_unlocks_in() == 0.0,
            Status::Working => {
                self.settings.discipline_level != DisciplineLevel::Hardcore && self.s.advance_skips_today < self.settings.advance_skips_per_day
            }
            _ => false,
        }
    }

    pub fn can_snooze(&self) -> bool {
        if self.settings.discipline_level == DisciplineLevel::Hardcore {
            return false;
        }
        if !matches!(self.s.status, Status::Working | Status::Break) {
            return false;
        }
        if let Some(b) = &self.s.current_break {
            if !matches!(b.info.kind, BreakKind::Short | BreakKind::Long) {
                return false;
            }
        }
        let st = &self.settings;
        if st.snooze_limit_per_break > 0 && self.s.snoozes_this_break >= st.snooze_limit_per_break {
            return false;
        }
        if st.snooze_limit_per_day > 0 && self.s.snoozes_today >= st.snooze_limit_per_day {
            return false;
        }
        true
    }

    pub fn status(&self) -> Status {
        self.s.status
    }

    pub fn pause_reason(&self) -> Option<PauseReason> {
        self.snapshot().pause.map(|p| p.reason)
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        let pause = if self.s.status == Status::Paused {
            if let Some(m) = &self.s.manual_pause {
                Some(PauseInfo { reason: PauseReason::Manual, detail: None, until: m.until })
            } else {
                self.auto_pause.as_ref().map(|(r, d)| PauseInfo { reason: *r, detail: d.clone(), until: None })
            }
        } else {
            None
        };
        let unlock = self.skip_unlocks_in();
        EngineSnapshot {
            status: self.s.status,
            work_elapsed: self.s.work_elapsed,
            work_duration: self.settings.work_duration,
            remaining: self.remaining(),
            next_break_is_long: self.next_break_is_long(),
            breaks_taken: self.s.breaks_taken,
            pause,
            current_break: self.s.current_break.as_ref().map(|b| b.info.clone()),
            snoozes_this_break: self.s.snoozes_this_break,
            snoozes_today: self.s.snoozes_today,
            skips_today: self.s.skips_today,
            advance_skips_today: self.s.advance_skips_today,
            can_skip: self.can_skip(),
            can_snooze: self.can_snooze(),
            skip_unlocks_in: if unlock.is_finite() { unlock } else { -1.0 },
        }
    }

    // ------------------------------------------------------------ tick

    pub fn tick(&mut self, now: f64, ctx: &TickContext) -> Vec<Event> {
        let mut events = vec![];
        let dt = match self.last_tick {
            None => 0.0,
            Some(t) => ((now - t) / 1000.0).clamp(0.0, MAX_TICK_SEC),
        };
        self.last_tick = Some(now);

        let today = day_key(now);
        if today != self.s.day {
            self.s.day = today;
            self.s.snoozes_today = 0;
            self.s.skips_today = 0;
            self.s.advance_skips_today = 0;
            events.push(Event::DayRollover);
        }

        match self.s.status {
            Status::Stopped => return events,
            Status::Break => {
                self.tick_break(dt, &mut events);
                return events;
            }
            _ => {}
        }

        if let Some(m) = self.s.manual_pause.clone() {
            match m.until {
                Some(u) if now >= u => {
                    self.s.manual_pause = None;
                    self.s.status = Status::Working;
                    events.push(Event::Resumed { reason: PauseReason::Manual });
                }
                _ => {
                    self.s.status = Status::Paused;
                    return events;
                }
            }
        }

        self.update_auto_pause(now, ctx, &mut events);
        if let Some((reason, _)) = &self.auto_pause {
            let reason = *reason;
            self.s.status = Status::Paused;
            if self.settings.reminders_during_pause && reason.is_smart() && !reason.is_quiet() {
                self.tick_wellness(dt, &mut events);
            }
            return events;
        }
        self.s.status = Status::Working;

        self.s.work_elapsed += dt;
        self.s.session_elapsed += dt;
        if dt > 0.0 {
            events.push(Event::FocusTick { seconds: dt });
        }
        self.tick_wellness(dt, &mut events);

        if self.check_planned(now, &mut events) {
            return events;
        }

        let remaining = self.remaining();
        let st = &self.settings;
        if st.reminder_enabled && !self.heads_up_shown && remaining <= st.reminder_threshold && remaining > 0.0 {
            self.heads_up_shown = true;
            events.push(Event::HeadsUp { seconds_left: remaining, is_long: self.next_break_is_long() });
        }
        let st = &self.settings;
        if st.countdown_enabled && !self.countdown_shown && remaining <= st.countdown_threshold && remaining > 0.0 {
            self.countdown_shown = true;
            events.push(Event::Countdown);
        }
        if remaining <= 0.0 && now >= self.smart_pause_cooldown_until {
            let kind = if self.next_break_is_long() { BreakKind::Long } else { BreakKind::Short };
            events.extend(self.start_break(kind, now, None, None, None));
        }
        events
    }

    fn tick_break(&mut self, dt: f64, events: &mut Vec<Event>) {
        let hold = self.settings.hold_break_until_ended;
        let b = self.s.current_break.as_mut().expect("break");
        b.info.elapsed = (b.info.elapsed + dt).min(b.info.duration);
        if b.info.elapsed >= b.info.duration {
            if hold {
                if !b.complete_notified {
                    b.complete_notified = true;
                    events.push(Event::BreakComplete);
                }
            } else {
                events.extend(self.finish_break(BreakResult::Completed));
            }
        }
    }

    fn tick_wellness(&mut self, dt: f64, events: &mut Vec<Event>) {
        let st = &self.settings;
        if st.blink_reminder_enabled && st.blink_reminder_frequency > 0.0 {
            self.blink_elapsed += dt;
            if self.blink_elapsed >= st.blink_reminder_frequency {
                self.blink_elapsed = 0.0;
                events.push(Event::Wellness { blink: true });
            }
        }
        if st.posture_reminder_enabled && st.posture_reminder_frequency > 0.0 {
            self.posture_elapsed += dt;
            if self.posture_elapsed >= st.posture_reminder_frequency {
                self.posture_elapsed = 0.0;
                events.push(Event::Wellness { blink: false });
            }
        }
    }

    fn update_auto_pause(&mut self, now: f64, ctx: &TickContext, events: &mut Vec<Event>) {
        let st = self.settings.clone();
        let (reason, away): (Option<(PauseReason, Option<String>)>, bool) = if ctx.suspended {
            (Some((PauseReason::Suspended, None)), true)
        } else if ctx.screen_locked {
            (Some((PauseReason::ScreenLocked, None)), true)
        } else if st.idle_pause_enabled && ctx.idle_sec >= st.idle_time_for_pause {
            (Some((PauseReason::Idle, None)), true)
        } else if st.office_hours_enabled && ctx.outside_office_hours {
            (Some((PauseReason::OfficeHours, None)), false)
        } else {
            (ctx.smart_pause.clone(), false)
        };

        if away && self.away_started_at.is_none() {
            // Idle is detected after the fact: the user actually left idle_sec ago.
            self.away_started_at = Some(now - ctx.idle_sec * 1000.0);
            let correction = self.s.work_elapsed.min(ctx.idle_sec);
            self.s.work_elapsed -= correction;
            self.s.session_elapsed = (self.s.session_elapsed - correction).max(0.0);
        } else if !away {
            if let Some(start) = self.away_started_at.take() {
                let away_sec = (now - start) / 1000.0;
                if st.idle_reset_enabled && away_sec >= st.idle_time_for_reset {
                    self.last_return = Some((self.s.work_elapsed, self.s.session_elapsed));
                    if self.s.session_elapsed > 0.0 {
                        events.push(Event::SessionEnd { length_sec: self.s.session_elapsed });
                    }
                    self.reset_cycle();
                    events.push(Event::Returned { away_sec, reset: true });
                } else {
                    self.last_return = None;
                    events.push(Event::Returned { away_sec, reset: false });
                }
            }
        }

        let prev = self.auto_pause.clone();
        if let Some((r, d)) = &reason {
            if prev.as_ref() != Some(&(*r, d.clone())) {
                events.push(Event::Paused { reason: *r, detail: d.clone() });
            }
        }
        if reason.is_none() {
            if let Some((r, _)) = prev {
                events.push(Event::Resumed { reason: r });
                if r.is_smart() {
                    self.smart_pause_cooldown_until = now + st.smart_pause_cooldown * 1000.0;
                }
            }
        }
        self.auto_pause = reason;
    }

    /// Returns true if a planned break started.
    fn check_planned(&mut self, now: f64, events: &mut Vec<Event>) -> bool {
        let d = local(now);
        let weekday = d.weekday().num_days_from_sunday();
        let minutes = d.hour() * 60 + d.minute();
        let today = day_key(now);
        let planned = self.settings.planned_breaks.clone();
        for pb in planned {
            if !pb.enabled || !pb.days.contains(&weekday) {
                continue;
            }
            if self.s.planned_fired.get(&pb.id) == Some(&today) {
                continue;
            }
            let at = pb.time.hour * 60 + pb.time.minute;
            // Fire at the scheduled minute, or late (up to 2 h) if it was waiting on a pause.
            if minutes < at || minutes > at + 120 {
                continue;
            }
            self.s.planned_fired.insert(pb.id.clone(), today);
            events.extend(self.start_break(BreakKind::Planned, now, Some(pb.duration_min as f64 * 60.0), Some(pb.id.clone()), Some(pb.name.clone())));
            return true;
        }
        false
    }

    // ------------------------------------------------------------ commands

    pub fn start_break(&mut self, kind: BreakKind, now: f64, duration: Option<f64>, planned_id: Option<String>, planned_name: Option<String>) -> Vec<Event> {
        if self.s.status == Status::Break {
            return vec![];
        }
        let mut events = vec![];
        if self.s.session_elapsed > 0.0 {
            events.push(Event::SessionEnd { length_sec: self.s.session_elapsed });
        }
        let st = &self.settings;
        let duration = duration.unwrap_or(if kind == BreakKind::Long { st.long_break_duration } else { st.short_break_duration });
        let (title, message) = break_copy(kind, &st.custom_short_titles.clone(), &st.custom_long_titles.clone(), planned_name.as_deref(), &mut *self.rand);
        self.s.manual_pause = None;
        self.s.status = Status::Break;
        let info = BreakInfo { kind, title, message, duration, elapsed: 0.0, started_at: now, planned_id };
        self.s.current_break = Some(CurrentBreak { info: info.clone(), complete_notified: false });
        events.push(Event::BreakStart(info));
        events
    }

    /// Skip during a break, or skip the next break in advance while working.
    pub fn skip(&mut self) -> Vec<Event> {
        if !self.can_skip() {
            return vec![];
        }
        if self.s.status == Status::Break {
            self.s.skips_today += 1;
            return self.finish_break(BreakResult::Skipped);
        }
        self.s.advance_skips_today += 1;
        self.s.breaks_taken += 1;
        self.reset_cycle();
        vec![Event::SkippedInAdvance]
    }

    /// End a break early: allowed once complete, within the last 10 s, or for custom/planned breaks.
    pub fn end_break(&mut self) -> Vec<Event> {
        let Some(b) = &self.s.current_break else { return vec![] };
        if b.info.duration - b.info.elapsed > 10.0 && !matches!(b.info.kind, BreakKind::Custom | BreakKind::Planned) {
            return self.skip();
        }
        self.finish_break(BreakResult::Completed)
    }

    pub fn snooze(&mut self, seconds: f64) -> Vec<Event> {
        if !self.can_snooze() {
            return vec![];
        }
        let mut events = vec![];
        self.s.snoozes_this_break += 1;
        self.s.snoozes_today += 1;
        if self.s.status == Status::Break {
            let b = self.s.current_break.take().expect("break");
            self.s.status = Status::Working;
            events.push(Event::BreakEnd { info: b.info, result: BreakResult::Snoozed });
            self.s.work_elapsed = (self.settings.work_duration - seconds).max(0.0);
        } else {
            self.s.work_elapsed = (self.s.work_elapsed.min(self.settings.work_duration) - seconds).max(0.0);
        }
        self.heads_up_shown = false;
        self.countdown_shown = false;
        events.push(Event::Snoozed);
        events
    }

    pub fn pause(&mut self, now: f64, seconds: Option<f64>) -> Vec<Event> {
        if matches!(self.s.status, Status::Stopped | Status::Break) {
            return vec![];
        }
        self.s.manual_pause = Some(ManualPause { until: seconds.map(|s| now + s * 1000.0) });
        self.s.status = Status::Paused;
        vec![Event::Paused { reason: PauseReason::Manual, detail: None }]
    }

    pub fn resume(&mut self) -> Vec<Event> {
        if self.s.status == Status::Stopped {
            self.s.status = Status::Working;
            return vec![Event::Resumed { reason: PauseReason::Manual }];
        }
        if self.s.manual_pause.take().is_none() {
            return vec![];
        }
        self.s.status = Status::Working;
        vec![Event::Resumed { reason: PauseReason::Manual }]
    }

    /// Reset timers and the long-break cycle.
    pub fn restart(&mut self) -> Vec<Event> {
        let mut events = vec![];
        if self.s.session_elapsed > 0.0 {
            events.push(Event::SessionEnd { length_sec: self.s.session_elapsed });
        }
        if let Some(b) = self.s.current_break.take() {
            events.push(Event::BreakEnd { info: b.info, result: BreakResult::Skipped });
        }
        self.s.breaks_taken = 0;
        self.s.manual_pause = None;
        self.s.status = Status::Working;
        self.reset_cycle();
        events
    }

    pub fn stop(&mut self) -> Vec<Event> {
        let events = self.restart();
        self.s.status = Status::Stopped;
        events
    }

    /// Flip the most recent idle-return decision back to "keep my session".
    pub fn undo_return_reset(&mut self) -> bool {
        let Some((w, s)) = self.last_return.take() else { return false };
        self.s.work_elapsed = w;
        self.s.session_elapsed = s;
        true
    }

    // ------------------------------------------------------------ internals

    fn finish_break(&mut self, result: BreakResult) -> Vec<Event> {
        let Some(b) = self.s.current_break.take() else { return vec![] };
        self.s.status = Status::Working;
        if matches!(b.info.kind, BreakKind::Short | BreakKind::Long) {
            self.s.breaks_taken += 1;
        }
        self.reset_cycle();
        vec![Event::BreakEnd { info: b.info, result }]
    }

    fn reset_cycle(&mut self) {
        self.s.work_elapsed = 0.0;
        self.s.session_elapsed = 0.0;
        self.s.snoozes_this_break = 0;
        self.heads_up_shown = false;
        self.countdown_shown = false;
        self.blink_elapsed = 0.0;
        self.posture_elapsed = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> f64 {
        Local.with_ymd_and_hms(2026, 10, 20, 10, 0, 0).unwrap().timestamp_millis() as f64
    }

    fn settings() -> Settings {
        Settings { work_duration: 60.0, short_break_duration: 10.0, long_break_duration: 30.0, long_break_every: 3, ..Default::default() }
    }

    fn engine(s: Settings) -> Engine {
        let mut e = Engine::new(s, t0(), None, Box::new(|| 0.0));
        e.tick(t0(), &TickContext::default());
        e
    }

    /// Advance second by second; returns (events, now).
    fn run(e: &mut Engine, from: f64, secs: u32, ctx: impl Fn(u32) -> TickContext) -> (Vec<Event>, f64) {
        let mut ev = vec![];
        for i in 1..=secs {
            ev.extend(e.tick(from + i as f64 * 1000.0, &ctx(i)));
        }
        (ev, from + secs as f64 * 1000.0)
    }
    fn plain(_: u32) -> TickContext {
        TickContext::default()
    }

    #[test]
    fn short_break_after_work_then_back_to_work() {
        let mut e = engine(settings());
        let (ev, now) = run(&mut e, t0(), 60, plain);
        assert!(ev.iter().any(|x| matches!(x, Event::BreakStart(_))));
        assert_eq!(e.snapshot().current_break.unwrap().kind, BreakKind::Short);
        let (ev, _) = run(&mut e, now, 10, plain);
        assert!(ev.iter().any(|x| matches!(x, Event::BreakEnd { result: BreakResult::Completed, .. })));
        assert_eq!(e.status(), Status::Working);
        assert_eq!(e.snapshot().breaks_taken, 1);
    }

    #[test]
    fn every_third_break_is_long() {
        let mut e = engine(settings());
        let mut now = t0();
        let mut kinds = vec![];
        for _ in 0..3 {
            now = run(&mut e, now, 60, plain).1;
            let b = e.snapshot().current_break.unwrap();
            kinds.push(b.kind);
            now = run(&mut e, now, b.duration as u32, plain).1;
        }
        assert_eq!(kinds, vec![BreakKind::Short, BreakKind::Short, BreakKind::Long]);
    }

    #[test]
    fn heads_up_then_countdown() {
        let mut e = engine(Settings { reminder_threshold: 30.0, countdown_threshold: 10.0, ..settings() });
        let (ev, _) = run(&mut e, t0(), 59, plain);
        let hu = ev.iter().position(|x| matches!(x, Event::HeadsUp { .. })).unwrap();
        let cd = ev.iter().position(|x| matches!(x, Event::Countdown)).unwrap();
        assert!(hu < cd);
        assert_eq!(ev.iter().filter(|x| matches!(x, Event::HeadsUp { .. })).count(), 1);
    }

    #[test]
    fn snooze_during_break_and_limits() {
        let mut e = engine(settings());
        let now = run(&mut e, t0(), 60, plain).1;
        e.snooze(20.0);
        assert_eq!(e.status(), Status::Working);
        assert_eq!(e.snapshot().remaining, 20.0);
        run(&mut e, now, 20, plain);
        assert_eq!(e.status(), Status::Break);

        let mut e = engine(Settings { snooze_limit_per_break: 1, ..settings() });
        run(&mut e, t0(), 30, plain);
        assert!(!e.snooze(10.0).is_empty());
        assert!(!e.can_snooze());
        assert!(e.snooze(10.0).is_empty());
    }

    #[test]
    fn balanced_and_hardcore_skip_rules() {
        let mut e = engine(Settings { discipline_level: DisciplineLevel::Balanced, skip_delay: 5.0, ..settings() });
        let now = run(&mut e, t0(), 60, plain).1;
        assert!(!e.can_skip());
        run(&mut e, now, 5, plain);
        assert!(e.can_skip());
        assert!(matches!(e.skip().as_slice(), [Event::BreakEnd { .. }]));

        let mut h = engine(Settings { discipline_level: DisciplineLevel::Hardcore, ..settings() });
        run(&mut h, t0(), 60, plain);
        assert!(!h.can_skip() && !h.can_snooze());
        assert_eq!(h.snapshot().skip_unlocks_in, -1.0);
    }

    #[test]
    fn hold_until_end_break() {
        let mut e = engine(Settings { hold_break_until_ended: true, ..settings() });
        let now = run(&mut e, t0(), 60, plain).1;
        let (ev, _) = run(&mut e, now, 15, plain);
        assert!(ev.contains(&Event::BreakComplete));
        assert_eq!(e.status(), Status::Break);
        assert!(matches!(e.end_break().as_slice(), [Event::BreakEnd { .. }]));
    }

    #[test]
    fn idle_pause_and_reset_after_long_absence() {
        let mut e = engine(Settings { work_duration: 600.0, idle_time_for_pause: 30.0, idle_time_for_reset: 120.0, ..settings() });
        let now = run(&mut e, t0(), 100, plain).1;
        let now = run(&mut e, now, 200, |i| TickContext { idle_sec: i as f64, ..Default::default() }).1;
        assert_eq!(e.snapshot().pause.unwrap().reason, PauseReason::Idle);
        let (ev, _) = run(&mut e, now, 1, plain);
        assert!(ev.iter().any(|x| matches!(x, Event::Returned { reset: true, .. })));
        assert!(e.snapshot().work_elapsed < 2.0);
    }

    #[test]
    fn idle_short_absence_resumes_and_subtracts_idle() {
        let mut e = engine(Settings { work_duration: 600.0, idle_time_for_pause: 30.0, idle_time_for_reset: 300.0, ..settings() });
        let now = run(&mut e, t0(), 100, plain).1;
        let now = run(&mut e, now, 60, |i| TickContext { idle_sec: i as f64, ..Default::default() }).1;
        let (ev, _) = run(&mut e, now, 1, plain);
        assert!(ev.iter().any(|x| matches!(x, Event::Returned { reset: false, .. })));
        let w = e.snapshot().work_elapsed;
        assert!(w > 99.0 && w < 103.0, "{w}");
    }

    #[test]
    fn smart_pause_with_cooldown() {
        let mut e = engine(Settings { smart_pause_cooldown: 10.0, ..settings() });
        let now = run(&mut e, t0(), 55, plain).1;
        let now = run(&mut e, now, 30, |_| TickContext { smart_pause: Some((PauseReason::Meeting, Some("Zoom".into()))), ..Default::default() }).1;
        assert_eq!(e.status(), Status::Paused);
        assert!((e.snapshot().work_elapsed - 55.0).abs() < 0.01);
        let now = run(&mut e, now, 8, plain).1;
        assert_eq!(e.status(), Status::Working);
        assert_eq!(e.snapshot().remaining, 0.0);
        run(&mut e, now, 3, plain);
        assert_eq!(e.status(), Status::Break);
    }

    #[test]
    fn video_pause_stops_and_resumes_clock() {
        let mut e = engine(Settings { work_duration: 600.0, smart_pause_cooldown: 0.0, ..settings() });
        let now = run(&mut e, t0(), 100, plain).1;
        let now = run(&mut e, now, 300, |_| TickContext { smart_pause: Some((PauseReason::Video, Some("Brave Browser".into()))), ..Default::default() }).1;
        assert_eq!(e.snapshot().pause.unwrap().reason, PauseReason::Video);
        assert!((e.snapshot().work_elapsed - 100.0).abs() < 0.01);
        run(&mut e, now, 10, plain);
        assert!((e.snapshot().work_elapsed - 110.0).abs() < 0.01);
    }

    #[test]
    fn manual_pause_expires() {
        let mut e = engine(settings());
        e.pause(t0(), Some(30.0));
        let now = run(&mut e, t0(), 29, plain).1;
        assert_eq!(e.status(), Status::Paused);
        let (ev, _) = run(&mut e, now, 2, plain);
        assert!(ev.contains(&Event::Resumed { reason: PauseReason::Manual }));
        assert_eq!(e.status(), Status::Working);
    }

    #[test]
    fn advance_skip_limited_per_day() {
        let mut e = engine(Settings { advance_skips_per_day: 1, discipline_level: DisciplineLevel::Casual, ..settings() });
        run(&mut e, t0(), 40, plain);
        assert_eq!(e.skip(), vec![Event::SkippedInAdvance]);
        assert_eq!(e.snapshot().work_elapsed, 0.0);
        assert!(!e.can_skip());
    }

    #[test]
    fn planned_break_fires_once() {
        let at = Local.with_ymd_and_hms(2026, 10, 20, 12, 30, 0).unwrap().timestamp_millis() as f64; // Tuesday
        let pb = PlannedBreak { id: "lunch".into(), name: "Lunch".into(), time: TimeOfDay { hour: 12, minute: 30 }, duration_min: 1, days: vec![2], enabled: true };
        let mut e = Engine::new(Settings { work_duration: 3600.0, planned_breaks: vec![pb], ..settings() }, at - 5000.0, None, Box::new(|| 0.0));
        e.tick(at - 5000.0, &TickContext::default());
        let now = run(&mut e, at - 5000.0, 6, plain).1;
        let b = e.snapshot().current_break.unwrap();
        assert_eq!((b.kind, b.title.as_str()), (BreakKind::Planned, "Lunch"));
        let now = run(&mut e, now, 61, plain).1;
        assert_eq!(e.status(), Status::Working);
        run(&mut e, now, 30, plain);
        assert_eq!(e.status(), Status::Working);
    }

    #[test]
    fn restored_auto_pause_starts_working() {
        let st = EngineState { status: Status::Paused, day: day_key(t0()), ..Default::default() };
        let e = Engine::new(settings(), t0(), Some(st), Box::new(|| 0.0));
        assert_eq!(e.status(), Status::Working);
        let st = EngineState { status: Status::Paused, manual_pause: Some(ManualPause { until: None }), day: day_key(t0()), ..Default::default() };
        let e = Engine::new(settings(), t0(), Some(st), Box::new(|| 0.0));
        assert_eq!(e.snapshot().pause.unwrap().reason, PauseReason::Manual);
    }

    #[test]
    fn state_survives_restart_and_json() {
        let mut e = engine(settings());
        run(&mut e, t0(), 25, plain);
        let json = serde_json::to_string(&e.serialize()).unwrap();
        assert!(json.contains("\"workElapsed\""));
        let restored: EngineState = serde_json::from_str(&json).unwrap();
        let e2 = Engine::new(settings(), t0() + 60_000.0, Some(restored), Box::new(|| 0.0));
        assert!((e2.snapshot().work_elapsed - 25.0).abs() < 0.01);
    }
}
