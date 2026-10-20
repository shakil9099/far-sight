//! Decides which smart-pause condition (if any) is active from an activity sample.
use crate::types::{PauseReason, Settings};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActivitySample {
    pub front_app: Option<String>,
    pub front_app_id: Option<String>,
    pub fullscreen: bool,
    /// Apps using the microphone ("Microphone" on macOS, which can't attribute it).
    pub mic_apps: Vec<String>,
    /// Apps playing video (holding display-sleep assertions / media sessions).
    pub video_apps: Vec<String>,
}

/// Music players report media sessions too, but aren't video.
const MUSIC_APPS: &[&str] = &["spotify", "music", "itunes", "applemusic", "tidal", "deezer", "amazon music", "foobar2000", "winamp", "musicbee"];

pub fn is_self(name: &str) -> bool {
    let n = name.to_lowercase();
    n == "farsight" || n == "electron" || n == "app.farsight.desktop"
}

fn name_matches(a: &str, b: &str) -> bool {
    let (x, y) = (a.to_lowercase(), b.to_lowercase());
    !x.is_empty() && !y.is_empty() && (x == y || x.contains(&y) || y.contains(&x))
}

/// Case-insensitive match of the frontmost app against a user list (by name or bundle id).
pub fn matches_app(sample: &ActivitySample, list: &[String]) -> Option<String> {
    let candidates: Vec<String> = [&sample.front_app, &sample.front_app_id].iter().filter_map(|s| s.as_ref().map(|s| s.to_lowercase())).collect();
    list.iter()
        .find(|entry| {
            let e = entry.to_lowercase();
            candidates.iter().any(|c| *c == e || c.contains(&e))
        })
        .cloned()
}

/// Friendly app name for helper/OS identifiers (e.g. Safari's WebKit media process).
pub fn normalize_video_app(name: &str) -> String {
    let l = name.to_lowercase();
    if l.starts_with("com.apple.webkit") {
        "Safari".into()
    } else if l == "msedge" {
        "Microsoft Edge".into()
    } else if l == "chrome" {
        "Google Chrome".into()
    } else {
        name.into()
    }
}

/// The app currently playing video, honouring exclusions and the frontmost-only option.
pub fn detect_video(sample: &ActivitySample, s: &Settings) -> Option<String> {
    let apps: Vec<(String, String)> = sample
        .video_apps
        .iter()
        .map(|raw| (raw.clone(), normalize_video_app(raw)))
        .filter(|(raw, name)| !is_self(raw) && !is_self(name))
        .filter(|(_, name)| !MUSIC_APPS.iter().any(|m| name.to_lowercase().contains(m)))
        .filter(|(raw, name)| !s.video_excluded_apps.iter().any(|x| name_matches(name, x) || name_matches(raw, x)))
        // Call apps keep the display awake during calls; those count as meetings, not video.
        .filter(|(raw, name)| !s.meeting_apps.iter().any(|m| name_matches(name, m) || name_matches(raw, m)))
        .collect();
    if apps.is_empty() {
        return None;
    }
    if !s.video_frontmost_only {
        return Some(apps[0].1.clone());
    }
    let front = sample.front_app.as_deref()?;
    apps.into_iter().find(|(raw, name)| name_matches(name, front) || name_matches(raw, front)).map(|(_, n)| n)
}

/// The call in progress, judged from signals rather than which app is in front.
pub fn detect_call(sample: &ActivitySample, s: &Settings) -> Option<String> {
    let is_call_app = |a: &str| s.meeting_apps.iter().any(|m| name_matches(a, m));
    // Video calls and screen sharing keep the display awake, like video players do.
    if let Some(a) = sample.video_apps.iter().find(|a| !is_self(a) && is_call_app(a)) {
        return Some(a.clone());
    }
    // Voice calls: a physical microphone is in use.
    let mic = sample.mic_apps.iter().find(|a| !is_self(a))?;
    if mic != "Microphone" {
        return Some(mic.clone()); // Windows reports the app using the mic
    }
    match sample.front_app.as_deref() {
        Some(front) if is_call_app(front) => Some(front.to_string()),
        _ => Some("Microphone".into()),
    }
}

pub fn detect_smart_pause(sample: &ActivitySample, s: &Settings) -> Option<(PauseReason, Option<String>)> {
    if let Some(f) = matches_app(sample, &s.deep_focus_apps) {
        return Some((PauseReason::DeepFocus, Some(f)));
    }
    if let Some(c) = detect_call(sample, s) {
        return Some((PauseReason::Meeting, Some(c)));
    }
    if s.video_pause_enabled {
        if let Some(v) = detect_video(sample, s) {
            return Some((PauseReason::Video, Some(v)));
        }
    }
    if s.pause_for_fullscreen && sample.fullscreen {
        return Some((PauseReason::Fullscreen, sample.front_app.clone()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(front: &str, video: &[&str], mic: &[&str]) -> ActivitySample {
        ActivitySample {
            front_app: Some(front.into()),
            front_app_id: None,
            fullscreen: false,
            mic_apps: mic.iter().map(|s| s.to_string()).collect(),
            video_apps: video.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn video_frontmost_and_anywhere() {
        let s = Settings::default();
        assert_eq!(detect_video(&sample("Brave Browser", &["Brave Browser"], &[]), &s).as_deref(), Some("Brave Browser"));
        assert_eq!(detect_video(&sample("Code", &["Brave Browser"], &[]), &s), None);
        let any = Settings { video_frontmost_only: false, ..Default::default() };
        assert_eq!(detect_video(&sample("Code", &["Brave Browser"], &[]), &any).as_deref(), Some("Brave Browser"));
    }

    #[test]
    fn video_exclusions_music_and_names() {
        let s = Settings::default();
        let ex = Settings { video_excluded_apps: vec!["brave".into()], ..Default::default() };
        assert_eq!(detect_video(&sample("Brave Browser", &["Brave Browser"], &[]), &ex), None);
        assert_eq!(detect_video(&sample("Spotify", &["Spotify"], &[]), &s), None);
        assert_eq!(detect_video(&sample("zoom.us", &["zoom.us"], &[]), &s), None);
        assert_eq!(detect_video(&sample("Safari", &["com.apple.WebKit.GPU"], &[]), &s).as_deref(), Some("Safari"));
        assert_eq!(detect_video(&sample("msedge", &["MSEdge"], &[]), &s).as_deref(), Some("Microsoft Edge"));
    }

    #[test]
    fn calls_from_signals_not_front_app() {
        let s = Settings::default();
        assert_eq!(detect_call(&sample("WhatsApp", &[], &[]), &s), None);
        assert_eq!(detect_smart_pause(&sample("Microsoft Teams", &[], &[]), &s), None);
        assert_eq!(detect_call(&sample("WhatsApp", &[], &["Microphone"]), &s).as_deref(), Some("WhatsApp"));
        assert_eq!(detect_call(&sample("Code", &[], &["Microphone"]), &s).as_deref(), Some("Microphone"));
        assert_eq!(detect_call(&sample("Code", &[], &["ms-teams"]), &s).as_deref(), Some("ms-teams"));
        assert_eq!(detect_smart_pause(&sample("Code", &["Microsoft Teams"], &[]), &s), Some((PauseReason::Meeting, Some("Microsoft Teams".into()))));
    }

    #[test]
    fn priority_and_quiet() {
        let s = Settings::default();
        let both = sample("Brave Browser", &["Brave Browser", "WhatsApp"], &["Microphone"]);
        assert_eq!(detect_smart_pause(&both, &s).unwrap().0, PauseReason::Meeting);
        assert_eq!(detect_smart_pause(&sample("Brave Browser", &["Brave Browser"], &[]), &Settings { video_pause_enabled: false, ..Default::default() }), None);
        assert!(PauseReason::Meeting.is_quiet() && PauseReason::Video.is_quiet());
        assert!(!PauseReason::DeepFocus.is_quiet() && !PauseReason::Idle.is_quiet());
    }
}
