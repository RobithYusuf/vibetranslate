//! API keys in the OS credential store instead of a plain file.
//!
//! Until now a user's own API key was written into settings.json in the app-data directory,
//! world-readable at 0644. Nothing exotic was needed to steal it: any process running as that
//! user could read the file. The README's "your API keys are kept locally" was true and also
//! easy to misread as "protected".
//!
//! `keyring` maps to the platform store — Keychain on macOS, Credential Manager on Windows —
//! so the secret is guarded by the OS rather than by file permissions.
//!
//! Failures are returned, never swallowed: if the store is unavailable the caller must decide,
//! and silently falling back to a plain file would recreate the exact problem this replaces.
use keyring::Entry;

/// Namespaces our entries in the OS store. Matches the bundle identifier so a user browsing
/// Keychain Access sees something recognisable rather than a mystery item.
const SERVICE: &str = "id.vibetranslate.desktop";

fn entry(key: &str) -> Result<Entry, String> {
    // Rejected rather than sanitised: every caller passes a fixed provider id, so anything
    // else is a bug worth surfacing, not something to quietly reshape.
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid secret key: {key}"));
    }
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    let e = entry(&key)?;
    if value.is_empty() {
        // Storing an empty string would leave a credential that reads as "configured".
        return match e.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        };
    }
    e.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        // Absent is a normal answer — most users never set a key at all.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod roundtrip_check {
    //! Touches the real OS credential store, because that is the only thing worth testing
    //! here — a mock would only prove the mock works. It uses a throwaway entry name and
    //! removes it again. Not run by CI, which only does `cargo check`.
    #[test]
    fn set_get_delete() {
        let k = "vt-selftest-tmp".to_string();
        super::secret_set(k.clone(), "rahasia-123".into()).expect("set gagal");
        let got = super::secret_get(k.clone()).expect("get gagal");
        println!("terbaca kembali: {:?}", got);
        assert_eq!(got.as_deref(), Some("rahasia-123"));
        super::secret_delete(k.clone()).expect("delete gagal");
        let after = super::secret_get(k.clone()).expect("get setelah delete gagal");
        println!("setelah dihapus: {:?}", after);
        assert!(after.is_none());
        // Nilai kosong harus dianggap "hapus", bukan "tersimpan kosong".
        super::secret_set(k.clone(), String::new()).expect("set kosong gagal");
        assert!(super::secret_get(k.clone()).unwrap().is_none());
        println!("nilai kosong diperlakukan sebagai hapus: benar");
    }
}
