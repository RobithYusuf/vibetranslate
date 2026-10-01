// Mouse buttons by their DOM number (see utils/mouseShortcut.ts).
const MOUSE_NAMES: Record<string, string> = { '0': 'Left', '1': 'Middle', '2': 'Right', '3': 'Back', '4': 'Forward' };

export function formatShortcut(shortcut: string): string {
  return shortcut
    // Mouse shortcuts read as "Hold Back + Left" / "Back", not "Hold3+Mouse0" / "Mouse3".
    .replace(/Hold(\d+)/g, (_, n: string) => `Hold ${MOUSE_NAMES[n] ?? `Button ${n}`}`)
    .replace(/Mouse(\d+)/g, (_, n: string) => (MOUSE_NAMES[n] ? `${MOUSE_NAMES[n]} button` : `Mouse ${n}`))
    .replace('CommandOrControl', isMac() ? 'Cmd' : 'Ctrl')
    .replace('Command', 'Cmd')
    .replace('Control', 'Ctrl')
    .replace('Shift', 'Shift')
    .replace('Alt', isMac() ? 'Option' : 'Alt')
    .replace(/\+/g, ' + ');
}

export function isMac(): boolean {
  return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
