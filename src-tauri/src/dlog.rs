// Debug-only logging.
//
// The native side printed 120+ lines per operation in RELEASE builds, including the
// foreground window title and the first 50 characters of the user's selected text. On a
// tool that exists to move people's private text around, that is a privacy leak sitting in
// stdout — and it contradicts the review policy this project asks contributors to follow.
//
// `dlog!` behaves exactly like `println!` during development and compiles to nothing in a
// release build. Genuine errors stay on `eprintln!` so support requests remain diagnosable.
#[macro_export]
macro_rules! dlog {
    ($($arg:tt)*) => {{
        #[cfg(debug_assertions)]
        println!($($arg)*);
    }};
}
