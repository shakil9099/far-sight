//! Creation and placement of every FarSight window.
use crate::types::Settings;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalPosition, Rect, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const POPOVER_SIZE: (f64, f64) = (400.0, 590.0);

#[cfg(target_os = "macos")]
pub const PLATFORM: &str = "darwin";
#[cfg(windows)]
pub const PLATFORM: &str = "win32";
#[cfg(not(any(target_os = "macos", windows)))]
pub const PLATFORM: &str = "linux";

/// Every page reads its parameters from `window.__FS` (set before any page script runs).
fn init_script(params: Value) -> String {
    format!("window.__FS = {};", json!({ "platform": PLATFORM, "params": params }))
}

fn builder<'a>(app: &'a AppHandle, label: &'a str, page: &str, params: Value) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into())).initialization_script(init_script(params)).visible(false)
}

/// On macOS raise above fullscreen apps on every Space (must run on the main thread).
fn raise(app: &AppHandle, win: &WebviewWindow, break_overlay: bool) {
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(ns) = w.ns_window() {
                crate::activity::configure_overlay(ns, break_overlay);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, win, break_overlay);
}

fn monitor_logical(m: &Monitor) -> (f64, f64, f64, f64) {
    let s = m.scale_factor();
    let p = m.position();
    let z = m.size();
    (p.x as f64 / s, p.y as f64 / s, z.width as f64 / s, z.height as f64 / s)
}

fn work_area_logical(m: &Monitor) -> (f64, f64, f64, f64) {
    let s = m.scale_factor();
    let a = m.work_area();
    (a.position.x as f64 / s, a.position.y as f64 / s, a.size.width as f64 / s, a.size.height as f64 / s)
}

fn cursor_monitor(app: &AppHandle) -> Option<Monitor> {
    let c = app.cursor_position().ok()?;
    app.monitor_from_point(c.x, c.y).ok().flatten().or_else(|| app.primary_monitor().ok().flatten())
}

// ------------------------------------------------------------------ break overlays

pub fn open_break_windows(app: &AppHandle, settings: &Settings) {
    close_break_windows(app);
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    let blur = settings.break_background == "blur";
    for (i, m) in monitors.iter().enumerate() {
        let is_primary = primary.as_ref().map(|p| p.position() == m.position()).unwrap_or(i == 0);
        let (x, y, w, h) = monitor_logical(m);
        let label = format!("break-{i}");
        let mut b = builder(app, &label, "break.html", json!({ "primary": is_primary }))
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .shadow(false)
            .position(x, y)
            .inner_size(w, h)
            .focused(is_primary)
            .transparent(blur);
        if blur {
            #[cfg(target_os = "macos")]
            let effect = Effect::FullScreenUI;
            #[cfg(not(target_os = "macos"))]
            let effect = Effect::Acrylic;
            b = b.effects(EffectsBuilder::new().effect(effect).state(EffectState::Active).build());
        }
        if let Ok(win) = b.build() {
            raise(app, &win, true);
            let _ = win.show();
            if is_primary {
                let _ = win.set_focus();
            }
        }
    }
}

pub fn close_break_windows(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with("break-") {
            let _ = w.destroy();
        }
    }
}

/// Keep the primary break window focused (Hardcore mode).
pub fn refocus_break(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("break-0") {
        let _ = w.set_focus();
    }
}

// ------------------------------------------------------------------ countdown following the cursor

pub struct Countdown {
    running: Arc<AtomicBool>,
}

impl Countdown {
    pub fn show(app: &AppHandle) -> Option<Countdown> {
        let win = builder(app, "countdown", "countdown.html", json!({}))
            .inner_size(150.0, 56.0)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .shadow(false)
            .focused(false)
            .build()
            .ok()?;
        let _ = win.set_ignore_cursor_events(true);
        raise(app, &win, false);
        let running = Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let handle = app.clone();
        std::thread::spawn(move || {
            let mut shown = false;
            while flag.load(Ordering::Relaxed) {
                if let Ok(c) = handle.cursor_position() {
                    let _ = win.set_position(PhysicalPosition::new(c.x as i32 + 24, c.y as i32 + 30));
                    if !shown {
                        let _ = win.show();
                        shown = true;
                    }
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            let _ = win.destroy();
        });
        Some(Countdown { running })
    }

    pub fn hide(self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

// ------------------------------------------------------------------ toasts

/// kinds: heads-up | returned | paused | wellness | notice | info
pub fn show_toast(app: &AppHandle, kind: &str, payload: Value, position: &str) -> Option<WebviewWindow> {
    close_toast(app, kind);
    let (w, h) = match kind {
        "wellness" | "notice" => (340.0, 92.0),
        "heads-up" => (420.0, 150.0),
        _ => (420.0, 124.0),
    };
    let label = format!("toast-{kind}");
    let win = builder(app, &label, "toast.html", json!({ "kind": kind, "payload": payload }))
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .shadow(false)
        .focused(false)
        .build()
        .ok()?;
    if kind == "notice" {
        if let Ok(c) = app.cursor_position() {
            let _ = win.set_position(PhysicalPosition::new(c.x as i32 + 12, c.y as i32 + 12));
        }
    } else if let Some(m) = cursor_monitor(app) {
        let (ax, ay, aw, ah) = work_area_logical(&m);
        let margin = 16.0;
        let (v, hpos) = position.split_once('-').unwrap_or(("top", "right"));
        let x = match hpos {
            "left" => ax + margin,
            "center" => ax + (aw - w) / 2.0,
            _ => ax + aw - w - margin,
        };
        let y = if v == "bottom" { ay + ah - h - margin } else { ay + margin };
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
    raise(app, &win, false);
    let _ = win.show();
    Some(win)
}

pub fn close_toast(app: &AppHandle, kind: &str) {
    if let Some(w) = app.get_webview_window(&format!("toast-{kind}")) {
        let _ = w.destroy();
    }
}

// ------------------------------------------------------------------ blink / posture reminders

/// Full-display, click-through overlay on the screen with the cursor; the page draws the
/// animated orb (centered by default) and optionally dims the screen.
pub fn show_reminder(app: &AppHandle, params: Value) -> Option<WebviewWindow> {
    if let Some(old) = app.get_webview_window("reminder") {
        let _ = old.destroy();
    }
    let m = cursor_monitor(app)?;
    let (x, y, w, h) = monitor_logical(&m);
    let win = builder(app, "reminder", "reminder.html", params)
        .position(x, y)
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .shadow(false)
        .focused(false)
        .build()
        .ok()?;
    let _ = win.set_ignore_cursor_events(true);
    raise(app, &win, false);
    let _ = win.show();
    Some(win)
}

// ------------------------------------------------------------------ popover

pub fn toggle_popover(app: &AppHandle, tray_rect: Option<Rect>) {
    if let Some(w) = app.get_webview_window("popover") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
        place_popover(app, &w, tray_rect);
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let mut b = builder(app, "popover", "popover.html", json!({}))
        .inner_size(POPOVER_SIZE.0, POPOVER_SIZE.1)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .shadow(true);
    #[cfg(target_os = "macos")]
    {
        b = b.effects(EffectsBuilder::new().effect(Effect::Popover).state(EffectState::Active).radius(26.0).build());
    }
    #[cfg(windows)]
    {
        b = b.effects(EffectsBuilder::new().effect(Effect::Acrylic).build());
    }
    if let Ok(w) = b.build() {
        raise(app, &w, false);
        place_popover(app, &w, tray_rect);
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Under the tray icon (macOS menu bar) or above it (Windows taskbar).
fn place_popover(app: &AppHandle, w: &WebviewWindow, tray_rect: Option<Rect>) {
    let (pw, ph) = POPOVER_SIZE;
    let monitor = cursor_monitor(app);
    let Some(m) = monitor else { return };
    let scale = m.scale_factor();
    let (ax, ay, aw, ah) = work_area_logical(&m);
    let (_, my, _, mh) = monitor_logical(&m);
    let (mut x, mut y) = (ax + aw - pw - 12.0, ay + 8.0);
    if let Some(r) = tray_rect {
        let p = r.position.to_logical::<f64>(scale);
        let s = r.size.to_logical::<f64>(scale);
        x = p.x + s.width / 2.0 - pw / 2.0;
        let at_bottom = p.y > my + mh / 2.0;
        y = if at_bottom { p.y - ph - 8.0 } else { p.y + s.height + 6.0 };
        if s.width == 0.0 {
            // Some Windows shells report empty bounds: use the bottom-right corner.
            x = ax + aw - pw - 12.0;
            y = ay + ah - ph - 12.0;
        }
    }
    x = x.clamp(ax + 8.0, ax + aw - pw - 8.0);
    y = y.clamp(ay + 4.0, ay + ah - ph - 4.0);
    let _ = w.set_position(LogicalPosition::new(x, y));
    let _ = w.set_size(LogicalSize::new(pw, ph));
}

pub fn hide_popover(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("popover") {
        let _ = w.hide();
    }
}

// ------------------------------------------------------------------ settings

pub fn open_settings(app: &AppHandle, tab: Option<&str>) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(t) = tab {
            let _ = tauri::Emitter::emit_to(app, "settings", "open-tab", t);
        }
        return;
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    #[allow(unused_mut)] // only reassigned on macOS
    let mut b = builder(app, "settings", "settings.html", json!({ "tab": tab }))
        .title("FarSight Settings")
        .inner_size(920.0, 660.0)
        .min_inner_size(760.0, 520.0)
        .center();
    #[cfg(target_os = "macos")]
    {
        b = b
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .transparent(true)
            .effects(EffectsBuilder::new().effect(Effect::Sidebar).state(EffectState::Active).build());
    }
    if let Ok(w) = b.build() {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Self-test helper: save a PNG of a window's web content (macOS only).
#[cfg(all(debug_assertions, target_os = "macos"))]
pub fn snapshot(win: &WebviewWindow, path: &std::path::Path) {
    extern "C" {
        fn fs_snapshot_webview(webview: *mut std::ffi::c_void, path: *const std::os::raw::c_char);
    }
    let Ok(cpath) = std::ffi::CString::new(path.to_string_lossy().as_bytes()) else { return };
    let _ = win.with_webview(move |wv| unsafe { fs_snapshot_webview(wv.inner() as *mut std::ffi::c_void, cpath.as_ptr()) });
}

#[cfg(all(debug_assertions, not(target_os = "macos")))]
pub fn snapshot(_win: &WebviewWindow, _path: &std::path::Path) {}
