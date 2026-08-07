use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Listener, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

// Current shortcut set + which optional features are on. Sent from the frontend (App.tsx)
// on settings load + whenever a shortcut/toggle changes, so the tray menu always shows the
// user's ACTUAL (customized) shortcuts — not hardcoded defaults.
#[derive(serde::Deserialize)]
struct TrayShortcuts {
    translate: String,
    popup: String,
    terminal: String,
    enhance: String,
    voice: String,
    #[serde(rename = "voiceOriginal")]
    voice_original: String,
    #[serde(rename = "voiceEnabled")]
    voice_enabled: bool,
    #[serde(rename = "enhanceEnabled")]
    enhance_enabled: bool,
}

impl Default for TrayShortcuts {
    fn default() -> Self {
        Self {
            translate: "CommandOrControl+Alt+T".into(),
            popup: "CommandOrControl+Alt+P".into(),
            terminal: "CommandOrControl+Alt+Shift+T".into(),
            enhance: "CommandOrControl+Alt+E".into(),
            voice: "CommandOrControl+Alt+V".into(),
            voice_original: "CommandOrControl+Alt+Shift+V".into(),
            voice_enabled: true,
            enhance_enabled: false,
        }
    }
}

fn acc(s: &str) -> Option<&str> {
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

fn show_settings<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
            .title("VibeTranslate")
            .inner_size(850.0, 500.0)
            .resizable(true)
            .center()
            .build();
    }
}

// Build the tray menu: an app-name header, then each feature with its shortcut shown as the
// accelerator (feature rows are DISABLED = informational — they exist so you can see what each
// shortcut does; the real trigger is the global shortcut, since clicking here would act on the
// tray, not your target app), then Open Settings + Quit.
fn build_tray_menu<R: Runtime>(app: &AppHandle<R>, s: &TrayShortcuts) -> tauri::Result<Menu<R>> {
    let title = MenuItem::with_id(app, "title", "VibeTranslate", false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let f_translate = MenuItem::with_id(app, "f_translate", "Translate & Replace", false, acc(&s.translate))?;
    let f_popup = MenuItem::with_id(app, "f_popup", "Popup Translate", false, acc(&s.popup))?;
    let f_terminal = MenuItem::with_id(app, "f_terminal", "CLI Translate (Replace)", false, acc(&s.terminal))?;
    let f_enhance = MenuItem::with_id(app, "f_enhance", "Enhance", false, acc(&s.enhance))?;
    let f_voice = MenuItem::with_id(app, "f_voice", "Voice → Translate", false, acc(&s.voice))?;
    let f_voice_orig = MenuItem::with_id(app, "f_voice_orig", "Voice → Dictation", false, acc(&s.voice_original))?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let open = MenuItem::with_id(app, "settings", "Open Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let mut items: Vec<&dyn IsMenuItem<R>> = vec![&title, &sep1, &f_translate, &f_popup, &f_terminal];
    if s.enhance_enabled {
        items.push(&f_enhance);
    }
    if s.voice_enabled {
        items.push(&f_voice);
        items.push(&f_voice_orig);
    }
    items.push(&sep2);
    items.push(&open);
    items.push(&quit);

    Menu::with_items(app, &items)
}

pub fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let menu = build_tray_menu(&handle, &TrayShortcuts::default())?;

    // Load the tray icon. EMBED it at compile time (include_bytes! resolves relative to THIS
    // source file, so it always finds src-tauri/icons/tray-icon.png) instead of a runtime
    // relative path — the old from_path("icons/tray-icon.png") resolved against the process CWD,
    // which in a bundled app isn't the icons dir, so it silently fell back to the full-colour
    // app icon and rendered as a blank box under macOS template mode.
    let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());

    #[allow(unused_mut)] // mut needed for macOS icon_as_template
    let mut builder = TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        // Left-click opens the app directly (the natural primary action); the menu appears on right-click.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_settings(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                show_settings(app);
            }
            "quit" => {
                // Same reason as commands::quit_app: never leave the machine muted.
                crate::commands::release_mute_if_held();
                std::process::exit(0);
            }
            _ => {}
        });

    // Template icon on macOS (auto-adjusts to menu bar colour).
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }

    let _tray = builder.build(app)?;

    // Rebuild the menu with the user's real shortcuts whenever the frontend emits them.
    let listen_handle = app.handle().clone();
    app.listen("tray-shortcuts", move |event| {
        if let Ok(s) = serde_json::from_str::<TrayShortcuts>(event.payload()) {
            if let Some(tray) = listen_handle.tray_by_id("main") {
                if let Ok(menu) = build_tray_menu(&listen_handle, &s) {
                    let _ = tray.set_menu(Some(menu));
                }
            }
        }
    });

    Ok(())
}
