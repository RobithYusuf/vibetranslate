## What does this change?

<!-- The problem first, then your approach. One or two sentences is fine. -->

## How did you test it?

<!-- e.g. "ran pnpm tauri:dev on macOS 15, translated a selection in Chrome and Notes" -->

## Checklist

- [ ] `pnpm exec tsc --noEmit` passes
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` passes
- [ ] I ran the app and exercised the path I changed

Because this app holds Accessibility permission, please flag the following explicitly —
none of them block a PR, they just tell the reviewer where to look closely:

- [ ] This PR **adds a dependency**
- [ ] This PR **makes a network request**
- [ ] This PR **touches clipboard, keyboard, or window-focus code**
