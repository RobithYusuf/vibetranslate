//! Diagnostics log: a short, SAFE record of what the app did, for users to copy or send when
//! something goes wrong.
//!
//! Why it exists: voice runs in an overlay window whose console nobody sees, and `dlog!` compiles
//! away in release builds, so a bug on a user's machine used to leave no trace at all.
//!
//! What goes in: lifecycle events and outcomes (engine, durations, status codes, reasons).
//! What NEVER goes in: dictated or translated text, clipboard contents, API keys, window
//! titles. Callers pass short event lines; `sanitize` is the backstop that strips key-shaped
//! tokens, e-mail addresses and the user's home path before anything is stored.
//!
//! Kept in memory (last MAX_LINES) and appended to `diagnostics.log` in the app's log folder,
//! rotated at MAX_FILE_BYTES, so it survives a crash or restart.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_LINES: usize = 300;
const MAX_FILE_BYTES: u64 = 256 * 1024;

static LINES: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Point the log at the app's log folder and load the tail of the previous run, so a report
/// sent after a restart still shows what happened before it.
pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("diagnostics.log");
    if let Ok(text) = std::fs::read_to_string(&path) {
        let mut lines = LINES.lock().unwrap_or_else(|e| e.into_inner());
        for l in text.lines().rev().take(MAX_LINES).collect::<Vec<_>>().into_iter().rev() {
            lines.push_back(l.to_string());
        }
    }
    *FILE.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
}

/// Record one event. `area` is a short tag ("voice", "stt", "perm"...).
pub fn log(area: &str, msg: &str) {
    let line = format!("{} {:<6} {}", timestamp(), area.chars().take(8).collect::<String>(), sanitize(msg));
    {
        let mut lines = LINES.lock().unwrap_or_else(|e| e.into_inner());
        lines.push_back(line.clone());
        while lines.len() > MAX_LINES {
            lines.pop_front();
        }
    }
    let path = FILE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(path) = path {
        if std::fs::metadata(&path).map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(false) {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// Strip anything that could identify the user or unlock their accounts. Token-based: a
/// word that looks like a key, an e-mail address or a Bearer credential is replaced, and the
/// home directory becomes "~". Deliberately broad; an over-redacted log is still useful.
pub fn sanitize(msg: &str) -> String {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let msg = if home.len() > 3 { msg.replace(&home, "~") } else { msg.to_string() };
    let mut out = Vec::new();
    let mut redact_next = false;
    for word in msg.split(' ') {
        if redact_next {
            out.push("[redacted]".to_string());
            redact_next = false;
            continue;
        }
        let w = word.trim_matches(|c: char| "\"'`,;()[]{}".contains(c));
        let lower = w.to_ascii_lowercase();
        if lower == "bearer" || lower == "authorization:" {
            out.push(word.to_string());
            redact_next = true;
            continue;
        }
        // Check every part of "name=value" / "name:value" too, not just the whole word.
        let parts: Vec<&str> = w.split(['=', ':']).collect();
        let keyish = parts.iter().any(|part| {
            let pl = part.to_ascii_lowercase();
            ["sk-", "gsk_", "aiza", "xai-", "ghp_", "eyj"].iter().any(|p| pl.starts_with(p)) && part.len() >= 16
        });
        let long_secret = parts.iter().any(|part| {
            part.len() >= 32
                && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                && part.chars().any(|c| c.is_ascii_digit())
                && part.chars().any(|c| c.is_ascii_alphabetic())
        });
        let email = w.contains('@') && w.contains('.') && !w.starts_with('@');
        if keyish || long_secret {
            out.push("[redacted-key]".to_string());
        } else if email {
            out.push("[redacted-email]".to_string());
        } else {
            out.push(word.to_string());
        }
    }
    // One line per event, bounded: a runaway message must not flood the log.
    let joined = out.join(" ").replace(['\n', '\r'], " ");
    joined.chars().take(400).collect()
}

/// UTC "YYYY-MM-DD HH:MM:SS" without a date/time dependency.
fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("sw_vers").arg("-productVersion").output() {
            return format!("macOS {}", String::from_utf8_lossy(&out.stdout).trim());
        }
        "macOS".into()
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::env::consts::OS.to_string()
    }
}

/// Header + recent events: what "Copy diagnostics" and "Send" hand over.
pub fn report(app_version: &str, extra_header: &str) -> String {
    let mut s = format!(
        "VibeTranslate {} · {} {}\n",
        app_version,
        os_version(),
        std::env::consts::ARCH
    );
    if !extra_header.trim().is_empty() {
        s.push_str(&sanitize(extra_header.trim()));
        s.push('\n');
    }
    s.push_str("----\n");
    for l in LINES.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        s.push_str(l);
        s.push('\n');
    }
    s
}

pub fn clear() {
    LINES.lock().unwrap_or_else(|e| e.into_inner()).clear();
    if let Some(path) = FILE.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        let _ = std::fs::remove_file(path.with_extension("log.1"));
        let _ = std::fs::write(path, "");
    }
}

pub fn folder() -> Option<PathBuf> {
    FILE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

// ---------- commands ----------

#[tauri::command]
pub fn diag_log(area: String, msg: String) {
    log(&area, &msg);
}

#[tauri::command]
pub fn diag_report(app: tauri::AppHandle, header: String) -> String {
    report(&app.package_info().version.to_string(), &header)
}

#[tauri::command]
pub fn diag_clear() {
    clear();
}

#[tauri::command]
pub fn diag_open_folder() -> Result<(), String> {
    let dir = folder().ok_or("log folder unknown")?;
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let cmd = "xdg-open";
    let mut child = std::process::Command::new(cmd).arg(dir).spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn redacts_secrets_but_keeps_events() {
        let s = sanitize("stt failed key=sk-abc123def456ghi789 Bearer gsk_1234567890abcdef token");
        assert!(!s.contains("abc123def456"), "{s}");
        assert!(!s.contains("gsk_1234567890abcdef"), "{s}");
        assert!(s.contains("stt failed"), "{s}");
        let e = sanitize("sent by someone@example.com ok");
        assert!(!e.contains("someone@example.com"), "{e}");
        assert_eq!(sanitize("voice stop reason=manual rec=8.9s"), "voice stop reason=manual rec=8.9s");
        let long = sanitize(&"x".repeat(2000));
        assert!(long.chars().count() <= 400);
    }
}
