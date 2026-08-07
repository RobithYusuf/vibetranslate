// Global mouse-button hook (macOS + Windows).
//
// The webview only sees mouse events while ITS OWN window is focused — useless for a
// "press a mouse button while working in another app → translate" workflow. This installs a
// system-wide hook over ALL mouse buttons and turns bound presses into `global-mouse-button`
// events, swallowing them so the app underneath doesn't also act (e.g. a browser navigating back).
//
// Two kinds of mouse shortcut:
//   1. (keyboard-modifiers) + extra button      — e.g. "⌥+Back". Held modifiers come from the
//      keyboard; the extra button is the trigger.
//   2. hold an extra button + click             — e.g. "hold Back, left-click". The held extra
//      button acts like a modifier (fully swallowed, so it no longer navigates), and a following
//      left/right/other click is the trigger (also swallowed, so no context menu / stray click).
//
// Encoding (shared with utils/mouseShortcut.ts):
//   bits 0-7   = trigger button (DOM: left 0, middle 1, right 2, back 3, forward 4, side 5…)
//   bit 8      = Cmd/Ctrl primary   bit 9 = Shift   bit 10 = Alt   bit 11 = Control (mac secondary)
//   bit 12     = Super (Windows key)
//   bits 16-23 = HOLD extra button (0 = none; the mouse button held as a modifier for kind #2)
//
//   - macOS:  a raw CGEventTap (the core-graphics safe wrapper can't delete an event, only listen).
//             Needs Accessibility permission — the SAME one the app uses to simulate copy/paste.
//   - Windows: a WH_MOUSE_LL low-level mouse hook. No special permission required.

// ===================== shared state + commands (macOS + Windows) =====================

#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::sync::{Mutex, OnceLock};

#[cfg(any(target_os = "macos", target_os = "windows"))]
static TAP_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(any(target_os = "macos", target_os = "windows"))]
static STARTED: AtomicBool = AtomicBool::new(false);
// Encoded keys currently bound to a feature — the ONLY presses the hook swallows + forwards.
#[cfg(any(target_os = "macos", target_os = "windows"))]
static BOUND: Mutex<Vec<u32>> = Mutex::new(Vec::new());
// Bitmask of extra buttons used as a HOLD modifier by some bound chord (bit N ⇒ button N).
#[cfg(any(target_os = "macos", target_os = "windows"))]
static HOLD_MASK: AtomicU32 = AtomicU32::new(0);
// The extra button currently held as a modifier (0 = none). Touched only by the hook thread.
#[cfg(any(target_os = "macos", target_os = "windows"))]
static CURRENT_HOLD: AtomicU32 = AtomicU32::new(0);
// Bitmask of buttons whose DOWN we swallowed, so we also swallow the matching UP.
#[cfg(any(target_os = "macos", target_os = "windows"))]
static SWALLOWED: AtomicU32 = AtomicU32::new(0);
#[cfg(any(target_os = "macos", target_os = "windows"))]
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Whether the global mouse hook is currently running (⇒ permission granted, where applicable).
#[tauri::command]
pub fn mouse_hook_active() -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        TAP_ACTIVE.load(Ordering::Relaxed)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Set which mouse combos are currently bound, as encoded keys (see the module header). Only these
/// are swallowed + forwarded; everything else passes through. Also derives which extra buttons are
/// hold-modifiers so the hook knows to swallow them.
#[tauri::command]
pub fn set_mouse_bindings(keys: Vec<u32>) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let mut hold_mask = 0u32;
        for &k in &keys {
            let hold = (k >> 16) & 0xFF;
            if hold > 0 && hold < 32 {
                hold_mask |= 1 << hold;
            }
        }
        if let Ok(mut b) = BOUND.lock() {
            *b = keys;
        }
        HOLD_MASK.store(hold_mask, Ordering::Relaxed);
        // A binding change can't leave a stale hold latched.
        CURRENT_HOLD.store(0, Ordering::Relaxed);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = keys;
    }
}

/// Retry starting the hook (e.g. right after the user grants Accessibility on macOS).
#[tauri::command]
pub fn restart_mouse_hook(app: tauri::AppHandle) {
    start(app);
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn is_bound(key: u32) -> bool {
    BOUND.lock().ok().map(|b| b.contains(&key)).unwrap_or(false)
}

// Core state machine, shared by both platforms. `dom` is the DOM button number, `kb_mods` is the
// raw modifier bits (bit0 primary, 1 shift, 2 alt, 3 ctrl-secondary, 4 super). Returns true if the
// event should be SWALLOWED (deleted).
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn handle_mouse(dom: i64, kb_mods: u32, is_down: bool) -> bool {
    use tauri::Emitter;
    let d = (dom as u32) & 0xFF;
    let dbit = if d < 32 { 1u32 << d } else { 0 };

    if is_down {
        let held = CURRENT_HOLD.load(Ordering::Relaxed);
        if held != 0 {
            // A hold is active → this click may complete a chord.
            let key = d | (kb_mods << 8) | (held << 16);
            if is_bound(key) {
                if let Some(app) = APP.get() {
                    let _ = app.emit("global-mouse-button", key);
                }
                SWALLOWED.fetch_or(dbit, Ordering::Relaxed);
                return true;
            }
            return false; // unbound click while holding: let it through
        }
        // No hold active. Is this button a hold-modifier?
        if dbit != 0 && (HOLD_MASK.load(Ordering::Relaxed) & dbit) != 0 {
            CURRENT_HOLD.store(d, Ordering::Relaxed);
            SWALLOWED.fetch_or(dbit, Ordering::Relaxed);
            return true; // swallow the hold button so it doesn't navigate
        }
        // Plain (keyboard-modifier + button) shortcut.
        let key = d | (kb_mods << 8);
        if is_bound(key) {
            if let Some(app) = APP.get() {
                let _ = app.emit("global-mouse-button", key);
            }
            SWALLOWED.fetch_or(dbit, Ordering::Relaxed);
            return true;
        }
        false
    } else {
        // UP: swallow if we swallowed the matching DOWN; end any hold this button owns.
        let mut swallow = false;
        if SWALLOWED.load(Ordering::Relaxed) & dbit != 0 {
            SWALLOWED.fetch_and(!dbit, Ordering::Relaxed);
            swallow = true;
        }
        if d != 0 && CURRENT_HOLD.load(Ordering::Relaxed) == d {
            CURRENT_HOLD.store(0, Ordering::Relaxed);
        }
        swallow
    }
}

// ===================== macOS: CGEventTap =====================

#[cfg(target_os = "macos")]
mod imp {
    use super::{handle_mouse, CURRENT_HOLD, STARTED, SWALLOWED, TAP_ACTIVE, APP};
    use std::os::raw::c_void;
    use std::sync::atomic::{AtomicPtr, Ordering};

    type CFMachPortRef = *mut c_void;
    type CGEventRef = *mut c_void;
    type CGEventTapProxy = *const c_void;

    type CGEventTapCallBack = unsafe extern "C" fn(
        proxy: CGEventTapProxy,
        etype: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;
        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
        fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        fn CGEventGetFlags(event: CGEventRef) -> u64;
    }

    // CGEventType values.
    const LEFT_DOWN: u32 = 1;
    const LEFT_UP: u32 = 2;
    const RIGHT_DOWN: u32 = 3;
    const RIGHT_UP: u32 = 4;
    const OTHER_DOWN: u32 = 25;
    const OTHER_UP: u32 = 26;
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    const MOUSE_EVENT_BUTTON_NUMBER: u32 = 3;

    const SESSION_EVENT_TAP: u32 = 1;
    const HEAD_INSERT_EVENT_TAP: u32 = 0;
    const TAP_OPTION_DEFAULT: u32 = 0; // 0 = active (can swallow); 1 = listen-only

    static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    fn kb_mods(flags: u64) -> u32 {
        let mut m = 0u32;
        if flags & 0x0010_0000 != 0 {
            m |= 1; // Command → primary
        }
        if flags & 0x0002_0000 != 0 {
            m |= 2; // Shift
        }
        if flags & 0x0008_0000 != 0 {
            m |= 4; // Alternate (Option)
        }
        if flags & 0x0004_0000 != 0 {
            m |= 8; // Control → secondary
        }
        m
    }

    unsafe extern "C" fn tap_callback(
        _proxy: CGEventTapProxy,
        etype: u32,
        event: CGEventRef,
        _user_info: *mut c_void,
    ) -> CGEventRef {
        if etype == TAP_DISABLED_BY_TIMEOUT || etype == TAP_DISABLED_BY_USER_INPUT {
            let port = TAP_PORT.load(Ordering::SeqCst);
            if !port.is_null() {
                CGEventTapEnable(port, true);
            }
            // A disabled tap may have missed UP events — clear latched state.
            CURRENT_HOLD.store(0, Ordering::SeqCst);
            SWALLOWED.store(0, Ordering::SeqCst);
            return event;
        }

        let button_number = || {
            let b = CGEventGetIntegerValueField(event, MOUSE_EVENT_BUTTON_NUMBER);
            if b == 2 {
                1
            } else {
                b
            } // CGEvent middle = 2 → DOM 1
        };
        let (dom, is_down) = match etype {
            LEFT_DOWN => (0i64, true),
            LEFT_UP => (0, false),
            RIGHT_DOWN => (2, true),
            RIGHT_UP => (2, false),
            OTHER_DOWN => (button_number(), true),
            OTHER_UP => (button_number(), false),
            _ => return event,
        };

        let kb = kb_mods(CGEventGetFlags(event));
        if handle_mouse(dom, kb, is_down) {
            std::ptr::null_mut()
        } else {
            event
        }
    }

    pub fn start(app: tauri::AppHandle) {
        use core_foundation::base::TCFType;
        use core_foundation::mach_port::CFMachPort;
        use core_foundation::runloop::CFRunLoop;
        use core_foundation_sys::runloop::kCFRunLoopCommonModes;

        let _ = APP.set(app);
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }

        std::thread::spawn(move || unsafe {
            // Tap all button down/up so hold-modifiers + click triggers can be tracked + swallowed.
            let mask = (1u64 << LEFT_DOWN)
                | (1u64 << LEFT_UP)
                | (1u64 << RIGHT_DOWN)
                | (1u64 << RIGHT_UP)
                | (1u64 << OTHER_DOWN)
                | (1u64 << OTHER_UP);
            let port = CGEventTapCreate(
                SESSION_EVENT_TAP,
                HEAD_INSERT_EVENT_TAP,
                TAP_OPTION_DEFAULT,
                mask,
                tap_callback,
                std::ptr::null_mut(),
            );

            if port.is_null() {
                TAP_ACTIVE.store(false, Ordering::SeqCst);
                STARTED.store(false, Ordering::SeqCst);
                return;
            }

            TAP_PORT.store(port, Ordering::SeqCst);
            let mach_port = CFMachPort::wrap_under_create_rule(port as _);
            match mach_port.create_runloop_source(0) {
                Ok(source) => {
                    let current = CFRunLoop::get_current();
                    current.add_source(&source, kCFRunLoopCommonModes);
                    CGEventTapEnable(port, true);
                    TAP_ACTIVE.store(true, Ordering::SeqCst);
                    CFRunLoop::run_current(); // blocks forever, dispatching callbacks
                    TAP_ACTIVE.store(false, Ordering::SeqCst);
                }
                Err(_) => {
                    TAP_ACTIVE.store(false, Ordering::SeqCst);
                }
            }
            TAP_PORT.store(std::ptr::null_mut(), Ordering::SeqCst);
            STARTED.store(false, Ordering::SeqCst);
        });
    }
}

// ===================== Windows: WH_MOUSE_LL =====================

#[cfg(target_os = "windows")]
mod imp {
    use super::{handle_mouse, STARTED, TAP_ACTIVE, APP};
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, HHOOK, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
        WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    fn down(vk: i32) -> bool {
        unsafe { (GetAsyncKeyState(vk) as u16) & 0x8000 != 0 }
    }

    fn kb_mods() -> u32 {
        let mut m = 0u32;
        if down(VK_CONTROL.0 as i32) {
            m |= 1; // Ctrl → primary
        }
        if down(VK_SHIFT.0 as i32) {
            m |= 2;
        }
        if down(VK_MENU.0 as i32) {
            m |= 4; // Alt
        }
        if down(VK_LWIN.0 as i32) || down(VK_RWIN.0 as i32) {
            m |= 16; // Super
        }
        m
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            let xbtn = || ((*(lparam.0 as *const MSLLHOOKSTRUCT)).mouseData >> 16) & 0xFFFF;
            let mapped: Option<(i64, bool)> = if msg == WM_LBUTTONDOWN {
                Some((0, true))
            } else if msg == WM_LBUTTONUP {
                Some((0, false))
            } else if msg == WM_RBUTTONDOWN {
                Some((2, true))
            } else if msg == WM_RBUTTONUP {
                Some((2, false))
            } else if msg == WM_MBUTTONDOWN {
                Some((1, true))
            } else if msg == WM_MBUTTONUP {
                Some((1, false))
            } else if msg == WM_XBUTTONDOWN {
                Some((if xbtn() == 2 { 4 } else { 3 }, true)) // XBUTTON1=Back(3), XBUTTON2=Forward(4)
            } else if msg == WM_XBUTTONUP {
                Some((if xbtn() == 2 { 4 } else { 3 }, false))
            } else {
                None
            };

            if let Some((dom, is_down)) = mapped {
                if handle_mouse(dom, kb_mods(), is_down) {
                    return LRESULT(1); // swallow
                }
            }
        }
        CallNextHookEx(HHOOK(std::ptr::null_mut()), code, wparam, lparam)
    }

    pub fn start(app: tauri::AppHandle) {
        let _ = APP.set(app);
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }

        std::thread::spawn(move || unsafe {
            let hmod = GetModuleHandleW(None).unwrap_or_default();
            match SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), HINSTANCE(hmod.0), 0) {
                Ok(_hook) => {
                    TAP_ACTIVE.store(true, Ordering::SeqCst);
                    // A low-level hook only fires while the installing thread pumps messages.
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).as_bool() {
                        // no dispatch needed; the hook runs on this thread
                    }
                    TAP_ACTIVE.store(false, Ordering::SeqCst);
                }
                Err(_) => {
                    TAP_ACTIVE.store(false, Ordering::SeqCst);
                }
            }
            STARTED.store(false, Ordering::SeqCst);
        });
    }
}

// ===================== dispatch =====================

/// Start the global mouse hook. Safe to call repeatedly — a no-op once running.
pub fn start(app: tauri::AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        imp::start(app);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
    }
}
