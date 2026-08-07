// Encode a mouse shortcut string into the compact key the native hook (mouse_hook.rs) matches on,
// or null if the string isn't a mouse shortcut. Shared bit layout with Rust:
//   bits 0-7   = trigger button (DOM: left 0, middle 1, right 2, back 3, forward 4, side 5…)
//   bit 8      = Cmd/Ctrl primary   bit 9 = Shift   bit 10 = Alt   bit 11 = Control (mac secondary)
//   bit 12     = Super (Windows key)
//   bits 16-23 = HOLD extra button (0 = none; for "hold a button + click" chords)
// The primary "CommandOrControl" is ⌘ on macOS and Ctrl on Windows — the native hook sets bit 8
// for whichever that platform's primary is, so the same recorded shortcut matches on both.
// Examples: "Mouse3" → 3, "Alt+Mouse3" → 3 | (1<<10), "Hold3+Mouse0" → 0 | (3<<16).
export function encodeMouseShortcut(shortcut: string): number | null {
  if (!shortcut) return null;
  let button: number | null = null;
  let hold = 0;
  let mods = 0;
  for (const p of shortcut.split('+')) {
    let m: RegExpExecArray | null;
    if ((m = /^Mouse(\d+)$/.exec(p))) {
      button = parseInt(m[1], 10) & 0xff;
    } else if ((m = /^Hold(\d+)$/.exec(p))) {
      hold = parseInt(m[1], 10) & 0xff;
    } else {
      switch (p) {
        case 'CommandOrControl':
        case 'Command':
          mods |= 1 << 8; // primary (⌘ on macOS / Ctrl on Windows)
          break;
        case 'Shift':
          mods |= 1 << 9;
          break;
        case 'Alt':
        case 'Option':
          mods |= 1 << 10;
          break;
        case 'Control':
          mods |= 1 << 11; // macOS secondary Ctrl
          break;
        case 'Super':
        case 'Meta':
          mods |= 1 << 12; // Windows key
          break;
      }
    }
  }
  if (button === null) return null;
  return button | mods | (hold << 16);
}
