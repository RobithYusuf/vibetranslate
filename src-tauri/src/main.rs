#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[macro_use]
mod dlog;
mod secrets;
mod commands;
mod keyboard;
mod tray;
mod plugins;
mod mouse_hook;
mod stt;
mod stt_stream;
mod mt;

use tauri_plugin_autostart::MacosLauncher;
use plugins::mac_rounded_corners;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            tray::setup_tray(app)?;
            // Start background app tracker
            keyboard::start_app_tracker();
            // Start the global mouse-button hook (macOS): lets an extra mouse button (back/
            // forward/middle) trigger a shortcut system-wide. Inactive if Accessibility isn't
            // granted yet; the frontend can retry via restart_mouse_hook.
            mouse_hook::start(app.handle().clone());
            // Pre-create the hidden voice recording overlay so it shows instantly
            // (non-activating) without bringing the main window forward.
            commands::ensure_recording_window(&app.handle());
            // Same reason as the pill above: created up front so the first live word is not waiting
            // on a window being built.
            commands::ensure_transcript_window(&app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Intercept close event on settings window - hide instead of close
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == "settings" || label == "main" {
                    // Prevent the window from being destroyed
                    api.prevent_close();
                    // Hide the window instead
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::show_settings_window,
            commands::hide_settings_window,
            commands::quit_app,
            commands::show_transcript,
            commands::hide_transcript,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            stt_stream::stream_stt_start,
            stt_stream::stream_stt_push,
            stt_stream::stream_stt_finish,
            stt_stream::stream_stt_cancel,
            stt_stream::stream_stt_release,
            commands::show_popup,
            commands::hide_popup,
            commands::show_loading,
            commands::hide_loading,
            commands::show_recording,
            commands::hide_recording,
            commands::set_audio_muted,
            commands::play_sound,
            commands::open_accessibility_settings,
            mouse_hook::mouse_hook_active,
            mouse_hook::restart_mouse_hook,
            mouse_hook::set_mouse_bindings,
            keyboard::save_active_app,
            keyboard::get_target_app,
            keyboard::capture_foreground_hwnd,
            keyboard::get_captured_target_pos,
            stt::transcribe_local,
            stt::stt_model_status,
            stt::download_stt_model,
            mt::mt_model_status,
            mt::translate_local,
            keyboard::capture_and_copy,
            keyboard::simulate_copy,
            keyboard::simulate_copy_direct,
            keyboard::simulate_terminal_copy,
            keyboard::simulate_paste,
            keyboard::simulate_paste_to_app,
            keyboard::restore_focus_to_app,
            keyboard::simulate_terminal_replace,
            keyboard::get_terminal_selection,
            keyboard::debug_terminal_info,
            mac_rounded_corners::enable_rounded_corners,
            mac_rounded_corners::enable_modern_window_style,
            mac_rounded_corners::reposition_traffic_lights,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
