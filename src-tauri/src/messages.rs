//! Break-screen copy and time formatting.
use crate::types::BreakKind;

const SHORT_TITLES: &[&str] = &["Eyes on the horizon", "Rest your eyes", "A short pause", "Look somewhere far", "Blink and breathe"];
const SHORT_MESSAGES: &[&str] = &[
    "Pick something at least six metres away and let your focus soften.",
    "Let your eyes drift to the farthest point you can see.",
    "Relax your shoulders, unclench your jaw, and look into the distance.",
    "Gaze out of a window or across the room until the timer ends.",
];
const LONG_TITLES: &[&str] = &["Time for a real break", "Step away for a bit", "Stretch it out", "Recharge"];
const LONG_MESSAGES: &[&str] = &[
    "Stand up, walk around and give your eyes and back a proper rest.",
    "Grab some water, stretch your legs and come back refreshed.",
    "Move your body. Your next focus session will thank you.",
];
const CUSTOM_TITLES: &[&str] = &["Your break", "Time for yourself"];
const CUSTOM_MESSAGES: &[&str] = &["You asked for this break. Enjoy every second of it."];
const PLANNED_MESSAGES: &[&str] = &["You scheduled this one. Make the most of it."];

fn pick(list: &[String], r: f64) -> String {
    list[((r * list.len() as f64) as usize).min(list.len() - 1)].clone()
}

fn owned(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

pub fn break_copy(kind: BreakKind, custom_short: &[String], custom_long: &[String], planned_name: Option<&str>, rand: &mut dyn FnMut() -> f64) -> (String, String) {
    match kind {
        BreakKind::Short => {
            let titles = if custom_short.is_empty() { owned(SHORT_TITLES) } else { custom_short.to_vec() };
            (pick(&titles, rand()), pick(&owned(SHORT_MESSAGES), rand()))
        }
        BreakKind::Long => {
            let titles = if custom_long.is_empty() { owned(LONG_TITLES) } else { custom_long.to_vec() };
            (pick(&titles, rand()), pick(&owned(LONG_MESSAGES), rand()))
        }
        BreakKind::Planned => (
            planned_name.filter(|n| !n.is_empty()).unwrap_or("Planned break").to_string(),
            pick(&owned(PLANNED_MESSAGES), rand()),
        ),
        BreakKind::Custom => (pick(&owned(CUSTOM_TITLES), rand()), pick(&owned(CUSTOM_MESSAGES), rand())),
    }
}

pub fn format_duration(total_sec: f64) -> String {
    let s = total_sec.max(0.0).round() as i64;
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 {
        return if m > 0 { format!("{h} hr {m} min") } else { format!("{h} hr") };
    }
    if m > 0 {
        return if sec > 0 && m < 5 { format!("{m} min {sec} sec") } else { format!("{m} min") };
    }
    format!("{sec} sec")
}

pub fn format_clock(total_sec: f64) -> String {
    let s = total_sec.max(0.0).ceil() as i64;
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 {
        format!("{h}:{m:02}:{sec:02}")
    } else {
        format!("{m}:{sec:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_times() {
        assert_eq!(format_clock(1200.0), "20:00");
        assert_eq!(format_clock(65.2), "1:06");
        assert_eq!(format_clock(3661.0), "1:01:01");
        assert_eq!(format_duration(90.0), "1 min 30 sec");
        assert_eq!(format_duration(3600.0), "1 hr");
        assert_eq!(format_duration(42.0), "42 sec");
    }

    #[test]
    fn uses_custom_and_planned_titles() {
        let mut r = || 0.0;
        assert_eq!(break_copy(BreakKind::Short, &["Mine".into()], &[], None, &mut r).0, "Mine");
        assert_eq!(break_copy(BreakKind::Planned, &[], &[], Some("Lunch"), &mut r).0, "Lunch");
    }
}
