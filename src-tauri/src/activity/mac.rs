//! macOS: calls into native/macos.m.
use super::RawSample;
use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::time::Duration;

extern "C" {
    fn fs_mic_in_use() -> c_int;
    fn fs_video_apps(buf: *mut c_char, cap: c_int) -> c_int;
    fn fs_front_app(name: *mut c_char, name_cap: c_int, bundle: *mut c_char, bundle_cap: c_int) -> c_int;
    fn fs_idle_seconds() -> f64;
    fn fs_screen_locked() -> c_int;
    fn fs_configure_overlay(nswindow: *mut std::ffi::c_void, kind: c_int);
}

fn cstr(buf: &[c_char]) -> String {
    unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned()
}

pub fn idle_seconds() -> f64 {
    unsafe { fs_idle_seconds() }
}

pub fn screen_locked() -> bool {
    unsafe { fs_screen_locked() == 1 }
}

/// Raise an NSWindow above fullscreen apps on every Space. Must run on the main thread.
pub fn configure_overlay(ns_window: *mut std::ffi::c_void, break_overlay: bool) {
    unsafe { fs_configure_overlay(ns_window, if break_overlay { 0 } else { 1 }) }
}

fn sample() -> RawSample {
    let mut name = [0 as c_char; 256];
    let mut bundle = [0 as c_char; 256];
    let (front_app, front_app_id) = if unsafe { fs_front_app(name.as_mut_ptr(), 256, bundle.as_mut_ptr(), 256) } == 1 {
        (Some(cstr(&name)).filter(|s| !s.is_empty()), Some(cstr(&bundle)).filter(|s| !s.is_empty()))
    } else {
        (None, None)
    };
    let mut video = [0 as c_char; 4096];
    unsafe { fs_video_apps(video.as_mut_ptr(), 4096) };
    let video_apps = cstr(&video).lines().filter(|l| !l.is_empty()).map(String::from).collect();
    let mic_apps = if unsafe { fs_mic_in_use() } == 1 { vec!["Microphone".to_string()] } else { vec![] };
    RawSample { front_app, front_app_id, fullscreen: false, mic_apps, video_apps }
}

pub fn start(on_sample: impl Fn(RawSample) + Send + 'static) {
    std::thread::Builder::new()
        .name("activity".into())
        .spawn(move || loop {
            on_sample(sample());
            std::thread::sleep(Duration::from_secs(2));
        })
        .expect("spawn activity thread");
}

/// Running regular apps, for the settings "Add an app" picker.
pub fn running_apps() -> Vec<String> {
    let out = std::process::Command::new("lsappinfo").arg("list").output();
    let Ok(out) = out else { return vec![] };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut names: Vec<String> = vec![];
    let mut current: Option<String> = None;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.split_once(") \"").map(|(n, r)| (n, r)).filter(|(n, _)| n.chars().all(|c| c.is_ascii_digit())) {
            current = rest.1.split('"').next().map(String::from);
        } else if t.contains("type=\"Foreground\"") {
            if let Some(n) = current.take() {
                names.push(n);
            }
        }
    }
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}
