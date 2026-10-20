pub mod activity;
pub mod app;
pub mod engine;
pub mod messages;
pub mod platform;
pub mod settings;
pub mod smartpause;
pub mod sound;
pub mod stats;
pub mod types;
pub mod ui;

use app::App;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Manager, RunEvent, WindowEvent};
use types::{DisciplineLevel, Status};

/// Debug-only `--self-test`: runs beside an installed FarSight with its own throwaway data.
pub fn is_self_test() -> bool {
    cfg!(debug_assertions) && std::env::args().any(|a| a == "--self-test")
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    if !is_self_test() {
        // Launching FarSight again reveals its panel (handy when the menu-bar icon is hidden by a notch).
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| ui::toggle_popover(app, None)));
    }
    let tauri_app = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![app::cmd])
        .on_menu_event(|app, event| app::on_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            let label = window.label();
            let app = window.app_handle();
            match event {
                WindowEvent::Focused(false) if label == "popover" => {
                    // Keep it open while one of its own native menus is showing.
                    let st = app.state::<Arc<App>>();
                    if !st.popover_menu_open.load(Ordering::Relaxed) {
                        let _ = window.hide();
                    }
                }
                WindowEvent::Focused(false) if label == "break-0" => {
                    let st = app.state::<Arc<App>>();
                    if st.settings().discipline_level == DisciplineLevel::Hardcore && st.snapshot().status == Status::Break {
                        ui::refocus_break(app);
                    }
                }
                WindowEvent::Destroyed if label == "settings" => {
                    #[cfg(target_os = "macos")]
                    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
                _ => {}
            }
        })
        .setup(|tauri_app| {
            #[cfg(target_os = "macos")]
            tauri_app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = tauri_app.handle().clone();
            let state = App::load(&handle);
            let s = state.settings();
            let restoring_break = state.snapshot().status == Status::Break;
            tauri_app.manage(state);
            app::create_tray(&handle)?;
            app::apply_system_settings(&handle, &s);
            if restoring_break {
                ui::open_break_windows(&handle, &s);
            }
            app::start_loop(handle.clone());

            #[cfg(debug_assertions)]
            if is_self_test() {
                app::self_test(handle.clone());
                return Ok(());
            }
            let dev = std::env::args().any(|a| a == "--dev");
            if !s.has_completed_onboarding || dev {
                ui::open_settings(&handle, if s.has_completed_onboarding { None } else { Some("welcome") });
            } else if !std::env::args().any(|a| a == "--autostart" || a == "--minimized") {
                // Manual launch: show the panel once so the user sees FarSight started.
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    ui::toggle_popover(&h, None);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FarSight");

    tauri_app.run(|app, event| match event {
        // FarSight lives in the tray: closing every window doesn't quit it.
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        RunEvent::Exit => app.state::<Arc<App>>().save_all(),
        _ => {}
    });
}
