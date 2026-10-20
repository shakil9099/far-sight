//! What the user is doing right now: front app, microphone, video, fullscreen, idle, lock.
//! A background thread samples every 2 s; idle and lock are cheap and read on demand.
use crate::smartpause::{is_self, ActivitySample};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as os;
#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as os;
#[cfg(not(any(target_os = "macos", windows)))]
mod os {
    pub fn idle_seconds() -> f64 {
        0.0
    }
    pub fn screen_locked() -> bool {
        false
    }
    pub fn start(_: impl Fn(super::RawSample) + Send + 'static) {}
    pub fn running_apps() -> Vec<String> {
        vec![]
    }
}

pub use os::{idle_seconds, running_apps, screen_locked};

/// One raw reading from the OS layer.
#[derive(Debug, Clone, Default)]
pub struct RawSample {
    pub front_app: Option<String>,
    pub front_app_id: Option<String>,
    pub fullscreen: bool,
    pub mic_apps: Vec<String>,
    pub video_apps: Vec<String>,
}

/// Keep video "playing" this long after the last report (buffering, next clip).
const VIDEO_GRACE: Duration = Duration::from_secs(6);

#[derive(Default)]
struct State {
    latest: ActivitySample,
    last_external_front: (Option<String>, Option<String>),
    video_seen: HashMap<String, Instant>,
}

#[derive(Clone, Default)]
pub struct Activity {
    state: Arc<Mutex<State>>,
}

impl Activity {
    pub fn start() -> Self {
        let a = Activity::default();
        let state = a.state.clone();
        os::start(move |raw| {
            let mut st = state.lock().unwrap();
            // When FarSight's own window is in front, keep the app that was in front before it.
            let front_is_self = raw.front_app.as_deref().is_some_and(is_self) || raw.front_app_id.as_deref().is_some_and(is_self);
            if !front_is_self {
                st.last_external_front = (raw.front_app.clone(), raw.front_app_id.clone());
            }
            let now = Instant::now();
            for v in &raw.video_apps {
                st.video_seen.insert(v.clone(), now);
            }
            st.video_seen.retain(|_, t| now.duration_since(*t) <= VIDEO_GRACE);
            let mut video: Vec<String> = st.video_seen.keys().cloned().collect();
            video.sort();
            st.latest = ActivitySample {
                front_app: st.last_external_front.0.clone(),
                front_app_id: st.last_external_front.1.clone(),
                fullscreen: raw.fullscreen,
                mic_apps: raw.mic_apps,
                video_apps: video,
            };
        });
        a
    }

    pub fn sample(&self) -> ActivitySample {
        self.state.lock().unwrap().latest.clone()
    }
}

#[cfg(target_os = "macos")]
pub use mac::configure_overlay;
