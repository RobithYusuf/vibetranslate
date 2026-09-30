import { invoke } from '@tauri-apps/api/core';

/**
 * Record one diagnostics event (see src-tauri/src/diag.rs).
 *
 * Rules for callers: short facts only (engine, duration, status, reason, counts). Never pass
 * dictated or translated text, clipboard contents, API keys or window titles; the Rust side
 * redacts key- and e-mail-shaped tokens as a backstop, not as permission. Fire-and-forget: a
 * failing log must never break the flow it describes.
 */
export function diag(area: string, msg: string): void {
  void invoke('diag_log', { area, msg }).catch(() => { /* logging is best-effort */ });
}

/** The report users copy or send: system header + recent events. */
export async function diagReport(header: string): Promise<string> {
  return await invoke<string>('diag_report', { header });
}

export async function diagClear(): Promise<void> {
  await invoke('diag_clear');
}

export async function diagOpenFolder(): Promise<void> {
  await invoke('diag_open_folder');
}

/** Coarse error class for logs: status codes and known failure kinds, not raw server text. */
export function errorKind(msg: string): string {
  const m = msg.toLowerCase();
  const code = msg.match(/\b(4\d\d|5\d\d)\b/)?.[1];
  if (/abort|cancel/.test(m)) return 'cancelled';
  if (/timed? ?out|timeout/.test(m)) return 'timeout';
  if (/no speech/.test(m)) return 'no-speech';
  if (/permission|denied|not allowed/.test(m)) return 'permission';
  if (/quota|rate limit|too many|429/.test(m)) return 'rate-limit';
  if (/api key|401|unauthor/.test(m)) return 'auth';
  if (/network|fetch|unreachable|load failed|could not reach/.test(m)) return 'network';
  if (code) return `http-${code}`;
  return msg.slice(0, 80);
}
