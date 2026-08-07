//! # Keyboard Module
//! 
//! This module handles keyboard simulation for copy/paste operations across different platforms.
//! 
//! ## Key Features:
//! - Cross-platform support (Windows & macOS)
//! - Smart terminal detection with different copy strategies per terminal type
//! - HWND (Window Handle) tracking for accurate focus management on Windows
//! - Background app tracker to monitor active windows
//! 
//! ## Terminal Copy Strategies (Windows):
//! - **VS Code**: Uses standard Ctrl+C (selection persists after focus loss)
//! - **Windows Terminal**: Uses Ctrl+Shift+C/V (modern terminal shortcuts)
//! - **Legacy Console (CMD/PowerShell)**: Uses Right-Click in QuickEdit mode
//! - **Unknown/CLI Tools**: Uses Right-Click for terminal mode, Ctrl+C for normal mode

#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use once_cell::sync::Lazy;

/// Escape a string for safe interpolation inside an AppleScript double-quoted literal.
/// Without this, an app name containing `"` could close the string and inject
/// `do shell script "..."` → arbitrary code execution. We escape `\` and `"`, strip all
/// control chars (newlines/CR), and cap the length. Applied to every app/process name
/// that reaches an `osascript` `tell application/process "{}"` interpolation.
#[cfg(target_os = "macos")]
fn escape_applescript(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().filter(|c| !c.is_control()).take(200) {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            other => out.push(other),
        }
    }
    out
}

// =============================================================================
// CONSTANTS
// =============================================================================

/// Windows Console selection state flags (from wincon.h)
/// Used with GetConsoleSelectionInfo API
#[cfg(target_os = "windows")]
#[allow(dead_code)]
const CONSOLE_SELECTION_NONE: u32 = 0x0000;

#[cfg(target_os = "windows")]
#[allow(dead_code)]
const CONSOLE_SELECTION_IN_PROGRESS: u32 = 0x0001;

#[cfg(target_os = "windows")]
const CONSOLE_SELECTION_NOT_EMPTY: u32 = 0x0002;

// =============================================================================
// GLOBAL STATE
// =============================================================================

/// Stores the name of the last active application (excluding our own app windows).
/// Used primarily on macOS for app activation.
static LAST_ACTIVE_APP: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

/// Flag to track if the background window tracker has been started.
/// Prevents multiple tracker threads from running simultaneously.
static TRACKER_STARTED: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

/// Windows-specific: Stores the HWND (window handle) of the last active window.
/// Stored as isize for thread-safety (HWND is a pointer type).
/// This is critical for restoring focus after copy/paste operations.
#[cfg(target_os = "windows")]
static LAST_ACTIVE_HWND: Lazy<Mutex<isize>> = Lazy::new(|| Mutex::new(0));

/// macOS: screen position of the frontmost WINDOW captured at operation start. App-level
/// `activate` lets macOS pick ANY of the app's windows (it prefers one on the active Space/
/// display) — with several windows of the same app across monitors the wrong one gets focus.
/// Position survives as an identifier even when all windows share a title, so the paste can
/// AXRaise exactly the window the user was in.
static LAST_ACTIVE_WIN_POS: Lazy<Mutex<Option<(i32, i32)>>> = Lazy::new(|| Mutex::new(None));

// The captured target window's top-left (global logical points) — the "lock". Window
// placement (commands.rs) anchors overlays/popup to the display this window is on, so
// they follow where the user is WORKING even when the cursor is parked on another screen.
#[cfg(target_os = "macos")]
pub fn last_target_win_pos() -> Option<(i32, i32)> {
    LAST_ACTIVE_WIN_POS.lock().ok().and_then(|g| *g)
}

// Frontend snapshot of the captured window position (voice stores it in its start payload).
#[tauri::command]
pub async fn get_captured_target_pos() -> Option<(i32, i32)> {
    #[cfg(target_os = "macos")]
    {
        last_target_win_pos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// While "now" is before this instant, the background tracker PAUSES updating LAST_ACTIVE_APP/HWND,
/// so the target captured at the start of a translate stays PINNED through the API round-trip and
/// paste. Without this, a Cmd-Tab (or an overlay stealing focus) mid-operation redirects the paste
/// to the wrong app. It auto-expires as a safety net if a paste never resumes it.
static TRACKER_RESUME_AT: Lazy<Mutex<Option<std::time::Instant>>> = Lazy::new(|| Mutex::new(None));

fn pause_tracker(secs: u64) {
    if let Ok(mut g) = TRACKER_RESUME_AT.lock() {
        *g = Some(std::time::Instant::now() + Duration::from_secs(secs));
    }
}

pub fn resume_tracker() {
    if let Ok(mut g) = TRACKER_RESUME_AT.lock() {
        *g = None;
    }
}

fn tracker_is_paused() -> bool {
    TRACKER_RESUME_AT
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|t| std::time::Instant::now() < t)
        .unwrap_or(false)
}

// Wait until the user has physically RELEASED all modifier keys (up to `timeout_ms`).
// The copy shortcut itself contains modifiers (e.g. Option+P): if the synthetic Cmd+C fires
// while Option is still held, the target app receives Cmd+Opt+C — usually NOT a copy command —
// so the copy silently produces nothing. Every serious selection-grabbing tool waits like this.
#[cfg(target_os = "macos")]
fn wait_modifiers_released(timeout_ms: u64) {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }
    const MODS: u64 = 0x0002_0000 | 0x0004_0000 | 0x0008_0000 | 0x0010_0000; // shift|ctrl|alt|cmd
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let flags = unsafe { CGEventSourceFlagsState(0) }; // combined session state
        if flags & MODS == 0 {
            return;
        }
        if std::time::Instant::now() >= deadline {
            dlog!("[CopyDebug] modifiers still held after {}ms - sending copy anyway", timeout_ms);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
}

// Same answer as get_frontmost_app_and_window(), obtained WITHOUT spawning a process.
//
// Why this exists: the background tracker used to run the osascript version roughly twice a
// second for the entire life of the app — about 180ms wall and a whole fork+exec each time,
// ~180,000 processes a day on an app that is meant to sit quietly in the menu bar. It never
// showed up in the app's own CPU column because the cost was billed to short-lived children,
// so it would have been reported as "the battery drains and I don't know why".
//
// CGWindowListCopyWindowInfo returns on-screen windows in front-to-back order, with the owner
// name and the bounds, in-process. Window TITLES would need Screen Recording permission; the
// owner name and bounds do not, and titles are not needed here.
//
// The frontmost application's name, in-process and effectively free.
//
// Why this exists: the background tracker used to spawn `osascript` roughly twice a second for
// the entire life of the app — a fork+exec and ~175ms each time, on something meant to sit
// quietly in the menu bar. It never appeared in the app's own CPU column, because the cost was
// billed to short-lived children; it would have been reported as "the battery drains and I
// don't know why".
//
// Measured on this machine, per call: this 0.086ms, `osascript` 174.7ms — about 2000x. Both
// returned the same name. NSRunningApplication is documented as safe to use from any thread.
//
// NAME ONLY, deliberately. An earlier attempt also read the window position here, via
// CGWindowListCopyWindowInfo, and it disagreed with System Events: for the same window it gave
// (-761, -85) where System Events gave (-760, -1410) — the two measure from different display
// origins. Positions are compared against System Events readings elsewhere (simulate_copy
// re-checks that the frontmost window is still the captured one), so mixing the two would
// silently break window matching on a multi-monitor setup, which is the very bug this tracker
// exists to prevent.
#[cfg(target_os = "macos")]
fn frontmost_name_fast() -> Option<String> {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        if ws == nil {
            return None;
        }
        let app: id = msg_send![ws, frontmostApplication];
        if app == nil {
            return None;
        }
        let name: id = msg_send![app, localizedName];
        if name == nil {
            return None;
        }
        let c: *const std::os::raw::c_char = msg_send![name, UTF8String];
        if c.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(c).to_string_lossy().into_owned())
    }
}

// Frontmost app AND its front window's screen position (one osascript round-trip).
#[cfg(target_os = "macos")]
fn get_frontmost_app_and_window() -> Result<(String, Option<(i32, i32)>), String> {
    let script = r#"tell application "System Events"
        set p to first application process whose frontmost is true
        set out to name of p
        try
            set posn to position of front window of p
            set out to out & "||" & (item 1 of posn) & "||" & (item 2 of posn)
        end try
        return out
    end tell"#;
    // The query can transiently report our own just-spawned "osascript" helper as the
    // frontmost process (it races the real answer). That noise reading broke both capture
    // ("No app tracked" right after launch) and the frontmost-at-copy check — retry briefly
    // before accepting it.
    let mut last: (String, Option<(i32, i32)>) = (String::new(), None);
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("Failed to get active app: {}", e))?;
        if !output.status.success() {
            return Err("Failed to get frontmost app".to_string());
        }
        let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let mut parts = raw.split("||");
        let app = parts.next().unwrap_or_default().trim().to_string();
        let pos = match (parts.next(), parts.next()) {
            (Some(x), Some(y)) => match (x.trim().parse::<i32>(), y.trim().parse::<i32>()) {
                (Ok(x), Ok(y)) => Some((x, y)),
                _ => None,
            },
            _ => None,
        };
        let transient = app == "osascript";
        last = (app, pos);
        if !transient {
            break;
        }
    }
    Ok(last)
}

// AppleScript prelude that focuses the SPECIFIC captured window: bring the app's process
// frontmost, then AXRaise the window whose position matches the captured one. Falls back to
// plain app focus when no position is stored or the window moved/closed.
#[cfg(target_os = "macos")]
fn activate_target_prelude(app: &str) -> String {
    activate_target_prelude_at(app, LAST_ACTIVE_WIN_POS.lock().ok().and_then(|g| *g))
}

// Like activate_target_prelude, but with the window position supplied by the CALLER — used by
// voice paste, whose target was captured at recording START: the global slot may have been
// overwritten since (e.g. a translate run in another window while the recording was live).
#[cfg(target_os = "macos")]
fn activate_target_prelude_at(app: &str, pos: Option<(i32, i32)>) -> String {
    let app_esc = escape_applescript(app);
    match pos {
        Some((x, y)) => format!(
            r#"tell application "System Events"
                set p to first application process whose name is "{app}"
                set frontmost of p to true
                try
                    set matched to false
                    repeat with w in windows of p
                        set posn to position of w
                        if ((item 1 of posn) = {x}) and ((item 2 of posn) = {y}) then
                            perform action "AXRaise" of w
                            set matched to true
                            exit repeat
                        end if
                    end repeat
                    if matched then
                        log "AXRaise matched at {x},{y}"
                    else
                        log "AXRaise NO MATCH at {x},{y} (window moved?) - app focus only"
                    end if
                end try
            end tell
            delay 0.15
"#,
            app = app_esc,
            x = x,
            y = y
        ),
        None => format!(
            "tell application \"{}\" to activate\n            delay 0.15\n",
            app_esc
        ),
    }
}

// Get active app without saving (just query) - macOS only
#[cfg(target_os = "macos")]
fn get_frontmost_app() -> Result<String, String> {
    // Shares the transient-"osascript" retry with the full query.
    get_frontmost_app_and_window().map(|(app, _)| app)
}

// Check if an app/window should be excluded from tracking
fn is_our_app(name: &str) -> bool {
    // Exclude windows with empty or very short titles (like our loading window)
    if name.trim().is_empty() || name.trim().len() < 3 {
        return true;
    }
    let lower = name.to_lowercase();
    
    // Browser names - if title contains these, it's a browser showing a website, NOT our app
    let browsers = ["brave", "chrome", "firefox", "edge", "safari", "opera", "vivaldi", "arc"];
    let is_browser = browsers.iter().any(|b| lower.contains(b));
    
    // If it's a browser, DON'T exclude it (even if showing vibetranslate.id website)
    if is_browser {
        return false;
    }
    
    // Exclude our app windows (only EXACT matches, not browser tabs)
    // Settings window: "VibeTranslate"
    if lower == "vibetranslate" || lower == "vibe translate" {
        return true;
    }
    // Our own AppleScript helper: during a copy/paste run the spawned osascript process can
    // momentarily read as the frontmost application process — capturing it as the "target app"
    // then makes every subsequent 'tell application "osascript"' fail (-1728).
    if lower == "osascript" {
        return true;
    }
    // Popup window: "Translation"
    if lower == "translation" {
        return true;
    }
    // Exclude Windows notification windows that can steal focus
    if lower.contains("new notification") || lower == "notification" || lower.contains("toast") {
        return true;
    }
    // Exclude DevTools windows (they steal focus in dev mode)
    if lower.contains("devtools") || lower.contains("developer tools") {
        return true;
    }
    // Exclude Tauri dev windows
    if lower.contains("localhost:") || lower.contains("127.0.0.1:") {
        return true;
    }
    false
}

// Start background tracker that polls frontmost app every 300ms
pub fn start_app_tracker() {
    let mut started = TRACKER_STARTED.lock().unwrap();
    if *started {
        dlog!("[AppTracker] Already started, skipping");
        return;
    }
    *started = true;
    drop(started);
    
    dlog!("[AppTracker] Starting background tracker...");
    
    thread::spawn(|| {
        // ~5 seconds at the 300ms tick below.
        #[cfg(target_os = "macos")]
        const REFRESH_EVERY_TICKS: u32 = 16;
        #[cfg(target_os = "macos")]
        let mut ticks_since_reading: u32 = 0;
        loop {
            // While an operation has pinned the target, don't overwrite it.
            if tracker_is_paused() {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            #[cfg(target_os = "macos")]
            {
                // Cheap check first: the in-process name tells us whether anything changed at
                // all. When it has not — which is almost always, since this loops several times
                // a second while the user works in one window — we skip the AppleScript round
                // trip entirely. That call was the whole cost of this tracker: a fork+exec and
                // ~180ms, twice a second, forever.
                let cheap_name = frontmost_name_fast();

                // Our own window being frontmost is not a change worth chasing: LAST_ACTIVE_APP
                // deliberately holds the last OTHER app, because that is what a paste needs.
                // Without this branch the name could never match the cache and we would pay for
                // the expensive reading on every tick the whole time Settings is open.
                if cheap_name.as_deref().map(is_our_app).unwrap_or(false) {
                    thread::sleep(Duration::from_millis(300));
                    continue;
                }

                let unchanged = match (&cheap_name, LAST_ACTIVE_APP.lock().ok().as_deref()) {
                    (Some(now), Some(Some(prev))) => now == prev,
                    _ => false,
                };
                let have_pos = LAST_ACTIVE_WIN_POS.lock().ok().map(|g| g.is_some()).unwrap_or(false);
                // Moving a window WITHIN one app changes its position without changing the name,
                // and nothing tells us about it. A slow refresh bounds how stale that can get at
                // a few seconds, while still costing a fraction of the old every-tick polling.
                let due_refresh = ticks_since_reading >= REFRESH_EVERY_TICKS;
                if unchanged && have_pos && !due_refresh {
                    ticks_since_reading += 1;
                    thread::sleep(Duration::from_millis(300));
                    continue;
                }
                ticks_since_reading = 0;
                // Something moved, or we have no position yet: pay for the authoritative
                // reading, whose coordinates match what the rest of the code compares against.
                if let Ok((app, pos)) = get_frontmost_app_and_window() {
                    if !is_our_app(&app) {
                        if let Ok(mut guard) = LAST_ACTIVE_APP.lock() {
                            let prev = guard.clone();
                            *guard = Some(app.clone());
                            if prev.as_ref() != Some(&app) {
                                dlog!("[AppTracker] macOS: {} -> {}", prev.unwrap_or_default(), app);
                            }
                        }
                        // Window position too — pastes use it to AXRaise the exact window
                        // (one app can have windows on several monitors).
                        if let Ok(mut g) = LAST_ACTIVE_WIN_POS.lock() {
                            *g = pos;
                        }
                    }
                }
            }
            
            #[cfg(target_os = "windows")]
            {
                // Use proper Windows API to get foreground window and its HWND
                use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
                
                let hwnd = unsafe { GetForegroundWindow() };
                let hwnd_val = hwnd.0 as isize;
                
                if hwnd_val != 0 {
                    // Get window title to check if it's our app
                    if let Ok(app) = get_window_title_windows(hwnd) {
                        if !is_our_app(&app) {
                            // Store HWND
                            if let Ok(mut hwnd_guard) = LAST_ACTIVE_HWND.lock() {
                                let prev_hwnd = *hwnd_guard;
                                if prev_hwnd != hwnd_val {
                                    *hwnd_guard = hwnd_val;
                                    dlog!("[AppTracker] Windows HWND: {} -> {} ('{}')", prev_hwnd, hwnd_val, app);
                                }
                            }
                            // Also store app name
                            if let Ok(mut guard) = LAST_ACTIVE_APP.lock() {
                                *guard = Some(app);
                            }
                        }
                    }
                }
            }
            
            thread::sleep(Duration::from_millis(300));
        }
    });
}



// Get window title from HWND using Windows API
#[cfg(target_os = "windows")]
fn get_window_title_windows(hwnd: windows::Win32::Foundation::HWND) -> Result<String, String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextW, GetWindowTextLengthW};
    
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len == 0 {
            return Ok(String::new());
        }
        
        let mut buffer: Vec<u16> = vec![0; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, &mut buffer);
        if copied == 0 {
            return Ok(String::new());
        }
        
        Ok(String::from_utf16_lossy(&buffer[..copied as usize]))
    }
}

// =============================================================================
// TERMINAL TYPE DETECTION (Windows)
// =============================================================================

/// Represents different terminal types that require different copy/paste strategies.
/// 
/// ## Why Different Strategies?
/// - GUI apps retain text selection when focus shifts
/// - Legacy console (CMD/PowerShell) LOSES selection when focus shifts
/// - Each terminal type has different keyboard shortcuts for copy/paste
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq)]
enum TerminalType {
    /// VS Code integrated terminal.
    /// - Copy: Ctrl+C (standard)
    /// - Selection: PERSISTS after focus loss (VS Code keeps selection state)
    VSCode,
    
    /// Windows Terminal (wt.exe) - the modern terminal.
    /// - Copy: Ctrl+Shift+C
    /// - Paste: Ctrl+Shift+V
    /// - Selection: Usually persists
    WindowsTerminal,
    
    /// Legacy console host (conhost.exe) running CMD or PowerShell.
    /// - Copy: RIGHT-CLICK in QuickEdit mode (selection lost on focus shift)
    /// - Paste: Ctrl+C (clear line) + Ctrl+V
    /// - Selection: DISAPPEARS when focus is lost - this is the core challenge!
    LegacyConsole,
    
    /// Unknown terminal or non-terminal application.
    /// - In terminal mode (Ctrl+Alt+Q): treated as LegacyConsole (Right-Click)
    /// - In normal mode (Ctrl+Alt+T): uses standard Ctrl+C
    Unknown,
}

/// Detects the terminal type based on window handle (HWND).
/// 
/// # Detection Strategy:
/// 1. Get window title and process name from HWND
/// 2. Match against known terminal patterns
/// 3. Return appropriate TerminalType for copy/paste strategy selection
/// 
/// # Arguments
/// * `hwnd` - Windows handle to the target window
/// 
/// # Returns
/// * `TerminalType` - The detected terminal type
#[cfg(target_os = "windows")]
fn detect_terminal_type(hwnd: windows::Win32::Foundation::HWND) -> TerminalType {
    // Step 1: Get window title (lowercased for case-insensitive matching)
    let window_title = get_window_title_windows(hwnd)
        .unwrap_or_default()
        .to_lowercase();
    
    // Step 2: Get process name from HWND
    let process_name = get_process_name_from_hwnd(hwnd);
    
    dlog!("[detect_terminal_type] Title: '{}', Process: '{}'", window_title, process_name);
    
    // --- VS Code Detection ---
    // VS Code terminal retains selection even after focus loss.
    // Check first because VS Code title may contain project paths.
    if process_name.contains("code") 
        || window_title.contains("visual studio code") 
        || window_title.contains("- code") 
    {
        dlog!("[detect_terminal_type] Detected: VSCode");
        return TerminalType::VSCode;
    }
    
    // --- Windows Terminal Detection ---
    // Modern terminal with Ctrl+Shift+C/V support
    if process_name == "windowsterminal.exe" 
        || process_name == "wt.exe" 
        || window_title.contains("windows terminal") 
    {
        dlog!("[detect_terminal_type] Detected: WindowsTerminal");
        return TerminalType::WindowsTerminal;
    }
    
    // --- Legacy Console Detection ---
    // CMD.exe or PowerShell running in conhost (legacy console host).
    // Title often shows full path: "C:\WINDOWS\system32\cmd.exe"
    let is_legacy_console = 
        process_name == "conhost.exe" 
        || process_name == "cmd.exe" 
        || process_name == "powershell.exe"
        || window_title.contains("cmd.exe") 
        || window_title.contains("command prompt") 
        || (window_title.contains("powershell") && !window_title.contains("windows terminal"));
    
    if is_legacy_console {
        dlog!("[detect_terminal_type] Detected: LegacyConsole");
        return TerminalType::LegacyConsole;
    }
    
    // --- Fallback: Generic "terminal" in title ---
    // Assume modern Windows Terminal if just "terminal" appears
    if window_title.contains("terminal") {
        dlog!("[detect_terminal_type] Detected: WindowsTerminal (from title fallback)");
        return TerminalType::WindowsTerminal;
    }
    
    dlog!("[detect_terminal_type] Detected: Unknown");
    TerminalType::Unknown
}

/// Helper function to get process name from HWND.
/// 
/// Uses Windows APIs: GetWindowThreadProcessId → OpenProcess → GetModuleBaseNameW
#[cfg(target_os = "windows")]
fn get_process_name_from_hwnd(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
    
    unsafe {
        // Get process ID from window handle
        let mut process_id: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        
        if process_id == 0 {
            return String::new();
        }
        
        // Open process with limited query access
        let process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id);
        
        match process_handle {
            Ok(handle) => {
                let mut name_buffer: [u16; 260] = [0; 260];
                let name_length = GetModuleBaseNameW(handle, None, &mut name_buffer);
                let _ = windows::Win32::Foundation::CloseHandle(handle);
                
                if name_length > 0 {
                    String::from_utf16_lossy(&name_buffer[..name_length as usize]).to_lowercase()
                } else {
                    String::new()
                }
            }
            Err(_) => String::new()
        }
    }
}

// Get selected text from terminal using Console APIs
// This uses AttachConsole + GetConsoleSelectionInfo + ReadConsoleOutputCharacter
// Must be called BEFORE focus changes to get the selection
#[cfg(target_os = "windows")]
fn get_terminal_selection_from_hwnd(hwnd: windows::Win32::Foundation::HWND) -> Result<String, String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    use windows::Win32::System::Console::{
        AttachConsole, FreeConsole,
        GetStdHandle, STD_OUTPUT_HANDLE,
    };
    use windows::core::PCWSTR;
    
    dlog!("[get_terminal_selection_from_hwnd] === ENTERING FUNCTION ===");
    dlog!("[get_terminal_selection_from_hwnd] HWND: {:?}", hwnd.0);
    
    unsafe {
        // Step 1: Get process ID from HWND
        let mut process_id: u32 = 0;
        dlog!("[get_terminal_selection] Getting process ID from HWND...");
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        
        if process_id == 0 {
            dlog!("[get_terminal_selection] ERROR: Process ID is 0!");
            return Err("Could not get process ID from HWND".to_string());
        }
        
        dlog!("[get_terminal_selection] Process ID: {}", process_id);
        
        // Step 2: Try to attach to the target console
        // In dev mode (cargo run), we already have a console attached
        // FreeConsole would disconnect our stdout and cause hangs
        // So we use a different strategy: spawn a helper or skip in dev mode
        dlog!("[get_terminal_selection] Attempting AttachConsole({})...", process_id);
        
        let attach_result = AttachConsole(process_id);
        if attach_result.is_err() {
            let error_code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            dlog!("[get_terminal_selection] AttachConsole failed, error code: {}", error_code);
            
            // ERROR_ACCESS_DENIED (5) = already have a console (dev mode)
            // ERROR_INVALID_HANDLE (6) = process doesn't have a console
            // ERROR_GEN_FAILURE (31) = device not functioning
            // ERROR_INVALID_PARAMETER (87) = process doesn't exist
            if error_code == 5 {
                // In dev mode, we can't use Console API because FreeConsole
                // would disconnect our stdout. Return error and fallback to Ctrl+C
                dlog!("[get_terminal_selection] App already has console (dev mode) - Console API not available");
                return Err("Console API not available in dev mode (app already has console)".to_string());
            } else if error_code == 6 || error_code == 31 {
                // Target process doesn't have a console (e.g., Windows Terminal uses ConPTY)
                dlog!("[get_terminal_selection] Target process doesn't have a traditional console");
                return Err(format!("Target process has no console (error {})", error_code));
            } else {
                let err_msg = format!("AttachConsole failed with error code {}", error_code);
                dlog!("[get_terminal_selection] {}", err_msg);
                return Err(err_msg);
            }
        }
        
        dlog!("[get_terminal_selection] AttachConsole SUCCESS - attached to PID {}", process_id);
        
        // Step 4: Get console selection info using raw Windows API
        // CONSOLE_SELECTION_INFO struct:
        // DWORD dwFlags
        // COORD dwSelectionAnchor (2x SHORT)
        // SMALL_RECT srSelection (4x SHORT)
        #[repr(C)]
        #[derive(Default)]
        struct CONSOLE_SELECTION_INFO {
            dw_flags: u32,
            dw_selection_anchor_x: i16,
            dw_selection_anchor_y: i16,
            sr_selection_left: i16,
            sr_selection_top: i16,
            sr_selection_right: i16,
            sr_selection_bottom: i16,
        }
        
        // Load kernel32 dynamically to call GetConsoleSelectionInfo
        type GetConsoleSelectionInfoFn = unsafe extern "system" fn(*mut CONSOLE_SELECTION_INFO) -> i32;
        
        let kernel32_name: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
        let kernel32 = windows::Win32::System::LibraryLoader::LoadLibraryW(
            PCWSTR::from_raw(kernel32_name.as_ptr())
        );
        
        if kernel32.is_err() {
            let _ = FreeConsole();
            return Err("Could not load kernel32.dll".to_string());
        }
        
        let kernel32 = kernel32.unwrap();
        
        let proc_name = std::ffi::CString::new("GetConsoleSelectionInfo").unwrap();
        let get_selection_fn = windows::Win32::System::LibraryLoader::GetProcAddress(
            kernel32,
            windows::core::PCSTR::from_raw(proc_name.as_ptr() as *const u8)
        );
        
        if get_selection_fn.is_none() {
            let _ = FreeConsole();
            // Note: Not calling FreeLibrary as it's not available in the features we have
            return Err("GetConsoleSelectionInfo not found".to_string());
        }
        
        let get_console_selection_info: GetConsoleSelectionInfoFn = 
            std::mem::transmute(get_selection_fn.unwrap());
        
        let mut selection_info = CONSOLE_SELECTION_INFO::default();
        let result = get_console_selection_info(&mut selection_info);
        
        if result == 0 {
            let error = std::io::Error::last_os_error();
            let _ = FreeConsole();
            return Err(format!("GetConsoleSelectionInfo failed: {}", error));
        }
        
        dlog!("[get_terminal_selection] Selection flags: 0x{:04X}", selection_info.dw_flags);
        dlog!("[get_terminal_selection] Selection rect: ({},{}) - ({},{})", 
            selection_info.sr_selection_left, selection_info.sr_selection_top,
            selection_info.sr_selection_right, selection_info.sr_selection_bottom);
        
        // Check if there's a selection
        if (selection_info.dw_flags & CONSOLE_SELECTION_NOT_EMPTY) == 0 {
            let _ = FreeConsole();
            return Err("No text selected in terminal".to_string());
        }
        
        // Step 5: Read the selected text using ReadConsoleOutputCharacterW
        let stdout_handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if stdout_handle.is_err() {
            let _ = FreeConsole();
            return Err("Could not get stdout handle".to_string());
        }
        let stdout_handle = stdout_handle.unwrap();
        
        // Calculate selection dimensions
        let left = selection_info.sr_selection_left;
        let top = selection_info.sr_selection_top;
        let right = selection_info.sr_selection_right;
        let bottom = selection_info.sr_selection_bottom;
        let width = (right - left + 1) as usize;
        let height = (bottom - top + 1) as usize;
        
        dlog!("[get_terminal_selection] Reading {}x{} chars starting at ({},{})", 
            width, height, left, top);
        
        // Read each row using ReadConsoleOutputCharacterW
        // COORD is packed as: X in low word, Y in high word
        type ReadConsoleOutputCharacterWFn = unsafe extern "system" fn(
            HANDLE, *mut u16, u32, u32, *mut u32
        ) -> i32;
        
        let proc_name2 = std::ffi::CString::new("ReadConsoleOutputCharacterW").unwrap();
        let read_fn = windows::Win32::System::LibraryLoader::GetProcAddress(
            kernel32,
            windows::core::PCSTR::from_raw(proc_name2.as_ptr() as *const u8)
        );
        
        if read_fn.is_none() {
            let _ = FreeConsole();
            return Err("ReadConsoleOutputCharacterW not found".to_string());
        }
        
        let read_console_output_character_w: ReadConsoleOutputCharacterWFn = 
            std::mem::transmute(read_fn.unwrap());
        
        let mut result_text = String::new();
        
        for row in 0..height {
            let y = top + row as i16;
            // COORD is packed: low word = X, high word = Y
            let coord: u32 = ((y as u16 as u32) << 16) | (left as u16 as u32);
            
            let mut buffer: Vec<u16> = vec![0; width + 1];
            let mut chars_read: u32 = 0;
            
            let success = read_console_output_character_w(
                stdout_handle,
                buffer.as_mut_ptr(),
                width as u32,
                coord,
                &mut chars_read
            );
            
            if success != 0 && chars_read > 0 {
                let line = String::from_utf16_lossy(&buffer[..chars_read as usize]);
                result_text.push_str(line.trim_end());
                if row < height - 1 {
                    result_text.push('\n');
                }
            }
        }
        
        // Cleanup
        let _ = FreeConsole();
        
        let trimmed = result_text.trim().to_string();
        if trimmed.is_empty() {
            return Err("Selection was empty".to_string());
        }
        
        dlog!("[get_terminal_selection] Read {} chars: '{}'", 
            trimmed.len(), 
            if trimmed.len() > 50 { format!("{}...", &trimmed[..50]) } else { trimmed.clone() });
        
        Ok(trimmed)
    }
}

// Try to get terminal selection - wrapper that handles errors gracefully
// Uses the SAVED HWND from background tracker, not current foreground!
#[cfg(target_os = "windows")]
fn try_get_terminal_selection() -> Option<String> {
    use windows::Win32::Foundation::HWND;
    
    // Use the SAVED hwnd from tracker, NOT current foreground
    // This is critical because by the time this function is called,
    // focus may have already shifted to our app
    let hwnd_val = {
        let guard = LAST_ACTIVE_HWND.lock().ok()?;
        *guard
    };
    
    if hwnd_val == 0 {
        dlog!("[try_get_terminal_selection] No saved HWND");
        return None;
    }
    
    let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
    
    // Get window title to check if it's a terminal
    let title = get_window_title_windows(hwnd).unwrap_or_default();
    let lower_title = title.to_lowercase();
    
    dlog!("[try_get_terminal_selection] Saved HWND: {} title: '{}'", hwnd_val, title);
    
    // Only try console APIs for terminal windows
    let is_terminal = lower_title.contains("cmd") 
        || lower_title.contains("powershell")
        || lower_title.contains("windows terminal")
        || lower_title.contains("command prompt")
        || lower_title.contains("administrator:")
        || lower_title.contains("conhost");
    
    if !is_terminal {
        dlog!("[try_get_terminal_selection] Not a terminal window: '{}'", title);
        return None;
    }
    
    dlog!("[try_get_terminal_selection] Detected terminal: '{}'", title);
    
    match get_terminal_selection_from_hwnd(hwnd) {
        Ok(text) => {
            dlog!("[try_get_terminal_selection] SUCCESS! Got: '{}'", 
                if text.len() > 30 { format!("{}...", &text[..30]) } else { text.clone() });
            Some(text)
        }
        Err(e) => {
            dlog!("[try_get_terminal_selection] Failed: {}", e);
            None
        }
    }
}

// Restore focus to saved HWND using Windows API
// Uses AttachThreadInput trick to bypass Windows focus-stealing prevention
#[cfg(target_os = "windows")]
fn restore_foreground_window() -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, IsIconic, ShowWindow, SW_RESTORE,
        GetWindowThreadProcessId, GetForegroundWindow
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    
    let hwnd_val = {
        let guard = LAST_ACTIVE_HWND.lock().map_err(|e| e.to_string())?;
        *guard
    };
    
    if hwnd_val == 0 {
        return Err("No saved HWND".to_string());
    }
    
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        
        // Only restore if window is minimized (IsIconic), NOT if maximized
        if IsIconic(hwnd).as_bool() {
            dlog!("[restore_foreground_window] Window is minimized, restoring...");
            let _ = ShowWindow(hwnd, SW_RESTORE);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        
        // Get current foreground window's thread
        let foreground = GetForegroundWindow();
        let foreground_thread = GetWindowThreadProcessId(foreground, None);
        let current_thread = GetCurrentThreadId();
        let target_thread = GetWindowThreadProcessId(hwnd, None);
        
        dlog!("[restore_foreground_window] Threads: current={}, foreground={}, target={}", 
                 current_thread, foreground_thread, target_thread);
        
        // Attach input threads to allow SetForegroundWindow to work
        // This bypasses Windows focus-stealing prevention
        use windows::Win32::System::Threading::AttachThreadInput;
        
        let mut attached_current = false;
        let mut attached_target = false;
        
        if current_thread != foreground_thread {
            if AttachThreadInput(current_thread, foreground_thread, true).as_bool() {
                attached_current = true;
            }
        }
        if target_thread != foreground_thread && target_thread != current_thread {
            if AttachThreadInput(target_thread, foreground_thread, true).as_bool() {
                attached_target = true;
            }
        }
        
        // Now SetForegroundWindow should work
        let result = SetForegroundWindow(hwnd);
        
        // Detach threads
        if attached_current {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
        if attached_target {
            let _ = AttachThreadInput(target_thread, foreground_thread, false);
        }
        
        if result.as_bool() {
            dlog!("[restore_foreground_window] Success: HWND {}", hwnd_val);
            Ok(())
        } else {
            dlog!("[restore_foreground_window] SetForegroundWindow returned false for HWND {}", hwnd_val);
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
fn get_frontmost_app_windows() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    
    // Simple PowerShell command to get foreground window process name
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile", 
            "-Command",
            "(Get-Process -Id (Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq [System.Diagnostics.Process]::GetCurrentProcess().Id }).ParentProcessId -EA 0).ProcessName; (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object -Property CPU -Descending | Select-Object -First 1).ProcessName"
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    
    match output {
        Ok(out) if out.status.success() => {
            let result = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .last()
                .unwrap_or("")
                .trim()
                .to_string();
            
            if result.is_empty() {
                Err("Empty detection result".to_string())
            } else {
                Ok(result)
            }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(format!("PS error: {}", stderr.chars().take(50).collect::<String>()))
        }
        Err(e) => Err(format!("Failed: {}", e))
    }
}

#[tauri::command]
pub async fn save_active_app() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let app_name = get_frontmost_app()?;
        
        // Only save if it's NOT our app
        if !is_our_app(&app_name) {
            let mut guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
            *guard = Some(app_name.clone());
            Ok(app_name)
        } else {
            // Return previously saved app if available
            let guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
            if let Some(ref prev) = *guard {
                Ok(prev.clone())
            } else {
                Err("No previous app saved".to_string())
            }
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        // On Windows, DON'T query PowerShell (it detects itself)
        // Just return the background-tracked app
        let guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
        if let Some(ref saved) = *guard {
            Ok(saved.clone())
        } else {
            Err("No app tracked yet - please click on another app first".to_string())
        }
    }
}

// Capture foreground HWND immediately - call this at the START of translate
// before any windows are shown or focus changes
#[tauri::command]
pub async fn capture_foreground_hwnd(live: bool) -> Result<String, String> {
    // Pin the target: from here until the paste, the background tracker won't overwrite it, so a
    // Cmd-Tab (or an overlay) mid-operation can't redirect the paste to the wrong app. 60s covers
    // even a slow free-server translation with cross-provider retries; if the paste never comes
    // (op died), the pin self-expires so the tracker can't stay frozen.
    pause_tracker(60);

    #[cfg(target_os = "macos")]
    {
        // live=true (translate): query the LIVE frontmost app so a Cmd-Tab right before the
        // shortcut is respected. live=false (voice): read the ≤300ms tracker cache instead — it's
        // instant, keeping the ~100-150ms osascript round-trip OFF the critical path to opening the
        // mic (voice start latency), and the cache is plenty accurate for a paste target.
        if live {
            if let Ok((app, pos)) = get_frontmost_app_and_window() {
                if !is_our_app(&app) {
                    if let Ok(mut guard) = LAST_ACTIVE_APP.lock() {
                        *guard = Some(app.clone());
                    }
                    if let Ok(mut g) = LAST_ACTIVE_WIN_POS.lock() {
                        *g = pos;
                    }
                    return Ok(app);
                }
            }
        }
        let guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or_else(|| "No app tracked".to_string())
    }
    
    #[cfg(target_os = "windows")]
    {
        let _ = live; // GetForegroundWindow is instant on Windows — always query live
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

        // DEBUG: Get saved values FIRST for comparison
        let saved_hwnd = LAST_ACTIVE_HWND.lock().map(|g| *g).unwrap_or(0);
        let saved_app = LAST_ACTIVE_APP.lock().map(|g| g.clone()).unwrap_or(None);
        
        // Get the CURRENT foreground window RIGHT NOW
        let hwnd = unsafe { GetForegroundWindow() };
        let hwnd_val = hwnd.0 as isize;
        
        // Get window title
        let title = if hwnd_val != 0 {
            get_window_title_windows(hwnd).unwrap_or_default()
        } else {
            String::new()
        };
        
        // DEBUG: Log comprehensive state
        dlog!("[capture_foreground_hwnd] === DEBUG STATE ===");
        dlog!("[capture_foreground_hwnd] Current foreground HWND: {} title: '{}'", hwnd_val, title);
        dlog!("[capture_foreground_hwnd] Saved HWND: {} app: '{}'", saved_hwnd, saved_app.clone().unwrap_or_default());
        dlog!("[capture_foreground_hwnd] is_our_app('{}') = {}", title, is_our_app(&title));
        
        if hwnd_val == 0 {
            dlog!("[capture_foreground_hwnd] ERROR: No foreground window, returning saved: '{}'", saved_app.clone().unwrap_or_default());
            return saved_app.ok_or_else(|| "No foreground window and no saved app".to_string());
        }
        
        // Only save if not our app
        if !is_our_app(&title) {
            // Update HWND
            if let Ok(mut guard) = LAST_ACTIVE_HWND.lock() {
                *guard = hwnd_val;
            }
            // Update app name
            if let Ok(mut guard) = LAST_ACTIVE_APP.lock() {
                *guard = Some(title.clone());
            }
            dlog!("[capture_foreground_hwnd] RESULT: Using CURRENT foreground '{}'", title);
            Ok(title)
        } else {
            // Return existing saved app
            dlog!("[capture_foreground_hwnd] RESULT: Current is our app, returning SAVED '{}'", saved_app.clone().unwrap_or_default());
            saved_app.ok_or_else(|| "No previous app saved".to_string())
        }
    }
}

// Capture foreground HWND AND immediately send Ctrl+C in one atomic operation
// This is critical for terminal mode where focus shifts quickly
// Returns the window title of the captured window
#[tauri::command]
pub async fn capture_and_copy() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // On macOS, capture then copy
        let title = {
            let guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
            guard.clone().unwrap_or_default()
        };
        
        // Send Cmd+C
        let script = r#"
            tell application "System Events"
                keystroke "c" using command down
            end tell
            delay 0.15
        "#;
        
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("Failed to run AppleScript: {}", e))?;
        
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Copy failed: {}", stderr));
        }
        
        Ok(title)
    }
    
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        
        dlog!("[capture_and_copy] === ATOMIC CAPTURE + COPY ===");
        
        // Step 1: Capture HWND immediately
        let hwnd = unsafe { GetForegroundWindow() };
        let hwnd_val = hwnd.0 as isize;
        
        if hwnd_val == 0 {
            return Err("No foreground window".to_string());
        }
        
        let title = get_window_title_windows(hwnd).unwrap_or_default();
        dlog!("[capture_and_copy] Captured: HWND={} title='{}'", hwnd_val, title);
        
        // Save HWND for later restore
        if !is_our_app(&title) {
            if let Ok(mut guard) = LAST_ACTIVE_HWND.lock() {
                *guard = hwnd_val;
            }
            if let Ok(mut guard) = LAST_ACTIVE_APP.lock() {
                *guard = Some(title.clone());
            }
        }
        
        // Step 2: Wait for shortcut keys to be released
        dlog!("[capture_and_copy] Waiting 150ms for shortcut release...");
        std::thread::sleep(std::time::Duration::from_millis(150));
        
        // Step 3: RESTORE focus to captured HWND before sending Ctrl+C
        // This is critical because focus may have shifted during the wait
        dlog!("[capture_and_copy] Restoring focus to captured HWND...");
        match restore_foreground_window() {
            Ok(_) => dlog!("[capture_and_copy] Focus restored OK"),
            Err(e) => dlog!("[capture_and_copy] Focus restore failed: {}", e),
        }
        
        // Small delay for focus to settle
        std::thread::sleep(std::time::Duration::from_millis(50));
        
        // Step 4: Send Ctrl+C to the now-focused window
        dlog!("[capture_and_copy] Sending Ctrl+C...");
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Failed to init keyboard: {}", e))?;
        
        enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(30));
        enigo.key(Key::Unicode('c'), Direction::Press).map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(30));
        enigo.key(Key::Unicode('c'), Direction::Release).map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(30));
        enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
        
        // Wait for clipboard to update
        std::thread::sleep(std::time::Duration::from_millis(100));
        dlog!("[capture_and_copy] Done");
        
        Ok(title)
    }
}

// Get target app - ALWAYS get current frontmost, don't use cached
#[tauri::command]
pub async fn get_target_app() -> Result<String, String> {
    dlog!("[get_target_app] Called");
    
    #[cfg(target_os = "macos")]
    {
        // Always get current frontmost app
        let frontmost = get_frontmost_app()?;
        dlog!("[get_target_app] macOS frontmost: {}", frontmost);
        
        // If frontmost is our app, use the background-tracked app
        if is_our_app(&frontmost) {
            let guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
            if let Some(ref saved) = *guard {
                dlog!("[get_target_app] Using cached (our app is frontmost): {}", saved);
                return Ok(saved.clone());
            }
            return Err("No target app - please click on another app first".to_string());
        }
        
        // Save and return current frontmost
        let mut guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
        *guard = Some(frontmost.clone());
        dlog!("[get_target_app] Returning frontmost: {}", frontmost);
        Ok(frontmost)
    }
    
    #[cfg(target_os = "windows")]
    {
        // On Windows, ALWAYS use background-tracked app
        // Because querying foreground window via PowerShell is unreliable
        // (PowerShell itself or our loading window might be detected)
        let guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
        let cached = guard.clone();
        dlog!("[get_target_app] Windows cached LAST_ACTIVE_APP: {:?}", cached);
        
        if let Some(ref saved) = *guard {
            dlog!("[get_target_app] Returning cached app: '{}'", saved);
            return Ok(saved.clone());
        }
        
        // Fallback: try to get current (might be inaccurate)
        drop(guard);
        dlog!("[get_target_app] No cached app, trying fallback detection...");
        let frontmost = get_frontmost_app_windows()?;
        dlog!("[get_target_app] Fallback detected: '{}'", frontmost);
        
        // Only skip our own app - let terminals through so isTerminalApp() can detect them
        if !is_our_app(&frontmost) {
            let mut guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
            *guard = Some(frontmost.clone());
            dlog!("[get_target_app] Fallback stored and returning: '{}'", frontmost);
            return Ok(frontmost);
        }
        
        dlog!("[get_target_app] Fallback rejected (is our app)");
        Err("Could not detect foreground app".to_string())
    }
}

// Terminal replace: Paste translated text, using appropriate shortcut for each terminal type
// =============================================================================
// TERMINAL REPLACE/PASTE COMMAND
// =============================================================================

/// Simulates paste operation in terminal windows using smart detection.
/// 
/// # Strategy by Terminal Type:
/// - **VS Code**: Standard Ctrl+V
/// - **Windows Terminal**: Ctrl+Shift+V (avoids bracket paste mode issues)
/// - **Legacy Console**: Ctrl+C (clear line) + Ctrl+V (paste)
/// 
/// # Why Ctrl+C + Ctrl+V for Legacy Console?
/// After Right-Click copy, the original text selection is cleared from the terminal.
/// We need to clear the input line first (Ctrl+C = SIGINT = new prompt),
/// then paste the translated text.
#[tauri::command]
pub async fn simulate_terminal_replace(clear_chars: Option<usize>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        // Activate the SAVED target terminal first — without this, the Ctrl+C + Cmd+V lands on
        // whatever is frontmost (e.g. our own settings window while the user watches the console).
        let app_name = LAST_ACTIVE_APP.lock().ok().and_then(|g| g.clone());
        resume_tracker(); // pinned target consumed — let the tracker resume
        let activate = match app_name {
            // Window-precise: raise the exact captured window, not just the app.
            Some(ref app) if !app.trim().is_empty() => activate_target_prelude(app.trim()),
            _ => String::new(),
        };
        // Right-arrow FIRST to drop any active terminal selection (some terminals swallow the
        // next key while a selection is active). Then Ctrl+U — the readline/zle "kill line"
        // that clears the input in every shell (bash/zsh/fish) AND TUI prompts (Claude Code,
        // REPLs) — then paste. NEVER Ctrl+C here: that is SIGINT, and with a task running in
        // the prompt (Claude Code mid-run, a foreground process) it KILLS the task instead of
        // clearing the line.
        // Binding-independent mop-up: Ctrl+U depends on the prompt's keymap (Claude Code
        // mid-task and some AI TUIs ignore it -> the paste DUPLICATED after the old text).
        // Backspace is honored by every input, and on an already-cleared line it's a no-op —
        // so after Ctrl+U we backspace exactly the original text's length (capped) and the
        // line is clean either way.
        let n = clear_chars.unwrap_or(0).min(500);
        let mop_up = if n > 0 {
            format!(
                "repeat {} times\n                    key code 51\n                end repeat\n                delay 0.05\n                ",
                n
            )
        } else {
            String::new()
        };
        let script = format!(
            r#"
            {}tell application "System Events"
                key code 124
                delay 0.05
                keystroke "u" using control down
                delay 0.08
                {}keystroke "v" using command down
            end tell
        "#,
            activate, mop_up
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to run AppleScript: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("not allowed") || stderr.contains("assistive") {
                return Err("Accessibility permission required".to_string());
            }
            return Err(format!("Terminal replace failed: {}", stderr));
        }

        Ok(())
    }
    
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        
        dlog!("[terminal_replace] === START ===");
        
        // --- Step 1: Detect terminal type ---
        let hwnd_val = {
            let guard = LAST_ACTIVE_HWND.lock().map_err(|e| e.to_string())?;
            *guard
        };
        
        let terminal_type = if hwnd_val != 0 {
            let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
            detect_terminal_type(hwnd)
        } else {
            TerminalType::Unknown
        };
        
        dlog!("[terminal_replace] Type: {:?}", terminal_type);
        
        // --- Step 2: Wait for shortcut keys to release ---
        std::thread::sleep(std::time::Duration::from_millis(150));
        
        // --- Step 3: Restore focus to terminal ---
        dlog!("[terminal_replace] Restoring focus...");
        match restore_foreground_window() {
            Ok(_) => dlog!("[terminal_replace] Focus OK"),
            Err(e) => dlog!("[terminal_replace] Focus failed: {}", e),
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        
        // --- Step 4: Execute paste based on terminal type ---
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Failed to init keyboard: {}", e))?;
        
        match terminal_type {
            TerminalType::VSCode => {
                // VS Code: Standard Ctrl+V
                dlog!("[terminal_replace] VSCode: Ctrl+V");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('v'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('v'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
            
            TerminalType::WindowsTerminal => {
                // Windows Terminal: Ctrl+Shift+V (avoids bracket paste mode)
                dlog!("[terminal_replace] WindowsTerminal: Ctrl+Shift+V");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                enigo.key(Key::Shift, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('v'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('v'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Shift, Direction::Release).map_err(|e| e.to_string())?;
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
            
            TerminalType::LegacyConsole | TerminalType::Unknown => {
                // Legacy Console / Unknown: Two-step paste
                // Step 1: Ctrl+C = SIGINT → clears current line, shows new prompt
                // Step 2: Ctrl+V = paste translated text
                dlog!("[terminal_replace] Legacy/Unknown: Ctrl+C + Ctrl+V");
                
                // Ctrl+C to clear line (sends SIGINT)
                dlog!("[terminal_replace] Sending Ctrl+C...");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(50));
                enigo.key(Key::Unicode('c'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(50));
                enigo.key(Key::Unicode('c'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(50));
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
                
                // Wait for terminal to process SIGINT
                std::thread::sleep(std::time::Duration::from_millis(200));
                
                // Ctrl+V to paste
                dlog!("[terminal_replace] Sending Ctrl+V...");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(50));
                enigo.key(Key::Unicode('v'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(50));
                enigo.key(Key::Unicode('v'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(50));
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
        }
        
        dlog!("[terminal_replace] === DONE ===");
        Ok(())
    }
}

#[tauri::command]
pub async fn simulate_copy() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // The trigger shortcut's own modifiers (Option/Cmd/Shift) must be UP before the
        // synthetic Cmd+C, or the app receives Cmd+Opt+C etc. and copies nothing.
        wait_modifiers_released(800);
        let app_name = {
            let guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
            guard.clone()
        };
        
        // Try using Edit > Copy menu click instead of keystroke
        // This might work better with browsers that block synthetic keystrokes
        let target = app_name.clone().unwrap_or_default();
        
        if target.is_empty() {
            return Err("No target app saved".to_string());
        }
        
        // Strategy: keystroke Cmd+C FIRST — it is exactly what a human press does, and it is
        // the path that provably works everywhere (incl. Chrome's PDF viewer, where the Edit
        // menu's Copy command reports success but never reaches the plugin's selection). The
        // menu click is only a fallback for apps that swallow synthetic keystrokes.
        // wait_modifiers_released() above already guaranteed the shortcut's own modifiers are
        // up, so the keystroke arrives as a CLEAN Cmd+C.
        let esc = escape_applescript(&target);
        // If the target is already frontmost, send a bare Cmd+C — no activate. A redundant
        // activate is not a no-op (with a Quick Look panel it shifts the key window off the
        // panel), and skipping it is faster. If the target is NOT frontmost, something stole
        // focus between the shortcut and now — re-raise the EXACT captured window by its
        // position (AXRaise), never a plain `activate`: multi-window apps raise their
        // last-focused window, which can sit on another monitor and holds no selection.
        let (front, front_pos) = get_frontmost_app_and_window().unwrap_or_default();
        let stored_pos = LAST_ACTIVE_WIN_POS.lock().ok().and_then(|g| *g);
        // An app-level match is not enough: after a popup interaction the right APP can be
        // frontmost with the WRONG window key (another Brave window on another monitor) — a
        // bare Cmd+C then copies nothing. Compare the front window's position against the
        // captured one too; on mismatch, AXRaise the captured window first. A stubborn
        // "osascript" reading is our own helper racing the query — the capture an instant ago
        // verified the target, so treat it as a match (AXRaising on that noise would e.g.
        // yank focus off a Quick Look panel).
        let win_matches = match (front_pos, stored_pos) {
            (Some(a), Some(b)) => a == b,
            _ => true, // position unknown on either side -> trust the app-level match
        };
        dlog!(
            "[CopyDebug] frontmost at copy = '{}' win={:?} (target '{}' win={:?})",
            front, front_pos, target, stored_pos
        );
        let keystroke = if (front == target && win_matches) || front == "osascript" {
            r#"
            tell application "System Events"
                key code 8 using command down
            end tell
        "#
            .to_string()
        } else {
            format!(
                r#"
            {prelude}
            tell application "System Events"
                key code 8 using command down
            end tell
        "#,
                prelude = activate_target_prelude(&target)
            )
        };

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&keystroke)
            .output()
            .map_err(|e| format!("AppleScript failed: {}", e))?;

        let copy_stderr = String::from_utf8_lossy(&output.stderr);
        if !copy_stderr.trim().is_empty() {
            dlog!("[CopyDebug] {}", copy_stderr.trim());
        }
        if !output.status.success() {
            dlog!("[simulate_copy] Keystroke FAILED, falling back to Edit > Copy menu click");
            if copy_stderr.contains("not allowed") || copy_stderr.contains("assistive") {
                return Err("Accessibility permission required".to_string());
            }

            let menu_click = format!(r#"
                tell application "{}"
                    activate
                end tell
                delay 0.15
                tell application "System Events"
                    tell process "{}"
                        click menu item "Copy" of menu "Edit" of menu bar 1
                    end tell
                end tell
            "#, esc, esc);

            let output2 = Command::new("osascript")
                .arg("-e")
                .arg(&menu_click)
                .output()
                .map_err(|e| format!("Fallback failed: {}", e))?;

            if !output2.status.success() {
                let stderr2 = String::from_utf8_lossy(&output2.stderr);
                if stderr2.contains("not allowed") || stderr2.contains("assistive") {
                    return Err("Accessibility permission required".to_string());
                }
                return Err(format!("Copy failed: {}", stderr2));
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(150));
        Ok(())
    }
    
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use enigo::{Direction, Enigo, Key, Keyboard, Settings, Mouse, Button};
        
        dlog!("[simulate_copy] Windows: Starting with HWND restore...");
        
        // Get saved HWND to detect terminal type
        let hwnd_val = {
            let guard = LAST_ACTIVE_HWND.lock().map_err(|e| e.to_string())?;
            *guard
        };
        
        // Detect if target is a terminal
        let terminal_type = if hwnd_val != 0 {
            let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
            detect_terminal_type(hwnd)
        } else {
            TerminalType::Unknown
        };
        
        let is_terminal = matches!(terminal_type, TerminalType::VSCode | TerminalType::WindowsTerminal | TerminalType::LegacyConsole);
        dlog!("[simulate_copy] Terminal type: {:?}, is_terminal: {}", terminal_type, is_terminal);
        
        // IMPORTANT: Wait for user to fully release the shortcut keys (Ctrl+Alt+T/P)
        // Increased from 150ms to 250ms for apps like Telegram that need more time
        dlog!("[simulate_copy] Waiting 250ms for shortcut key release...");
        std::thread::sleep(std::time::Duration::from_millis(250));
        
        // Restore focus to the previously active window using saved HWND
        // This is critical for terminal/other apps that might lose focus
        dlog!("[simulate_copy] Restoring foreground window...");
        match restore_foreground_window() {
            Ok(_) => dlog!("[simulate_copy] Foreground window restored"),
            Err(e) => dlog!("[simulate_copy] Could not restore foreground ({}), proceeding anyway", e),
        }
        
        // Wait for focus to settle
        std::thread::sleep(std::time::Duration::from_millis(100));
        
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Failed to init keyboard: {}", e))?;
        
        // IMPORTANT: Release all modifier keys first to avoid conflicts with shortcut keys
        // This ensures Ctrl, Alt, Shift are not "stuck" from the global shortcut
        dlog!("[simulate_copy] Releasing all modifier keys first...");
        let _ = enigo.key(Key::Control, Direction::Release);
        let _ = enigo.key(Key::Alt, Direction::Release);
        let _ = enigo.key(Key::Shift, Direction::Release);
        std::thread::sleep(std::time::Duration::from_millis(50));
        
        // Use different copy method based on terminal type
        // IMPORTANT: Ctrl+C in terminal = SIGINT (cancel), so we need Ctrl+Shift+C
        match terminal_type {
            TerminalType::VSCode => {
                // VS Code terminal uses Ctrl+C for copy (not SIGINT) and retains selection
                dlog!("[simulate_copy] VS Code detected: Using Ctrl+C...");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
            TerminalType::WindowsTerminal => {
                // Windows Terminal supports Ctrl+Shift+C for copy (avoids SIGINT)
                dlog!("[simulate_copy] Windows Terminal: Using Ctrl+Shift+C...");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                enigo.key(Key::Shift, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Shift, Direction::Release).map_err(|e| e.to_string())?;
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
            TerminalType::LegacyConsole => {
                // Legacy console - use RIGHT-CLICK to copy in QuickEdit mode
                dlog!("[simulate_copy] Legacy Console: Using Right-Click (QuickEdit copy)...");
                
                // Move mouse to terminal window first
                if hwnd_val != 0 {
                    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
                    use windows::Win32::Foundation::RECT;
                    
                    let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
                    let mut rect = RECT::default();
                    let got_rect = unsafe { GetWindowRect(hwnd, &mut rect) };
                    
                    if got_rect.is_ok() {
                        let center_x = (rect.left + rect.right) / 2;
                        let center_y = (rect.top + rect.bottom) / 2;
                        dlog!("[simulate_copy] Moving mouse to window center: ({}, {})", center_x, center_y);
                        
                        use enigo::Coordinate;
                        enigo.move_mouse(center_x, center_y, Coordinate::Abs).map_err(|e| e.to_string())?;
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                }
                
                enigo.button(Button::Right, Direction::Click).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            TerminalType::Unknown => {
                // Normal apps (not terminal) - use standard Ctrl+C
                dlog!("[simulate_copy] Normal app: Using Ctrl+C...");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
        }
        
        // Wait for clipboard to update
        std::thread::sleep(std::time::Duration::from_millis(100));
        dlog!("[simulate_copy] Done");
        Ok(())
    }
}

// Direct copy - sends Ctrl+C to currently focused window WITHOUT restoring foreground
// Use this for terminal mode where the user already has terminal focused
#[tauri::command]
pub async fn simulate_copy_direct() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // On macOS, just send Cmd+C to current app
        let script = r#"
            tell application "System Events"
                keystroke "c" using command down
            end tell
            delay 0.15
        "#;
        
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("Failed to run AppleScript: {}", e))?;
        
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Copy failed: {}", stderr));
        }
        
        std::thread::sleep(std::time::Duration::from_millis(200));
        Ok(())
    }
    
    #[cfg(target_os = "windows")]
    {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        
        // For terminal mode: DON'T do any focus management!
        // The terminal should already be focused when user presses shortcut.
        // Any SetForegroundWindow call might actually BREAK things by switching to wrong window.
        
        dlog!("[simulate_copy_direct] Windows: Pure direct mode (NO focus management)...");
        
        // Wait for user to release shortcut keys - this is critical
        // User is holding Ctrl+Alt+Shift+T, we need them to release before we send Ctrl+C
        dlog!("[simulate_copy_direct] Waiting 200ms for shortcut key release...");
        std::thread::sleep(std::time::Duration::from_millis(200));
        
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Failed to init keyboard: {}", e))?;
        
        // Send Ctrl+C directly to whatever has keyboard focus (should be terminal)
        dlog!("[simulate_copy_direct] Sending Ctrl+C to focused window...");
        enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(50));
        enigo.key(Key::Unicode('c'), Direction::Press).map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(50));
        enigo.key(Key::Unicode('c'), Direction::Release).map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(50));
        enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
        
        // Wait longer for clipboard to update (terminal might be slower)
        std::thread::sleep(std::time::Duration::from_millis(150));
        dlog!("[simulate_copy_direct] Done");
        Ok(())
    }
}

// Terminal copy: Smart detection of terminal type and use appropriate copy method
// - VS Code terminal: Ctrl+C (retains selection, uses Ctrl+C for copy)
// =============================================================================
// TERMINAL COPY COMMAND (Triggered by Ctrl+Alt+Q)
// =============================================================================

/// Simulates copy operation in terminal windows using smart detection.
/// 
/// # Strategy by Terminal Type:
/// - **VS Code**: Standard Ctrl+C (selection persists)
/// - **Windows Terminal**: Ctrl+Shift+C (modern shortcut)
/// - **Legacy Console**: RIGHT-CLICK in QuickEdit mode (selection lost workaround)
/// - **Unknown**: Treated as Legacy (Right-Click) since most CLI tools use conhost
/// 
/// # Why Right-Click for Legacy Console?
/// Legacy console (CMD/PowerShell) loses text selection when window loses focus.
/// When user presses Ctrl+Alt+Q, our app receives focus → selection gone!
/// Right-Click in QuickEdit mode copies selection even after focus returns.
/// 
/// # Mouse Position Management
/// Right-Click occurs at current mouse position, so we move cursor to window
/// center before clicking to ensure it hits the terminal window.
#[tauri::command]
pub async fn simulate_terminal_copy() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let script = r#"
            tell application "System Events"
                keystroke "c" using command down
            end tell
            delay 0.15
        "#;
        
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("Failed to run AppleScript: {}", e))?;
        
        if !output.status.success() {
            return Err("Terminal copy failed".to_string());
        }
        Ok(())
    }
    
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use enigo::{Direction, Enigo, Key, Keyboard, Settings, Mouse, Button};
        
        dlog!("[terminal_copy] === START ===");
        
        // --- Step 1: Get saved window handle ---
        let hwnd_val = {
            let guard = LAST_ACTIVE_HWND.lock().map_err(|e| e.to_string())?;
            *guard
        };
        
        if hwnd_val == 0 {
            return Err("No saved HWND for terminal".to_string());
        }
        
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        
        // --- Step 2: Detect terminal type ---
        let terminal_type = detect_terminal_type(hwnd);
        dlog!("[terminal_copy] Type: {:?}", terminal_type);
        
        // --- Step 3: Wait for shortcut keys to release ---
        // User pressed Ctrl+Alt+Q, we need keys to be released before sending new ones
        dlog!("[terminal_copy] Waiting for key release...");
        std::thread::sleep(std::time::Duration::from_millis(150));
        
        // --- Step 4: Restore focus to terminal ---
        dlog!("[terminal_copy] Restoring focus...");
        match restore_foreground_window() {
            Ok(_) => dlog!("[terminal_copy] Focus OK"),
            Err(e) => dlog!("[terminal_copy] Focus failed: {}", e),
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        
        // --- Step 5: Execute copy based on terminal type ---
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Failed to init keyboard: {}", e))?;
        
        match terminal_type {
            TerminalType::VSCode => {
                // VS Code: Standard Ctrl+C (selection persists after focus change)
                dlog!("[terminal_copy] VSCode: Ctrl+C");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
            
            TerminalType::WindowsTerminal => {
                // Windows Terminal: Ctrl+Shift+C (modern terminal shortcut)
                dlog!("[terminal_copy] WindowsTerminal: Ctrl+Shift+C");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                enigo.key(Key::Shift, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('c'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Shift, Direction::Release).map_err(|e| e.to_string())?;
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
            
            TerminalType::LegacyConsole | TerminalType::Unknown => {
                // Legacy Console / Unknown: RIGHT-CLICK in QuickEdit mode
                // This is the BREAKTHROUGH solution for CMD/PowerShell selection problem!
                // QuickEdit mode (default ON): Right-Click with selection = copy to clipboard
                dlog!("[terminal_copy] Legacy/Unknown: Right-Click copy");
                
                // Move mouse to window center first (Right-Click hits mouse position)
                use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
                use windows::Win32::Foundation::RECT;
                
                let mut rect = RECT::default();
                if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
                    let center_x = (rect.left + rect.right) / 2;
                    let center_y = (rect.top + rect.bottom) / 2;
                    dlog!("[terminal_copy] Mouse → ({}, {})", center_x, center_y);
                    
                    use enigo::Coordinate;
                    enigo.move_mouse(center_x, center_y, Coordinate::Abs).map_err(|e| e.to_string())?;
                    std::thread::sleep(std::time::Duration::from_millis(50));
                } else {
                    dlog!("[terminal_copy] WARN: Could not get window rect");
                }
                
                // Right-Click to copy
                enigo.button(Button::Right, Direction::Click).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
        
        // --- Step 6: Wait for clipboard update ---
        std::thread::sleep(std::time::Duration::from_millis(100));
        dlog!("[terminal_copy] === DONE ===");
        Ok(())
    }
}

// Paste into a SPECIFIC app captured earlier (e.g. the window focused when the
// voice shortcut was first pressed), bypassing the live foreground tracker so
// the result always lands where the user started.
#[tauri::command]
pub async fn simulate_paste_to_app(app: String, win_x: Option<i32>, win_y: Option<i32>) -> Result<(), String> {
    resume_tracker(); // uses the explicit target, so the pin (from capture) can lift now
    #[cfg(target_os = "macos")]
    {
        let trimmed = app.trim();
        let script = if trimmed.is_empty() {
            r#"tell application "System Events" to keystroke "v" using command down"#.to_string()
        } else {
            // Window-precise: raise the exact window captured at OPERATION START. The caller
            // passes the position snapshotted then — the global slot may have been clobbered
            // by another operation while a long voice recording was in flight.
            let pos = match (win_x, win_y) {
                (Some(x), Some(y)) => Some((x, y)),
                _ => LAST_ACTIVE_WIN_POS.lock().ok().and_then(|g| *g),
            };
            format!("{}tell application \"System Events\" to keystroke \"v\" using command down",
                activate_target_prelude_at(trimmed, pos))
        };

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to run AppleScript: {}", e))?;

        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            dlog!("[PasteDebug:voice] {}", stderr.trim());
        }
        if !output.status.success() {
            if stderr.contains("not allowed") || stderr.contains("assistive") {
                return Err("Accessibility permission required".to_string());
            }
            return Err(format!("Paste failed: {}", stderr));
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app; // Windows uses HWND-based restore in simulate_paste
        simulate_paste().await
    }
}

// Return focus to the app the user was in — WITHOUT pasting. Used on voice cancel/error/no-speech:
// the app was activated to the foreground to un-mute the mic (WebKit mutes getUserMedia for a
// background app), and on those paths nothing pastes, so VibeTranslate would otherwise stay in
// front. If the target app is unknown, hide ourselves so focus returns to whatever was behind us.
#[tauri::command]
pub async fn restore_focus_to_app(app: String) -> Result<(), String> {
    resume_tracker(); // voice cancel/error: lift the pin the capture set
    #[cfg(target_os = "macos")]
    {
        let trimmed = app.trim();
        // Empty target = voice was triggered while VibeTranslate itself was frontmost (there's
        // nowhere else to return to), so do NOTHING. Do NOT hide the app — `NSApp hide:` wedges it
        // in a hidden state where the overlay/settings won't re-show and voice stops working.
        if !trimmed.is_empty() {
            let script = format!(r#"tell application "{}" to activate"#, escape_applescript(trimmed));
            let _ = Command::new("osascript").arg("-e").arg(&script).output();
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app; // Windows restores the saved target window by HWND, not by name
        restore_foreground_window()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub async fn simulate_paste() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_name = {
            let guard = LAST_ACTIVE_APP.lock().map_err(|e| e.to_string())?;
            guard.clone()
        };
        // The pinned target has been read for pasting — let the tracker resume.
        resume_tracker();

        let script = if let Some(app) = app_name {
            // Focus the EXACT captured window (AXRaise by position), then Cmd+V. App-level
            // activate alone lets macOS pick any window of the app — wrong one on multi-monitor.
            format!("{}tell application \"System Events\" to keystroke \"v\" using command down",
                activate_target_prelude(&app))
        } else {
            // Just send Cmd+V to current app
            r#"
                tell application "System Events"
                    keystroke "v" using command down
                end tell
            "#.to_string()
        };
        
        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to run AppleScript: {}", e))?;
        
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            dlog!("[PasteDebug] {}", stderr.trim());
        }
        if !output.status.success() {
            if stderr.contains("not allowed") || stderr.contains("assistive") {
                return Err("Accessibility permission required".to_string());
            }
            return Err(format!("Paste failed: {}", stderr));
        }

        Ok(())
    }
    
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        
        dlog!("[simulate_paste] Windows: Starting with HWND restore...");
        
        // Get saved HWND to detect terminal type
        let hwnd_val = {
            let guard = LAST_ACTIVE_HWND.lock().map_err(|e| e.to_string())?;
            *guard
        };
        // The pinned target has been read for pasting — let the tracker resume.
        resume_tracker();

        let terminal_type = if hwnd_val != 0 {
            let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
            detect_terminal_type(hwnd)
        } else {
            TerminalType::Unknown
        };
        
        dlog!("[simulate_paste] Terminal type: {:?}", terminal_type);
        
        // Restore focus to the previously active window
        dlog!("[simulate_paste] Restoring foreground window...");
        match restore_foreground_window() {
            Ok(_) => dlog!("[simulate_paste] Foreground window restored"),
            Err(e) => dlog!("[simulate_paste] Could not restore foreground ({}), proceeding anyway", e),
        }
        
        // Wait for focus to settle
        std::thread::sleep(std::time::Duration::from_millis(100));
        
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Failed to init keyboard: {}", e))?;
        
        // IMPORTANT: Release all modifier keys first to avoid conflicts
        dlog!("[simulate_paste] Releasing all modifier keys first...");
        let _ = enigo.key(Key::Control, Direction::Release);
        let _ = enigo.key(Key::Alt, Direction::Release);
        let _ = enigo.key(Key::Shift, Direction::Release);
        std::thread::sleep(std::time::Duration::from_millis(50));
        
        // Use different paste method based on terminal type
        match terminal_type {
            TerminalType::WindowsTerminal => {
                // Windows Terminal uses Ctrl+Shift+V for paste
                dlog!("[simulate_paste] Windows Terminal: Using Ctrl+Shift+V...");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                enigo.key(Key::Shift, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('v'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('v'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Shift, Direction::Release).map_err(|e| e.to_string())?;
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
            _ => {
                // VS Code, Legacy console, and normal apps use Ctrl+V
                dlog!("[simulate_paste] Using standard Ctrl+V...");
                enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('v'), Direction::Press).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Unicode('v'), Direction::Release).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
            }
        }
        
        dlog!("[simulate_paste] Done");
        Ok(())
    }
}

// Get terminal selection using Console APIs (AttachConsole + GetConsoleSelectionInfo)
// This must be called IMMEDIATELY when shortcut is pressed, before any focus change
// Returns the selected text if successful, or error message
#[tauri::command]
pub async fn get_terminal_selection() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // macOS doesn't use Console APIs
        Err("Terminal selection API not available on macOS".to_string())
    }
    
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        
        dlog!("[get_terminal_selection] === ATTEMPTING CONSOLE API SELECTION ===");
        
        // Get saved HWND info for debugging
        let hwnd_val = {
            match LAST_ACTIVE_HWND.lock() {
                Ok(guard) => *guard,
                Err(_) => 0,
            }
        };
        dlog!("[get_terminal_selection] Saved HWND: {}", hwnd_val);
        
        if hwnd_val != 0 {
            let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
            let title = get_window_title_windows(hwnd).unwrap_or_default();
            dlog!("[get_terminal_selection] Window title: '{}'", title);
        }
        
        match try_get_terminal_selection() {
            Some(text) => {
                dlog!("[get_terminal_selection] SUCCESS via Console API: {} chars", text.len());
                Ok(text)
            }
            None => {
                dlog!("[get_terminal_selection] FAILED - returning error");
                Err("Could not get terminal selection via Console API".to_string())
            }
        }
    }
}

// Debug command to get detailed terminal info - returns to TypeScript for logging
#[tauri::command]
pub async fn debug_terminal_info() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
        
        let mut info = String::new();
        info.push_str("=== DEBUG TERMINAL INFO ===\n");
        
        // Get saved HWND
        let saved_hwnd = {
            let guard = LAST_ACTIVE_HWND.lock().map_err(|e| e.to_string())?;
            *guard
        };
        info.push_str(&format!("Saved HWND: {}\n", saved_hwnd));
        
        // Get current foreground
        let current_hwnd = unsafe { GetForegroundWindow() };
        info.push_str(&format!("Current foreground HWND: {:?}\n", current_hwnd.0));
        
        // Get saved HWND info
        if saved_hwnd != 0 {
            let hwnd = HWND(saved_hwnd as *mut std::ffi::c_void);
            let title = get_window_title_windows(hwnd).unwrap_or_default();
            info.push_str(&format!("Saved window title: '{}'\n", title));
            
            // Get process name
            let process_name: String = unsafe {
                let mut process_id: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut process_id));
                
                if process_id == 0 {
                    "unknown".to_string()
                } else {
                    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id);
                    if let Ok(h) = handle {
                        let mut buffer: [u16; 260] = [0; 260];
                        let len = GetModuleBaseNameW(h, None, &mut buffer);
                        let _ = windows::Win32::Foundation::CloseHandle(h);
                        if len > 0 {
                            String::from_utf16_lossy(&buffer[..len as usize])
                        } else {
                            "unknown".to_string()
                        }
                    } else {
                        "unknown".to_string()
                    }
                }
            };
            info.push_str(&format!("Process name: '{}'\n", process_name));
            
            // Detect terminal type
            let terminal_type = detect_terminal_type(hwnd);
            info.push_str(&format!("Terminal type: {:?}\n", terminal_type));
            
            // Check what copy method will be used
            let copy_method = match terminal_type {
                TerminalType::VSCode => "Ctrl+C",
                TerminalType::WindowsTerminal => "Ctrl+Shift+C",
                TerminalType::LegacyConsole | TerminalType::Unknown => "Right-Click (QuickEdit mode)",
            };
            info.push_str(&format!("Copy method: {}\n", copy_method));
            
            // Check what paste method will be used
            let paste_method = match terminal_type {
                TerminalType::VSCode => "Ctrl+V",
                TerminalType::WindowsTerminal => "Ctrl+Shift+V",
                TerminalType::LegacyConsole | TerminalType::Unknown => "Ctrl+C (clear) + Ctrl+V (paste)",
            };
            info.push_str(&format!("Paste method: {}\n", paste_method));
        } else {
            info.push_str("No saved HWND - cannot detect terminal type\n");
        }
        
        info.push_str("=== END DEBUG ===");
        Ok(info)
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Ok("Debug terminal info only available on Windows".to_string())
    }
}
