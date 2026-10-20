//! App state, the 1 Hz loop, engine-event side effects, tray, menus, shortcuts and IPC.
use crate::activity::{self, Activity};
use crate::engine::{BreakResult, Engine, EngineState, Event, TickContext};
use crate::messages::{format_clock, format_duration};
use crate::platform::{is_outside_office_hours, lock_screen, run_automation};
use crate::settings;
use crate::smartpause::{detect_smart_pause, detect_video};
use crate::stats::StatsBook;
use crate::types::*;
use crate::{sound, ui};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn debug() -> bool {
    std::env::var_os("FARSIGHT_DEBUG").is_some()
}

// ------------------------------------------------------------------ storage

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Atomic write: temp file + rename.
fn write_json<T: Serialize>(path: &Path, value: &T) {
    let tmp = path.with_extension("json.tmp");
    if let Ok(bytes) = serde_json::to_vec(value) {
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

// ------------------------------------------------------------------ state

pub struct App {
    pub engine: Mutex<Engine>,
    pub stats: Mutex<StatsBook>,
    pub activity: Activity,
    data_dir: PathBuf,
    cache_dir: PathBuf,
    countdown: Mutex<Option<ui::Countdown>>,
    toast_gen: Mutex<HashMap<String, u64>>,
    last_tick: Mutex<Option<f64>>,
    last_save: Mutex<Instant>,
    menu_key: Mutex<String>,
    pub popover_menu_open: AtomicBool,
}

impl App {
    pub fn load(app: &AppHandle) -> Arc<App> {
        let data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("FarSight"));
        let cache_dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir()).join("sounds");
        let _ = std::fs::create_dir_all(&data_dir);
        migrate_from_electron(app, &data_dir);

        let settings = read_json::<Value>(&data_dir.join("settings.json")).map(settings::from_json).unwrap_or_default();
        let mut stats = StatsBook::new(read_json::<BTreeMap<String, DayStats>>(&data_dir.join("stats.json")).unwrap_or_default());
        stats.prune(now_ms(), 90);
        let restored = read_json::<EngineState>(&data_dir.join("timer-state.json"));
        let mut seed = now_ms() as u64 | 1;
        let rand = Box::new(move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % 10_000) as f64 / 10_000.0
        });
        if let Some(img) = &settings.background_image {
            let _ = app.asset_protocol_scope().allow_file(img);
        }
        Arc::new(App {
            engine: Mutex::new(Engine::new(settings, now_ms(), restored, rand)),
            stats: Mutex::new(stats),
            activity: Activity::start(),
            data_dir,
            cache_dir,
            countdown: Mutex::new(None),
            toast_gen: Mutex::new(HashMap::new()),
            last_tick: Mutex::new(None),
            last_save: Mutex::new(Instant::now()),
            menu_key: Mutex::new(String::new()),
            popover_menu_open: AtomicBool::new(false),
        })
    }

    pub fn settings(&self) -> Settings {
        self.engine.lock().unwrap().settings.clone()
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        self.engine.lock().unwrap().snapshot()
    }

    /// On a call or watching a video: show nothing and stay silent.
    fn quiet(&self) -> bool {
        self.engine.lock().unwrap().pause_reason().is_some_and(|r| r.is_quiet())
    }

    pub fn save_all(&self) {
        write_json(&self.data_dir.join("timer-state.json"), &self.engine.lock().unwrap().serialize());
        write_json(&self.data_dir.join("stats.json"), &self.stats.lock().unwrap().days);
    }

    fn save_settings(&self, s: &Settings) {
        write_json(&self.data_dir.join("settings.json"), s);
    }

    fn save_soon(&self) {
        let mut last = self.last_save.lock().unwrap();
        if last.elapsed() >= Duration::from_secs(10) {
            *last = Instant::now();
            drop(last);
            self.save_all();
        }
    }
}

/// Earlier (Electron) builds kept data in "<data dir>/FarSight"; copy it over once.
fn migrate_from_electron(app: &AppHandle, data_dir: &Path) {
    if data_dir.join("settings.json").exists() {
        return;
    }
    let Ok(base) = app.path().data_dir() else { return };
    let old = base.join("FarSight");
    if old == data_dir {
        return;
    }
    for f in ["settings.json", "stats.json", "timer-state.json"] {
        let _ = std::fs::copy(old.join(f), data_dir.join(f));
    }
}

// ------------------------------------------------------------------ sounds & toasts

const REMINDER_SOUNDS: &[&str] = &["nudge", "blink", "posture", "return"];

pub fn play(st: &App, sound_name: &str, pair: Option<&str>, volume: Option<f64>) {
    if REMINDER_SOUNDS.contains(&sound_name) && st.quiet() {
        return;
    }
    let s = st.settings();
    let pair = pair.map(String::from).unwrap_or(s.sound_pair.clone());
    let vol = volume.unwrap_or(s.break_sounds_volume);
    let (cache, name) = (st.cache_dir.clone(), sound_name.to_string());
    std::thread::spawn(move || {
        if let Some(path) = sound::wav_for(&cache, &name, &pair, vol) {
            sound::play_file(&path);
        }
    });
}

fn show_toast(app: &AppHandle, st: &App, kind: &str, payload: Value, auto_close_ms: Option<u64>) {
    // Nothing automatic pops up during calls or videos; replies to the user's own clicks still show.
    if st.quiet() && kind != "notice" {
        return;
    }
    let position = st.settings().reminder_position;
    let position = if kind == "wellness" { position } else { "top-right".to_string() };
    if ui::show_toast(app, kind, payload, &position).is_none() {
        return;
    }
    let gen = {
        let mut g = st.toast_gen.lock().unwrap();
        let e = g.entry(kind.to_string()).or_insert(0);
        *e += 1;
        *e
    };
    if let Some(ms) = auto_close_ms {
        let (app, kind) = (app.clone(), kind.to_string());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            let st = app.state::<Arc<App>>();
            if st.toast_gen.lock().unwrap().get(&kind) == Some(&gen) {
                ui::close_toast(&app, &kind);
            }
        });
    }
}

fn hide_countdown(st: &App) {
    if let Some(c) = st.countdown.lock().unwrap().take() {
        c.hide();
    }
}

// ------------------------------------------------------------------ engine events

pub fn handle(app: &AppHandle, st: &App, events: Vec<Event>) {
    if events.is_empty() {
        return;
    }
    let now = now_ms();
    let s = st.settings();
    for ev in events {
        match ev {
            Event::FocusTick { seconds } => {
                if s.stats_enabled {
                    st.stats.lock().unwrap().add_focus(now, seconds);
                }
            }
            Event::SessionEnd { length_sec } => {
                if s.stats_enabled {
                    st.stats.lock().unwrap().end_session(now, length_sec);
                }
            }
            Event::HeadsUp { seconds_left, is_long } => {
                show_toast(app, st, "heads-up", json!({ "secondsLeft": seconds_left, "isLong": is_long }), None);
                if s.reminder_sounds_enabled {
                    play(st, "nudge", None, Some(s.reminder_volume));
                }
            }
            Event::Countdown => {
                let mut c = st.countdown.lock().unwrap();
                if c.is_none() && !st.quiet() {
                    *c = ui::Countdown::show(app);
                }
            }
            Event::BreakStart(_) => {
                hide_countdown(st);
                ui::close_toast(app, "heads-up");
                ui::hide_popover(app);
                ui::open_break_windows(app, &s);
                play(st, "start", None, None);
                if s.lock_on_break {
                    let h = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(5));
                        if h.state::<Arc<App>>().snapshot().status == Status::Break {
                            lock_screen();
                        }
                    });
                }
                run_automations(&s, "break-start");
            }
            Event::BreakComplete => play(st, "end", None, None),
            Event::BreakEnd { info, result } => {
                ui::close_break_windows(app);
                let regular = matches!(info.kind, BreakKind::Short | BreakKind::Long);
                match result {
                    BreakResult::Completed => {
                        if !s.hold_break_until_ended {
                            play(st, "end", None, None);
                        }
                        if s.stats_enabled && regular {
                            st.stats.lock().unwrap().break_taken(now);
                        }
                    }
                    BreakResult::Skipped if s.stats_enabled => st.stats.lock().unwrap().break_skipped(now),
                    _ => {}
                }
                run_automations(&s, "break-end");
            }
            Event::SkippedInAdvance => {
                hide_countdown(st);
                ui::close_toast(app, "heads-up");
                if s.stats_enabled {
                    st.stats.lock().unwrap().break_skipped(now);
                }
            }
            Event::Snoozed => {
                hide_countdown(st);
                ui::close_toast(app, "heads-up");
                if s.stats_enabled {
                    st.stats.lock().unwrap().snoozed(now);
                }
            }
            Event::Returned { away_sec, reset } => {
                if reset && s.stats_enabled {
                    st.stats.lock().unwrap().natural_break(now);
                }
                if s.show_return_notice && away_sec >= 60.0 {
                    show_toast(app, st, "returned", json!({ "awaySec": away_sec, "mode": if reset { "reset" } else { "resume" } }), Some(10_000));
                    if s.reminder_sounds_enabled {
                        play(st, "return", None, Some(s.reminder_volume));
                    }
                }
            }
            Event::Paused { reason, detail } => {
                if reason.is_quiet() {
                    // Calls and videos: clear anything on screen and stay silent.
                    hide_countdown(st);
                    for k in ["heads-up", "wellness", "returned", "paused"] {
                        ui::close_toast(app, k);
                    }
                } else if matches!(reason, PauseReason::DeepFocus | PauseReason::Fullscreen) {
                    hide_countdown(st);
                    ui::close_toast(app, "heads-up");
                    show_toast(app, st, "paused", json!({ "reason": reason, "detail": detail }), Some(6000));
                }
            }
            Event::Wellness { blink } => {
                show_toast(app, st, "wellness", json!({ "kind": if blink { "blink" } else { "posture" } }), Some(6000));
                if s.reminder_sounds_enabled {
                    play(st, if blink { "blink" } else { "posture" }, None, Some(s.reminder_volume));
                }
            }
            Event::Resumed { .. } | Event::DayRollover => {}
        }
    }
    st.save_soon();
}

fn run_automations(s: &Settings, trigger: &str) {
    for a in s.automations.iter().filter(|a| a.enabled && a.trigger == trigger) {
        let cmd = a.command.clone();
        std::thread::spawn(move || run_automation(&cmd));
    }
}

// ------------------------------------------------------------------ tick

pub fn tick(app: &AppHandle) {
    let st = app.state::<Arc<App>>();
    let now = now_ms();
    let dt = {
        let mut last = st.last_tick.lock().unwrap();
        let dt = last.map(|t| ((now - t) / 1000.0).clamp(0.0, 5.0)).unwrap_or(0.0);
        *last = Some(now);
        dt
    };
    let s = st.settings();
    let sample = st.activity.sample();
    let video = detect_video(&sample, &s);
    let pause = detect_smart_pause(&sample, &s);
    let locked = activity::screen_locked();
    // On a call or watching a video there's no input, but the user is at the screen: not idle.
    let engaged = pause.as_ref().is_some_and(|(r, _)| r.is_quiet()) || (video.is_some() && !s.video_pause_enabled);
    let ctx = TickContext {
        idle_sec: if engaged { 0.0 } else { activity::idle_seconds() },
        screen_locked: locked,
        suspended: false,
        outside_office_hours: is_outside_office_hours(&s, now),
        smart_pause: pause,
    };
    let events = st.engine.lock().unwrap().tick(now, &ctx);
    handle(app, &st, events);
    let snap = st.snapshot();
    if debug() {
        eprintln!(
            "[tick] {:?}{} work={:.1} front={:?} video={:?} mic={:?} idle={:.0}",
            snap.status,
            snap.pause.as_ref().map(|p| format!("/{:?}", p.reason)).unwrap_or_default(),
            snap.work_elapsed,
            sample.front_app,
            sample.video_apps,
            sample.mic_apps,
            ctx.idle_sec
        );
    }
    if let Some(v) = video {
        if s.stats_enabled && snap.status != Status::Stopped && !locked && dt > 0.0 {
            st.stats.lock().unwrap().add_video(now, dt, &v);
        }
    }
    if snap.status != Status::Working {
        hide_countdown(&st);
    }
    let _ = app.emit("state", &snap);
    update_tray(app, &st, &snap, &s);
}

pub fn start_loop(app: AppHandle) {
    std::thread::Builder::new()
        .name("tick".into())
        .spawn(move || loop {
            tick(&app);
            std::thread::sleep(Duration::from_millis(1000));
        })
        .expect("spawn tick thread");
}

// ------------------------------------------------------------------ tray

fn pause_text(r: PauseReason) -> &'static str {
    match r {
        PauseReason::Manual => "Paused",
        PauseReason::Idle => "Paused while you're away",
        PauseReason::ScreenLocked => "Paused while your screen is locked",
        PauseReason::DeepFocus => "Paused for your focus app",
        PauseReason::Meeting => "Paused for your call",
        PauseReason::Fullscreen => "Paused while a fullscreen app is active",
        PauseReason::Video => "Paused while you watch a video",
        PauseReason::OfficeHours => "Outside office hours",
        PauseReason::Suspended => "Paused while asleep",
    }
}

fn status_line(snap: &EngineSnapshot) -> String {
    match snap.status {
        Status::Stopped => "FarSight is stopped".into(),
        Status::Break => match snap.current_break.as_ref() {
            Some(b) => format!("On a break · {} left", format_clock(b.duration - b.elapsed)),
            None => "On a break".into(),
        },
        Status::Paused => {
            let Some(p) = snap.pause.as_ref() else { return "Paused".into() };
            let base = match &p.detail {
                Some(d) => format!("{} ({d})", pause_text(p.reason)),
                None => pause_text(p.reason).into(),
            };
            match p.until {
                Some(u) => format!("{base} · resumes in {}", format_duration((u - now_ms()) / 1000.0)),
                None => base,
            }
        }
        Status::Working => format!("{} in {}", if snap.next_break_is_long { "Long break" } else { "Break" }, format_duration(snap.remaining)),
    }
}

fn tray_title(snap: &EngineSnapshot) -> String {
    match snap.status {
        Status::Working => format_clock(snap.remaining),
        Status::Break => snap.current_break.as_ref().map(|b| format_clock(b.duration - b.elapsed)).unwrap_or_default(),
        Status::Paused => "❚❚".into(),
        Status::Stopped => String::new(),
    }
}

fn item(app: &AppHandle, id: &str, text: &str, enabled: bool) -> MenuItem<tauri::Wry> {
    MenuItem::with_id(app, id, text, enabled, None::<&str>).expect("menu item")
}

pub fn pause_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let m = Menu::new(app)?;
    for mins in [15, 30, 60, 120] {
        m.append(&item(app, &format!("pause-{}", mins * 60), &format!("Pause for {}", format_duration(mins as f64 * 60.0)), true))?;
    }
    m.append(&item(app, "pause-forever", "Until I resume", true))?;
    Ok(m)
}

pub fn custom_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let m = Menu::new(app)?;
    m.append(&item(app, "break-long", "Long break now", true))?;
    m.append(&PredefinedMenuItem::separator(app)?)?;
    for mins in [1, 2, 5, 10, 15, 30] {
        m.append(&item(app, &format!("custom-{}", mins * 60), &format!("Custom break · {mins} min"), true))?;
    }
    Ok(m)
}

fn tray_menu(app: &AppHandle, snap: &EngineSnapshot, s: &Settings, score: Option<u32>, screen_sec: f64) -> tauri::Result<Menu<tauri::Wry>> {
    let stopped = snap.status == Status::Stopped;
    let on_break = snap.status == Status::Break;
    let m = Menu::new(app)?;
    m.append(&item(app, "status", &status_line(snap), false))?;
    m.append(&PredefinedMenuItem::separator(app)?)?;

    let start = Submenu::with_id(app, "start-sub", "Start break now", !stopped && !on_break)?;
    start.append(&item(app, "break-short", "Short break", true))?;
    start.append(&item(app, "break-long", "Long break", true))?;
    start.append(&PredefinedMenuItem::separator(app)?)?;
    for mins in [1, 2, 5, 10, 15, 30] {
        start.append(&item(app, &format!("custom-{}", mins * 60), &format!("Custom · {mins} min"), true))?;
    }
    m.append(&start)?;

    let snooze = Submenu::with_id(app, "snooze-sub", "Snooze next break", snap.can_snooze && !stopped)?;
    for secs in [60, 300, 900] {
        snooze.append(&item(app, &format!("snooze-{secs}"), &format!("+ {} min", secs / 60), true))?;
    }
    m.append(&snooze)?;

    let skip_label = if on_break {
        "Skip this break".to_string()
    } else {
        format!("Skip next break ({} left today)", s.advance_skips_per_day.saturating_sub(snap.advance_skips_today))
    };
    m.append(&item(app, "skip", &skip_label, snap.can_skip))?;
    if snap.status == Status::Paused && snap.pause.as_ref().is_some_and(|p| p.reason == PauseReason::Manual) {
        m.append(&item(app, "resume", "Resume", true))?;
    } else {
        let pause = Submenu::with_id(app, "pause-sub", "Pause", !stopped && !on_break)?;
        for mins in [15, 30, 60, 120] {
            pause.append(&item(app, &format!("pause-{}", mins * 60), &format!("For {}", format_duration(mins as f64 * 60.0)), true))?;
        }
        pause.append(&item(app, "pause-forever", "Until I resume", true))?;
        m.append(&pause)?;
    }
    m.append(&item(app, "restart", "Restart timers", !stopped))?;
    m.append(&if stopped { item(app, "start", "Start FarSight", true) } else { item(app, "stop", "Stop FarSight", true) })?;
    m.append(&PredefinedMenuItem::separator(app)?)?;
    let score_text = score.map(|s| s.to_string()).unwrap_or_else(|| "—".into());
    m.append(&item(app, "stats", &format!("Screen score: {score_text}  ·  {} today", format_duration(screen_sec)), true))?;
    m.append(&MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?)?;
    m.append(&PredefinedMenuItem::separator(app)?)?;
    m.append(&MenuItem::with_id(app, "quit", "Quit FarSight", true, Some("CmdOrCtrl+Q"))?)?;
    Ok(m)
}

fn tray_icon_image() -> tauri::image::Image<'static> {
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = include_bytes!("../icons/trayTemplate@2x.png");
    #[cfg(not(target_os = "macos"))]
    let bytes: &[u8] = include_bytes!("../icons/tray-light.png");
    tauri::image::Image::from_bytes(bytes).expect("tray icon")
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let st = app.state::<Arc<App>>();
    let snap = st.snapshot();
    let menu = tray_menu(app, &snap, &st.settings(), None, 0.0)?;
    TrayIconBuilder::with_id("main")
        .icon(tray_icon_image())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("FarSight")
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                ui::toggle_popover(tray.app_handle(), Some(rect));
            }
        })
        .build(app)?;
    Ok(())
}

fn update_tray(app: &AppHandle, st: &App, snap: &EngineSnapshot, s: &Settings) {
    let Some(tray) = app.tray_by_id("main") else { return };
    #[cfg(target_os = "macos")]
    {
        let title = if s.menu_bar_display == "icon" { String::new() } else { format!(" {}", tray_title(snap)) };
        let _ = tray.set_title(Some(title));
    }
    let _ = tray.set_tooltip(Some(format!("FarSight — {}", status_line(snap))));
    // Rebuild the right-click menu only when its content changes (at most once per minute).
    let summary = st.stats.lock().unwrap().summary(now_ms(), s.work_duration);
    let key = format!(
        "{}|{}|{}|{}|{:?}|{}",
        status_line(snap).split(" · ").next().unwrap_or_default().to_string() + &format_duration(snap.remaining),
        snap.can_snooze,
        snap.can_skip,
        snap.advance_skips_today,
        summary.score,
        (summary.today.screen_time_sec / 60.0) as i64
    );
    let mut last = st.menu_key.lock().unwrap();
    if *last != key {
        *last = key;
        if let Ok(menu) = tray_menu(app, snap, s, summary.score, summary.today.screen_time_sec) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = tray_title(snap);
}

pub fn on_menu(app: &AppHandle, id: &str) {
    let st = app.state::<Arc<App>>();
    st.popover_menu_open.store(false, Ordering::Relaxed);
    let num = |prefix: &str| id.strip_prefix(prefix).and_then(|n| n.parse::<f64>().ok());
    let call = |name: &str, args: Vec<Value>| {
        let _ = command(app, name, args);
    };
    match id {
        "break-short" => call("startBreak", vec![json!("short")]),
        "break-long" => call("startBreak", vec![json!("long")]),
        "skip" => call("skip", vec![]),
        "resume" => call("resume", vec![]),
        "restart" => call("restart", vec![]),
        "stop" => call("stop", vec![]),
        "start" => call("start", vec![]),
        "pause-forever" => call("pause", vec![Value::Null]),
        "stats" => ui::open_settings(app, Some("stats")),
        "settings" => ui::open_settings(app, None),
        "quit" => {
            st.save_all();
            app.exit(0);
        }
        _ => {
            if let Some(s) = num("custom-") {
                call("startBreak", vec![json!("custom"), json!(s)]);
            } else if let Some(s) = num("snooze-") {
                call("snooze", vec![json!(s)]);
            } else if let Some(s) = num("pause-") {
                call("pause", vec![json!(s)]);
            }
        }
    }
}

// ------------------------------------------------------------------ system integration

pub fn apply_system_settings(app: &AppHandle, s: &Settings) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let bind = |accel: &str, name: &'static str, args: Vec<Value>| {
        if accel.trim().is_empty() {
            return;
        }
        let res = gs.on_shortcut(accel, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let st = app.state::<Arc<App>>();
                if name == "togglePause" {
                    let paused = st.snapshot().status == Status::Paused;
                    let _ = command(app, if paused { "resume" } else { "pause" }, vec![Value::Null]);
                } else {
                    let _ = command(app, name, args.clone());
                }
            }
        });
        if let Err(e) = res {
            eprintln!("could not register shortcut {accel}: {e}");
        }
    };
    bind(&s.shortcuts.start_break, "startBreak", vec![json!("short")]);
    bind(&s.shortcuts.toggle_pause, "togglePause", vec![]);
    bind(&s.shortcuts.snooze, "snooze", vec![json!(300)]);
    bind(&s.shortcuts.skip, "skip", vec![]);

    if !cfg!(debug_assertions) {
        let al = app.autolaunch();
        if al.is_enabled().unwrap_or(false) != s.launch_at_login {
            let _ = if s.launch_at_login { al.enable() } else { al.disable() };
        }
    }
}

// ------------------------------------------------------------------ commands (UI, tray, shortcuts)

fn arg_f64(args: &[Value], i: usize) -> Option<f64> {
    args.get(i).and_then(|v| v.as_f64())
}

fn arg_str(args: &[Value], i: usize) -> Option<String> {
    args.get(i).and_then(|v| v.as_str()).map(String::from)
}

pub fn command(app: &AppHandle, name: &str, args: Vec<Value>) -> Result<Value, String> {
    let st = app.state::<Arc<App>>();
    let now = now_ms();
    let events = {
        let mut e = st.engine.lock().unwrap();
        match name {
            "getState" => return Ok(json!(e.snapshot())),
            "log" => {
                if debug() {
                    eprintln!("[ui] {}", arg_str(&args, 0).unwrap_or_default());
                }
                return Ok(Value::Null);
            }
            "getSettings" => return Ok(json!(e.settings)),
            "startBreak" => {
                let kind = match arg_str(&args, 0).as_deref() {
                    Some("long") => BreakKind::Long,
                    Some("custom") => BreakKind::Custom,
                    _ => BreakKind::Short,
                };
                e.start_break(kind, now, arg_f64(&args, 1), None, None)
            }
            "snooze" => {
                if !e.can_snooze() {
                    let hardcore = e.settings.discipline_level == DisciplineLevel::Hardcore;
                    drop(e);
                    let text = if hardcore { "Snoozing is off in Hardcore" } else { "No snoozes left!" };
                    show_toast(app, &st, "notice", json!({ "icon": "zzz", "text": text }), Some(2500));
                    return Ok(json!(st.snapshot()));
                }
                e.snooze(arg_f64(&args, 0).unwrap_or(300.0))
            }
            "skip" => e.skip(),
            "endBreak" => e.end_break(),
            "pause" => e.pause(now, arg_f64(&args, 0)),
            "resume" | "start" => e.resume(),
            "restart" => e.restart(),
            "stop" => e.stop(),
            "undoReturn" => {
                e.undo_return_reset();
                vec![]
            }
            _ => vec![],
        }
    };
    handle(app, &st, events);

    match name {
        "getStats" => {
            let target = st.settings().work_duration;
            return Ok(json!(st.stats.lock().unwrap().summary(now, target)));
        }
        "getPlatform" => return Ok(json!({ "platform": ui::PLATFORM, "version": app.package_info().version.to_string() })),
        "setSettings" | "resetSettings" => {
            let next = if name == "setSettings" {
                settings::merge_patch(&st.settings(), args.first().cloned().unwrap_or(Value::Null))
            } else {
                Settings { has_completed_onboarding: true, ..Default::default() }
            };
            if let Some(img) = &next.background_image {
                let _ = app.asset_protocol_scope().allow_file(img);
            }
            st.save_settings(&next);
            st.engine.lock().unwrap().settings = next.clone();
            apply_system_settings(app, &next);
            *st.menu_key.lock().unwrap() = String::new();
            let _ = app.emit("settings", &next);
            return Ok(json!(next));
        }
        "closeToast" => ui::close_toast(app, &arg_str(&args, 0).unwrap_or_default()),
        "openSettings" => {
            ui::hide_popover(app);
            ui::open_settings(app, arg_str(&args, 0).as_deref());
        }
        "popupPauseMenu" | "popupCustomMenu" => {
            if let Some(w) = app.get_webview_window("popover") {
                let menu = if name == "popupPauseMenu" { pause_menu(app) } else { custom_menu(app) };
                if let Ok(menu) = menu {
                    st.popover_menu_open.store(true, Ordering::Relaxed);
                    let _ = w.popup_menu(&menu);
                }
            }
        }
        "listApps" => return Ok(json!(activity::running_apps())),
        "pickImage" => {
            use tauri_plugin_dialog::DialogExt;
            let picked = app.dialog().file().add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"]).blocking_pick_file();
            return Ok(json!(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())));
        }
        "previewWellness" => {
            let blink = arg_str(&args, 0).as_deref() == Some("blink");
            handle(app, &st, vec![Event::Wellness { blink }]);
        }
        "previewSound" => {
            let s = arg_str(&args, 0).unwrap_or_default();
            match s.strip_prefix("pair:") {
                Some(pair) => play(&st, "start", Some(pair), None),
                None => play(&st, &s, None, None),
            }
        }
        "testAutomation" => {
            let (ok, output) = run_automation(&arg_str(&args, 0).unwrap_or_default());
            return Ok(json!({ "ok": ok, "output": output }));
        }
        "openExternal" => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url(arg_str(&args, 0).unwrap_or_default(), None::<&str>);
        }
        "quit" => {
            st.save_all();
            app.exit(0);
        }
        _ => {}
    }
    tick(app);
    Ok(json!(st.snapshot()))
}

#[tauri::command]
pub async fn cmd(app: AppHandle, name: String, args: Vec<Value>) -> Result<Value, String> {
    command(&app, &name, args)
}

// ------------------------------------------------------------------ self-test (debug builds)

/// `farsight --self-test`: drives every window through the real code paths, saves PNG
/// snapshots of each page to ./screenshots, logs, and exits.
#[cfg(debug_assertions)]
pub fn self_test(app: AppHandle) {
    std::thread::spawn(move || {
        let wait = |ms: u64| std::thread::sleep(Duration::from_millis(ms));
        let st = app.state::<Arc<App>>();
        let step = |name: &str| eprintln!("[selftest] {name}");
        let out = std::env::current_dir().unwrap_or_default().join("../screenshots");
        let _ = std::fs::create_dir_all(&out);
        let shot = |label: &str, name: &str| {
            if let Some(w) = app.get_webview_window(label) {
                ui::snapshot(&w, &out.join(format!("{name}.png")));
            }
        };
        wait(1500);
        step("popover");
        ui::toggle_popover(&app, None);
        wait(1500);
        shot("popover", "popover-now");
        let _ = app.emit_to("popover", "open-tab", "stats");
        wait(800);
        shot("popover", "popover-stats");
        ui::hide_popover(&app);
        step("settings tabs");
        ui::open_settings(&app, Some("welcome"));
        wait(1800);
        shot("settings", "settings-welcome");
        for tab in ["general", "breaks", "smart-pause", "wellness", "appearance", "schedule", "stats", "automation", "about"] {
            let _ = app.emit_to("settings", "open-tab", tab);
            wait(500);
            shot("settings", &format!("settings-{tab}"));
        }
        wait(300);
        if let Some(w) = app.get_webview_window("settings") {
            let _ = w.destroy();
        }
        step("toasts");
        for (kind, payload) in [
            ("heads-up", json!({ "secondsLeft": 60, "isLong": false })),
            ("returned", json!({ "awaySec": 480, "mode": "reset" })),
            ("paused", json!({ "reason": "deep-focus", "detail": "Keynote" })),
            ("wellness", json!({ "kind": "blink" })),
            ("notice", json!({ "icon": "zzz", "text": "No snoozes left!" })),
        ] {
            show_toast(&app, &st, kind, payload, Some(2500));
            wait(900);
            shot(&format!("toast-{kind}"), &format!("toast-{kind}"));
        }
        wait(2500);
        step(&format!("open toasts after auto-close: {}", app.webview_windows().keys().filter(|l| l.starts_with("toast-")).count()));
        step("countdown");
        *st.countdown.lock().unwrap() = ui::Countdown::show(&app);
        wait(1200);
        shot("countdown", "countdown");
        hide_countdown(&st);
        step("sounds");
        play(&st, "start", Some("chime"), Some(0.3));
        wait(300);
        step("break (4 s custom)");
        let _ = command(&app, "startBreak", vec![json!("custom"), json!(4)]);
        wait(1800);
        shot("break-0", "break");
        step(&format!("break windows open: {}", app.webview_windows().keys().filter(|l| l.starts_with("break-")).count()));
        wait(3500);
        step(&format!("after break: status={:?} break windows={}", st.snapshot().status, app.webview_windows().keys().filter(|l| l.starts_with("break-")).count()));
        step("done");
        st.save_all();
        app.exit(0);
    });
}
