use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use std::process::Command;

// Remembers the system mute state from before we muted, so we only un-mute audio
// the user wasn't already muting.
#[cfg(target_os = "macos")]
static PRIOR_MUTED: std::sync::Mutex<Option<bool>> = std::sync::Mutex::new(None);

/// Serialises every audio transition. PRIOR_MUTED and the machine's actual mute state are one
/// piece of state, but they used to be updated through two separate short lock acquisitions
/// with a ~120ms `osascript` in between — so two calls could both read "nothing held", or a
/// stale un-mute could land after a newer mute and leave the flag and the speakers disagreeing
/// forever. Held across the subprocess on purpose: these run once per voice session, and
/// correctness here is worth more than the microseconds.
#[cfg(target_os = "macos")]
static AUDIO_OP: std::sync::Mutex<()> = std::sync::Mutex::new(());

// Mute/unmute the laptop's system output while recording voice, so background
// audio (music, notifications) is silenced — both to focus the user and to keep
// the mic (and thus the VAD) from picking up speaker audio.
#[tauri::command]
pub async fn set_audio_muted(mute: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Poisoning must not wedge audio control permanently — a panic elsewhere should not
        // leave the user unable to get their sound back.
        let _op = AUDIO_OP.lock().unwrap_or_else(|e| e.into_inner());
        if mute {
            // If we are ALREADY holding a mute, do not read the current state again: it would
            // read back our own mute as the user's "prior" setting, and the later un-mute would
            // then decide the user wanted silence and leave the audio off for good. Overlapping
            // sessions are normal — pressing the voice shortcut again right after finishing.
            let already_holding = PRIOR_MUTED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some();
            if already_holding {
                let _ = Command::new("osascript")
                    .arg("-e")
                    .arg("set volume output muted true")
                    .output();
            } else {
                // Read the prior state and mute in ONE osascript process. Two processes measured
                // 233ms median (115 + 117) against 119ms combined — and this sits directly
                // between pressing the voice shortcut and the microphone opening, so it was over
                // a third of the delay that made the app look like it started listening late.
                // `prev`, not `st`: `st` is reserved in AppleScript, and naming the variable
                // that made this whole script a syntax error — so `set volume output muted
                // true` never ran and background audio simply kept playing. It failed silently
                // because the exit status was ignored, which is the more important half of
                // this fix: a broken script must never again read as "muted successfully".
                let script = "set prev to (output muted of (get volume settings))\n\
                              set volume output muted true\n\
                              return prev";
                match Command::new("osascript").arg("-e").arg(script).output() {
                    Ok(out) if out.status.success() => {
                        let prior = String::from_utf8_lossy(&out.stdout).trim() == "true";
                        *PRIOR_MUTED.lock().unwrap_or_else(|e| e.into_inner()) = Some(prior);
                    }
                    Ok(out) => {
                        // Nothing was muted, so claim nothing: leaving PRIOR_MUTED unset keeps
                        // the later restore from "un-muting" audio we never touched.
                        return Err(format!(
                            "could not mute system audio: {}",
                            String::from_utf8_lossy(&out.stderr).trim()
                        ));
                    }
                    Err(e) => return Err(format!("could not run osascript: {e}")),
                }
            }
        } else {
            // ONLY Some(false) means "we muted this, and it was audible before". `None` means
            // we hold nothing — a second restore for the same session, or a stray call — and
            // must be a no-op. Treating it as "unmute" un-muted machines the user had
            // deliberately silenced themselves: the first restore consumed Some(true) and
            // correctly left them muted, then the second saw None and turned their sound on.
            let prior = PRIOR_MUTED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            if prior == Some(false) {
                let _ = Command::new("osascript").arg("-e").arg("set volume output muted false").output();
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = mute; // TODO: Windows system-mute support
        Ok(())
    }
}

/// Give the user their audio back if we still hold the mute.
///
/// System mute is global state that outlives the process: quitting mid-recording used to leave
/// the machine silent with nothing on screen to explain why, and the user would go hunting
/// through Sound settings. Cheap enough to do on every exit path.
#[cfg(target_os = "macos")]
pub fn release_mute_if_held() {
    // Same lock as set_audio_muted: without it, quitting could observe "nothing held" while a
    // mute was mid-flight, exit, and leave the orphaned osascript to mute the whole machine
    // after the app was gone.
    let _op = AUDIO_OP.lock().unwrap_or_else(|e| e.into_inner());
    let prior = PRIOR_MUTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if prior == Some(false) {
        let _ = Command::new("osascript")
            .arg("-e")
            .arg("set volume output muted false")
            .output();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn release_mute_if_held() {}

/// Actually leave the app. Settings > Quit used to call hide_settings_window, so choosing
/// Quit only closed the window: the app kept running in the tray, still holding Accessibility
/// and still answering global shortcuts. A user who picks Quit and later finds it alive
/// reasonably concludes it ignored them. Matches what the tray's Quit does.
#[tauri::command]
pub fn quit_app() {
    release_mute_if_held();
    std::process::exit(0);
}

#[tauri::command]
pub async fn show_settings_window(app: AppHandle) -> Result<(), String> {
    // Make sure the app itself is foreground + unhidden first, so opening from the tray always
    // works even if the app was left in a background/deactivated state (e.g. after a voice cancel).
    #[cfg(target_os = "macos")]
    activate_app();
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html".into()))
            .title("VibeTranslate")
            .inner_size(850.0, 500.0)
            .resizable(true)
            .center()
            .build()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_popup(app: AppHandle) -> Result<(), String> {
    // Popup mode ends here (no paste step follows) — release the target pin set at capture,
    // so the tracker resumes following the user instead of staying frozen for the full 60s.
    crate::keyboard::resume_tracker();
    if let Some(window) = app.get_webview_window("popup") {
        // Follow the user across displays: if the popup sits on a DIFFERENT monitor than the one
        // the user is working on, bring it over (manual placement on the same display is kept).
        if let (Some(active), Ok(win_pos)) = (active_monitor(&window), window.outer_position()) {
            // Compare in the same coordinate space as monitor_rect (logical on macOS).
            let r = monitor_rect(&active);
            #[cfg(target_os = "macos")]
            let (wx, wy) = {
                let sc = window.scale_factor().unwrap_or(1.0).max(0.5);
                (win_pos.x as f64 / sc, win_pos.y as f64 / sc)
            };
            #[cfg(not(target_os = "macos"))]
            let (wx, wy) = (win_pos.x as f64, win_pos.y as f64);
            if !r.contains(wx, wy) {
                center_on_active_monitor(&window);
            }
        }
        // Show WITHOUT focus. A focused popup is the root of the "jumps to the primary
        // monitor and copy fails" bug: the next translate hides the still-focused popup,
        // macOS hands key status to our main window (primary display), and the Cmd+C then
        // races an app-level refocus. The popup is click-driven (no keyboard handlers),
        // so it never needs focus — clicking a button focuses it on demand anyway.
        window.show().map_err(|e| e.to_string())?;
    } else {
        #[allow(unused_mut)]
        let mut builder = WebviewWindowBuilder::new(&app, "popup", WebviewUrl::App("index.html#/popup".into()))
            .title("Translation")
            .inner_size(480.0, 520.0)
            .resizable(true)
            .decorations(true)
            .always_on_top(true)
            .focused(false)
            .accept_first_mouse(true)
            .center();

        let window = builder.build().map_err(|e: tauri::Error| e.to_string())?;
        center_on_active_monitor(&window); // .center() targets the primary display
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_popup(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("popup") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_loading(app: AppHandle, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("loading") {
        if let (Some(px), Some(py)) = (x, y) {
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: px as i32,
                y: py as i32,
            }));
        } else {
            // No explicit coords -> follow the user's active monitor (multi-display setups).
            center_on_active_monitor(&window);
        }
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_always_on_top(true);
        // Emit event to reset timer
        let _ = window.emit("loading-show", ());
    } else {
        let base_builder = WebviewWindowBuilder::new(&app, "loading", WebviewUrl::App("index.html#/loading".into()))
            .title("")
            .inner_size(150.0, 160.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            // Never take focus: a focusable loading window ACTIVATES the app when shown, which
            // also raises the main settings window — the user only wants the indicator.
            .focused(false)
            .skip_taskbar(true);
        
        #[cfg(target_os = "macos")]
        let base_builder = base_builder.visible_on_all_workspaces(true);
        
        let builder = if let (Some(px), Some(py)) = (x, y) {
            base_builder.position(px, py)
        } else {
            base_builder.center()
        };

        let window = builder.build().map_err(|e: tauri::Error| e.to_string())?;
        if x.is_none() || y.is_none() {
            // .center() centers on the primary display; move to the user's active monitor.
            center_on_active_monitor(&window);
        }
        // Same non-activating float treatment as the recording overlay.
        #[cfg(target_os = "macos")]
        set_overlay_level(&window);
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_loading(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("loading") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- Multi-monitor helpers ----------
//
// macOS reports MIXED units (verified on real hardware): the global cursor position comes back
// as logical-points x PRIMARY scale, while each monitor's position/size are logical x THAT
// monitor's own scale. With a 2x Retina primary + 1x externals nothing lines up in "physical"
// space, so containment always missed and every overlay fell back to the primary display.
// The only consistent space on macOS is LOGICAL points: normalize everything into it and
// position windows with Position::Logical. Windows reports true physical for both cursor and
// monitors, so there the raw physical math is the correct one.

struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

// A monitor's bounds in the coordinate space we do math in (logical on macOS, physical elsewhere).
fn monitor_rect(m: &tauri::Monitor) -> Rect {
    #[cfg(target_os = "macos")]
    {
        let s = m.scale_factor().max(0.5);
        Rect {
            x: m.position().x as f64 / s,
            y: m.position().y as f64 / s,
            w: m.size().width as f64 / s,
            h: m.size().height as f64 / s,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Rect {
            x: m.position().x as f64,
            y: m.position().y as f64,
            w: m.size().width as f64,
            h: m.size().height as f64,
        }
    }
}

// Cursor position in the same space as monitor_rect.
fn cursor_in_space(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let app = window.app_handle();
    let pos = app.cursor_position().ok()?;
    #[cfg(target_os = "macos")]
    {
        let primary_scale = window
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0)
            .max(0.5);
        Some((pos.x / primary_scale, pos.y / primary_scale))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some((pos.x, pos.y))
    }
}

// Move a window so its top-left is at (x, y) in our math space.
fn set_window_pos(window: &tauri::WebviewWindow, x: f64, y: f64) {
    #[cfg(target_os = "macos")]
    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: x as i32,
        y: y as i32,
    }));
}

// The window's own size in our math space.
fn window_size_in_space(window: &tauri::WebviewWindow) -> (f64, f64) {
    let size = window.outer_size().unwrap_or(tauri::PhysicalSize {
        width: 0,
        height: 0,
    });
    #[cfg(target_os = "macos")]
    {
        let s = window.scale_factor().unwrap_or(1.0).max(0.5);
        (size.width as f64 / s, size.height as f64 / s)
    }
    #[cfg(not(target_os = "macos"))]
    {
        (size.width as f64, size.height as f64)
    }
}

// The monitor the user is actively working on. Preference order:
// 1. The display of the captured target window (the "lock") — where the copy/paste is
//    aimed. Immune to a cursor parked on another screen and to other apps stealing focus
//    mid-operation; keeps overlays, popup and paste all on the same display.
// 2. The cursor's display (also the pre-capture / Windows behavior).
// 3. The primary monitor.
fn active_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    let monitors = window.available_monitors().ok();
    #[cfg(target_os = "macos")]
    if let (Some((wx, wy)), Some(monitors)) =
        (crate::keyboard::last_target_win_pos(), monitors.as_ref())
    {
        // Small inset: a window dragged between displays can have its exact corner
        // sitting on the neighbouring screen.
        let (px, py) = (wx as f64 + 10.0, wy as f64 + 10.0);
        for m in monitors {
            if monitor_rect(m).contains(px, py) {
                return Some(m.clone());
            }
        }
    }
    if let (Some((cx, cy)), Some(monitors)) = (cursor_in_space(window), monitors.as_ref()) {
        for m in monitors {
            if monitor_rect(m).contains(cx, cy) {
                return Some(m.clone());
            }
        }
        dlog!(
            "[MonDebug] no monitor contains cursor ({:.0},{:.0}) -> primary fallback",
            cx, cy
        );
    }
    window.primary_monitor().ok().flatten()
}

// Center a floating window on the active (cursor) monitor.
fn center_on_active_monitor(window: &tauri::WebviewWindow) {
    if let Some(monitor) = active_monitor(window) {
        let r = monitor_rect(&monitor);
        let (ww, wh) = window_size_in_space(window);
        set_window_pos(window, r.x + ((r.w - ww) / 2.0).max(0.0), r.y + ((r.h - wh) / 2.0).max(0.0));
    }
}

// Position the overlay centered horizontally, at the top / vertical-center / bottom of the
// ACTIVE screen depending on the user's preference ("top" | "center" | "bottom").
fn position_recording_window(window: &tauri::WebviewWindow, position: &str) {
    if let Some(monitor) = active_monitor(window) {
        let r = monitor_rect(&monitor);
        let (ww, wh) = window_size_in_space(window);
        let x = r.x + ((r.w - ww) / 2.0).max(0.0);
        let margin = (r.h / 12.0).max(20.0);
        let y = r.y
            + match position {
                "center" => (r.h - wh) / 2.0,
                "bottom" => r.h - wh - margin,
                _ => r.h / 12.0, // "top" (default)
            }
            .max(20.0);
        set_window_pos(window, x, y);
    }
}

// Make the overlay float above everything on every Space (macOS), without
// changing focus. Applied once when the window is created.
#[cfg(target_os = "macos")]
fn set_overlay_level(window: &tauri::WebviewWindow) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};
    let _ = window.with_webview(|webview| unsafe {
        let ns_window = webview.ns_window() as id;
        let _: () = msg_send![ns_window, setLevel: 3i64]; // NSFloatingWindowLevel
        let behavior: u64 = (1 << 0) | (1 << 4) | (1 << 8); // allSpaces|stationary|fsAux
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
    });
}

// Bring the whole app to the foreground (active). Required for voice capture: WebKit
// mutes getUserMedia when the owning app is NOT the active/frontmost app. When the main
// window is closed to the tray VibeTranslate is a background app, so just showing +
// focusing the (non-activating) overlay isn't enough — the mic stays silent. Activating
// the app makes the overlay the active window so the mic actually delivers audio.
#[cfg(target_os = "macos")]
fn activate_app() {
    use cocoa::base::{id, YES};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let ns_app: id = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, activateIgnoringOtherApps: YES];
    }
}

// Activating the app is unavoidable — WebKit gives a background app a silent microphone — but
// `activateIgnoringOtherApps:` raises EVERY visible window we own, not just the one being
// shown. With Settings left open on another display, triggering voice made the whole settings
// UI jump to the front on that screen: "the popup appears, but the main page opens too".
//
// So: activate, then immediately order our OTHER windows back down. They stay open exactly
// where the user left them; only the overlay comes forward. AppKit window ordering must run on
// the main thread.
#[cfg(target_os = "macos")]
fn order_back_other_windows(app: &AppHandle, keep: &'static str) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        use cocoa::base::{id, nil};
        use objc::{msg_send, sel, sel_impl};
        for (label, w) in app.webview_windows() {
            if label == keep || !w.is_visible().unwrap_or(false) {
                continue;
            }
            if let Ok(ptr) = w.ns_window() {
                unsafe {
                    let ns: id = ptr as id;
                    let _: () = msg_send![ns, orderBack: nil];
                }
            }
        }
    });
}

// Build the recording overlay once (hidden). Pre-created at startup so it is
// already rendered and its event listeners are ready by the time it's shown.
pub fn ensure_recording_window(app: &AppHandle) {
    if app.get_webview_window("recording").is_some() {
        return;
    }
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, "recording", WebviewUrl::App("index.html#/recording".into()))
        .title("")
        .inner_size(286.0, 46.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .focused(false)
        .skip_taskbar(true)
        .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder.visible_on_all_workspaces(true);
    }

    if let Ok(window) = builder.build() {
        position_recording_window(&window, "top"); // startup default; repositioned on show
        #[cfg(target_os = "macos")]
        set_overlay_level(&window);
    }
}

// Live-transcript overlay: its OWN window, sitting just below the listening pill.
//
// The first attempt grew the pill itself to fit the text. It worked, but the text crowded the
// level bars and the done/cancel buttons — the thing the user is actually looking at while
// speaking. Keeping them separate means the listening indicator is byte-for-byte what it was
// before live dictation existed, and the transcript can be as tall as it likes.
pub fn ensure_transcript_window(app: &AppHandle) {
    if app.get_webview_window("transcript").is_some() {
        return;
    }
    #[allow(unused_mut)]
    let mut builder =
        WebviewWindowBuilder::new(app, "transcript", WebviewUrl::App("index.html#/transcript".into()))
            .title("")
            .inner_size(520.0, 74.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .focused(false)
            .skip_taskbar(true)
            .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder.visible_on_all_workspaces(true);
    }

    if let Ok(window) = builder.build() {
        #[cfg(target_os = "macos")]
        set_overlay_level(&window);
    }
}

/// Place it under the listening pill, centred on the same monitor.
fn position_transcript_window(app: &AppHandle) {
    let (Some(rec), Some(tr)) = (
        app.get_webview_window("recording"),
        app.get_webview_window("transcript"),
    ) else {
        return;
    };
    let Some(monitor) = active_monitor(&rec) else { return };
    let r = monitor_rect(&monitor);
    let (rw, rh) = window_size_in_space(&rec);
    let (tw, _) = window_size_in_space(&tr);

    // Read the pill's actual position rather than recomputing it: the user can choose top,
    // centre or bottom, and guessing would put the transcript in the wrong place for two of
    // the three.
    let (rx, ry) = match rec.outer_position() {
        Ok(p) => {
            #[cfg(target_os = "macos")]
            {
                let sc = rec.scale_factor().unwrap_or(1.0).max(0.5);
                (p.x as f64 / sc, p.y as f64 / sc)
            }
            #[cfg(not(target_os = "macos"))]
            {
                (p.x as f64, p.y as f64)
            }
        }
        Err(_) => (r.x + (r.w - rw) / 2.0, r.y + r.h / 12.0),
    };
    let x = (rx + (rw - tw) / 2.0).max(r.x);
    let y = ry + rh + 8.0;
    set_window_pos(&tr, x, y);
}

#[tauri::command]
pub async fn show_transcript(app: AppHandle) -> Result<(), String> {
    ensure_transcript_window(&app);
    position_transcript_window(&app);
    if let Some(w) = app.get_webview_window("transcript") {
        let _ = w.set_always_on_top(true);
        w.show().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        set_overlay_level(&w);
    }
    // Showing a window can hand it the keyboard, and this one has no reason to hold it: the
    // listening pill is where Enter and Esc belong. Give focus straight back.
    if let Some(rec) = app.get_webview_window("recording") {
        let _ = rec.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_transcript(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("transcript") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Recording overlay: small non-activating indicator. `position` = "top" | "center" | "bottom".
#[tauri::command]
pub async fn show_recording(app: AppHandle, position: Option<String>) -> Result<(), String> {
    ensure_recording_window(&app);
    if let Some(window) = app.get_webview_window("recording") {
        position_recording_window(&window, position.as_deref().unwrap_or("top"));
        let _ = window.set_always_on_top(true);
        window.show().map_err(|e| e.to_string())?;
        // Bring the app to the foreground FIRST so WebKit un-mutes the mic (getUserMedia is
        // silent for a background app), then focus the overlay so ✓/✗ + Esc work.
        #[cfg(target_os = "macos")]
        {
            activate_app();
            // Undo the collateral damage of activation before the user can see it.
            order_back_other_windows(&app, "recording");
        }
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        set_overlay_level(&window); // keep it floating above everything
        // Re-focus shortly after: activation is asynchronous, and if another of our windows
        // (e.g. settings) grabs key status first, Enter/Esc would land there instead. The
        // same asynchrony can let a raised window slip back up, so re-apply the ordering too.
        let w = window.clone();
        #[cfg(target_os = "macos")]
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let _ = w.set_focus();
            #[cfg(target_os = "macos")]
            order_back_other_windows(&app2, "recording");
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_recording(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("recording") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Play system sound for feedback
#[tauri::command]
pub async fn play_sound(sound_type: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let sound_name = match sound_type.as_str() {
            "start" => "Tink",
            "success" => "Glass",
            "error" => "Basso",
            _ => "Pop",
        };
        
        let script = format!(
            r#"do shell script "afplay /System/Library/Sounds/{}.aiff &""#,
            sound_name
        );
        
        // Reap it. Rust's Child has no Drop that waits, so a spawn-and-forget leaves a zombie
        // for the lifetime of the app — and this fires on every translate start, success and
        // error. A long-running menu-bar app accumulates them until fork() starts failing for
        // the whole login session, which then breaks unrelated programs and looks like
        // anything but a sound effect.
        if let Ok(mut child) = Command::new("osascript").arg("-e").arg(&script).spawn() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        // Use PowerShell to play Windows system sounds
        // Run synchronously in background thread to not block
        let sound = sound_type.clone();
        std::thread::spawn(move || {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            
            // Map to Windows sound aliases that work with SoundPlayer
            let sound_file = match sound.as_str() {
                "start" => r"C:\Windows\Media\Windows Notify System Generic.wav",
                "success" => r"C:\Windows\Media\Windows Notify Calendar.wav",
                "error" => r"C:\Windows\Media\Windows Critical Stop.wav",
                _ => r"C:\Windows\Media\Windows Ding.wav",
            };
            
            // Use PowerShell SoundPlayer which is more reliable
            let cmd = format!(
                "(New-Object Media.SoundPlayer '{}').PlaySync()",
                sound_file
            );
            
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &cmd])
                .creation_flags(CREATE_NO_WINDOW)
                .output(); // Use output() to wait for completion
        });
        dlog!("[play_sound] Windows: Playing sound type: {}", sound_type);
    }
    
    Ok(())
}

// Open macOS Accessibility Settings
#[tauri::command]
pub async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    
    #[cfg(not(target_os = "macos"))]
    {
        // No-op on other platforms
    }
    
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod mute_behaviour {
    //! Drives the real system mute. It restores the machine's original state before finishing.
    //! This exists because a syntax error in the mute script shipped to users and produced
    //! silence in the logs instead of silence in the speakers.
    fn muted_now() -> bool {
        let out = std::process::Command::new("osascript")
            .arg("-e")
            .arg("output muted of (get volume settings)")
            .output()
            .expect("osascript");
        String::from_utf8_lossy(&out.stdout).trim() == "true"
    }

    /// The command is `async fn` but never awaits anything, so a one-shot poll is enough and
    /// avoids pulling a whole async runtime in just to test it.
    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn noop(_: *const ()) {}
        fn clone(p: *const ()) -> RawWaker { RawWaker::new(p, &VT) }
        static VT: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VT)) };
        let mut cx = Context::from_waker(&waker);
        let mut f = Box::pin(f);
        loop {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    #[test]
    fn mutes_then_restores() {
        let original = muted_now();
        println!("keadaan awal muted = {original}");

        block_on(super::set_audio_muted(true)).expect("mute gagal");
        let after_mute = muted_now();
        println!("sesudah mute       = {after_mute}");
        assert!(after_mute, "TIDAK membisukan — ini bug yang dilaporkan");

        block_on(super::set_audio_muted(false)).expect("restore gagal");
        let after_restore = muted_now();
        println!("sesudah restore    = {after_restore}");
        assert_eq!(after_restore, original, "tidak kembali ke keadaan semula");

        // Restore kedua (jalur yang benar-benar terjadi: stopRecording lalu finishSession)
        // harus tidak melakukan apa-apa.
        block_on(super::set_audio_muted(false)).expect("restore kedua gagal");
        assert_eq!(muted_now(), original, "restore kedua mengubah keadaan");
        println!("restore kedua      = no-op: benar");
    }
}
