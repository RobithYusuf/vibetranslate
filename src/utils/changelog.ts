// In-app changelog shown by the "What's New" panel (click the version in the status bar).
// Keep newest first. Each release: a version + short, user-facing bullet points.
// Update this on every release alongside package.json / tauri.conf.json version bumps.

export interface ChangelogEntry {
  version: string;
  date?: string; // ISO yyyy-mm-dd (optional)
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.0.39',
    date: '2026-08-08',
    changes: [
      'Fixed background audio not being muted at all while recording — a mistake introduced in 1.0.37 meant the mute command silently failed and music or video kept playing straight through',
    ],
  },
  {
    version: '1.0.38',
    date: '2026-08-08',
    changes: [
      'Your API keys now live in the system Keychain (macOS) or Credential Manager (Windows) instead of a settings file any program on your computer could read — existing keys are moved across automatically on first launch',
      'Windows: CLI Translate no longer interrupts whatever is running in your terminal. It used to send Ctrl+C to clear the line, which kills a running command or AI agent task; it now erases the line character by character, the same way macOS does',
      'Windows: CLI Translate in VS Code and Windows Terminal now replaces your text instead of pasting the translation after it',
      'Fixed background audio being turned back on if you had muted your machine yourself before recording',
      'Settings no longer claims system sound is muted while recording on Windows — that has only ever worked on macOS',
      'The free daily allowance now counts per install rather than per network address, so an office or campus sharing one connection no longer shares one allowance',
      'macOS install instructions corrected: Apple removed the right-click-to-open shortcut, so the app now tells you the path that actually works',
    ],
  },
  {
    version: '1.0.37',
    date: '2026-08-08',
    changes: [
      'Voice: fixed background audio coming back on partway through a recording, or never being silenced at all — starting a new recording soon after the previous one could let the old session turn the sound back on',
      'Voice: quitting while recording no longer leaves your Mac silent with nothing to explain why',
      'Much lighter on battery: the app was starting a background process about twice a second, all day, just to notice which window you were in. It now asks the system directly — roughly two thousand times cheaper per check',
      'Offline speech models are now pinned to an exact published version and verified before use, so a changed or tampered download is rejected instead of loaded',
    ],
  },
  {
    version: '1.0.36',
    date: '2026-08-07',
    changes: [
      'Voice: triggering the shortcut no longer drags the settings window to the front — on a multi-monitor setup it used to jump onto whichever screen it was left on, so you got a window you did not ask for alongside the listening popup',
      'Voice: the listening popup now carries a faint tilted logo watermark',
      'The raw-transcription shortcut is called "Voice → Dictation" everywhere — the app used to call it "Voice → Original" while every mention in the docs said Dictation, so people looked for a setting that did not exist under that name',
    ],
  },
  {
    version: '1.0.35',
    date: '2026-08-07',
    changes: [
      'Voice: the overlay now says "Getting ready…" until the microphone is genuinely recording, and only then says "Listening…" — it used to invite you to speak about half a second before anything was being captured, so the first words went missing',
      'Voice starts faster: silencing system audio now happens while the microphone opens instead of before it, and reads the previous volume state in one step',
      'Voice: if an offline speech model fails and the audio has to go online instead, the app now tells you rather than only writing it to a log',
      'Settings: Quit actually quits — it used to just close the window and leave the app running in the tray',
      'Settings: the "Get API key" link works for Gemini and no longer does nothing on a custom endpoint',
      'The licence and third-party notices now ship inside the app, as AGPL-3.0 requires',
      'Building from source works for contributors again: use pnpm build:local, which does not need the maintainer signing key',
    ],
  },
  {
    version: '1.0.34',
    date: '2026-08-07',
    changes: [
      'Fresh installs now work out of the box: the app starts on the free built-in server instead of asking for an API key you have not set yet',
      'Pressing a shortcut with no engine configured now says so, with a notification and an on-screen message — before, nothing happened at all',
      'Fixed a slow leak of leftover system processes: every sound the app played left one behind, and after weeks of uptime that could keep other apps from launching',
      'Windows: the MSI installer and portable .exe are published again alongside the regular installer',
      'The README now describes exactly what leaves your machine in offline mode, and warns that installers are not yet code-signed',
    ],
  },
  {
    version: '1.0.33',
    date: '2026-08-07',
    changes: [
      'VibeTranslate is now open source — the desktop app\'s code is public under AGPL-3.0, so anyone can read, audit, build and contribute to it',
      'Privacy: the app no longer writes diagnostic details — including window titles and a preview of your selected text — to the system log in release builds',
      'Settings now shows exactly which transcription engine will be used, and the offline translation option only appears when its model is actually installed',
      'Voice: new optional AI cleanup for plain dictation — fixes mishearings and punctuation without changing your wording or language',
      'Fixed: the licence screen\'s purchase button did nothing when clicked',
      'The free built-in server moved to a global edge network — faster from Indonesia, and reachable on networks that previously could not connect',
    ],
  },
  {
    version: '1.0.32',
    date: '2026-08-04',
    changes: [
      'Multi-monitor: loading, popup and the voice overlay now appear on the display of the window you triggered from - a cursor parked on another screen, or switching window/monitor right before the shortcut, no longer sends anything to the wrong place',
      'The result popup no longer takes focus (buttons respond to the first click) - fixes the "jumps to the main monitor and nothing translates" bug',
      'Copy is window-precise and race-free: the exact window you triggered from is re-raised if something stole focus mid-operation, and slow copies are waited for instead of failing as "no text selected" under heavy load',
      'CLI Translate (Replace) - the clearer new name for Terminal Mode: clearing the prompt uses Ctrl+U plus character-exact backspaces, never Ctrl+C, so a task running in Claude Code / Droid / any CLI agent is never interrupted',
      'Voice: the paste target is locked the moment you press the shortcut - translating mid-recording or switching windows cannot redirect the transcript; a stuck "recording" state now heals itself; starting voice closes an open popup first',
      'The loading indicator appears the instant the shortcut fires (it could lag 1-2s behind on long selections), and copy-stage errors are now shown on it',
      'Recording overlay: compact one-click checkmark/x buttons; finishing from another app = just press the voice shortcut again',
      'PDFs previewed with Quick Look (spacebar in Finder) can now be translated',
    ],
  },
  {
    version: '1.0.31',
    date: '2026-08-03',
    changes: [
      'Voice: recording length is now yours to set (1–15 min, default 10) with an elapsed timer on the overlay — long dictation no longer gets cut at 60 seconds',
      'Voice: auto-stop pause is adjustable (1–5s), and a hard-to-misread Manual/Auto explanation in Settings',
      'Voice: pick which microphone to record from (built-in, USB, headset) — with a live indicator of the mic actually used; an unplugged mic falls back to the system default automatically',
      'Voice: correction dictionary — words the speech-to-text keeps mishearing get replaced automatically in the transcript (e.g. "kuotman" → "podman")',
      'Voice reliability: recordings that hit the max length are transcribed instead of discarded; very long transcripts paste as-is instead of failing; audio is encoded lean so long clips always fit the upload limit',
      'Settings: the Voice section is redesigned into a compact grid with short hints',
      'Translate: the target-app lock now holds up to 60s, so even slow translations paste back into the right app after you switch windows',
    ],
  },
  {
    version: '1.0.30',
    date: '2026-08-03',
    changes: [
      'Terminals: translating a selection now works reliably (Terminal, iTerm2, Warp, Orca, and more) — the selection is picked up even in copy-on-select terminals, and replace mode automatically clears the input line first so the text is replaced instead of duplicated',
      'Multi-monitor: the recording overlay, loading indicator and popup now appear on the monitor you are working on, not always the main display',
      'Errors are actionable: failures show the reason on the loading indicator plus a notification with concrete guidance; a missing Accessibility permission opens the right System Settings pane for you',
      'Voice: Enter (finish) and Esc (cancel) now work reliably during a recording',
    ],
  },
  {
    version: '1.0.29',
    date: '2026-07-15',
    changes: [
      'Mouse shortcuts: bind an extra mouse button (Back/Forward/Middle/side) — on its own, with a keyboard modifier (⌘/⌥/Ctrl/Shift), or as a "hold a button + click" combo — and it triggers in any app (macOS & Windows)',
      'Voice: faster start; cancel/error now returns you to your app instead of bringing VibeTranslate to the front',
      'Voice: fixed a rare case where cancelling could leave the mic open or the system muted; a manual "Done" no longer discards real speech',
      'Translate: the target app is locked in for the whole operation, so switching apps (Cmd-Tab) while it works no longer pastes into the wrong place',
      'Translate (macOS): a failed copy no longer silently pastes your old clipboard over the selection',
      'Tray menu lists each feature with its shortcut; added an update button and shortcut-conflict warnings',
    ],
  },
  {
    version: '1.0.28',
    date: '2026-06-25',
    changes: [
      'Updates: "Skip this version", an auto-check on/off toggle, and a manual "Check for updates" button in Feedback',
      'Shortcuts: the Enhance hotkey now actually works (was a dead control)',
      'Shortcuts: you get a warning when a shortcut clashes with another one, is OS-reserved, or is AltGr-risky on Windows',
      'Shortcut recorder now maps the Windows/Super key correctly',
      'Tip added: bind a mouse button by mapping it to a keyboard combo in your mouse software',
    ],
  },
  {
    version: '1.0.27',
    date: '2026-06-25',
    changes: [
      'Security hardening: safer handling of your saved API keys, stricter network rules, and command-injection fixes',
      'Fixed: your selected AI model is no longer reset to default on every launch',
      'Fixed: voice recording could get stuck / leave audio muted after a cancel — now robust',
      'Privacy: the in-app log no longer prints your text or keys',
      'Custom endpoints must be HTTPS (localhost/internal addresses blocked)',
    ],
  },
  {
    version: '1.0.26',
    date: '2026-06-25',
    changes: [
      'In-app auto-update: the app now checks for new versions and offers to update itself — no more manual re-download (Windows & macOS)',
      'When an update is available you get a confirm dialog showing the version and what changed',
    ],
  },
  {
    version: '1.0.25',
    date: '2026-06-24',
    changes: [
      'Voice: "Boost quiet mic" now actually amplifies soft mics (real audio gain + limiter) — fixes "No speech detected"',
      'Voice: laptop audio no longer bleeds into recordings (system mute applied before capture starts)',
      'Voice: clearer, to-the-point transcription error messages',
      'Removed Voice vocabulary — speech-to-text biasing was unreliable; accepted as an STT limitation',
      'Updated AI model list: dropped deprecated Mixtral, added GPT-OSS',
    ],
  },
  {
    version: '1.0.24',
    date: '2026-06-24',
    changes: [
      'Voice input: speak to transcribe (Original) or translate, then paste at the cursor',
      'Neural voice auto-stop (Silero VAD) — beta, off by default',
      'Voice language follows your translation "From" setting; auto-detect guarded against wrong-script (e.g. Japanese/Chinese) output',
      'Bahasa Indonesia interface',
      'Settings cleaned up: voice enable + stop-mode in General, shortcuts in Shortcuts, languages reorganized, simpler Tutorial',
      'Whisper hallucination filter + Telegram paste fix',
    ],
  },
  {
    version: '1.0.22',
    changes: [
      'Landing page refresh with video showcase',
    ],
  },
];
