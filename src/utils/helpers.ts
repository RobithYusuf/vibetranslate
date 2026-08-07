export function formatShortcut(shortcut: string): string {
  return shortcut
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
