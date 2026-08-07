import { invoke } from '@tauri-apps/api/core';

export async function saveActiveApp(): Promise<string> {
  return await invoke('save_active_app');
}

export async function getTargetApp(): Promise<string> {
  return await invoke('get_target_app');
}

// Capture the target app at the START of an operation, pinning it against the tracker.
// live=true (translate): query the real frontmost app now (~150ms osascript on macOS) so a Cmd-Tab
// right before the shortcut is respected. live=false (voice): use the instant tracker cache so it
// stays off the critical path to opening the mic.
export async function captureForegroundHwnd(live = true): Promise<string> {
  return await invoke('capture_foreground_hwnd', { live });
}

// Atomic capture + copy - captures HWND and sends Ctrl+C in one operation
// Critical for terminal mode where focus shifts quickly
// Returns the window title of captured window
export async function captureAndCopy(): Promise<string> {
  return await invoke('capture_and_copy');
}

export async function simulateCopy(): Promise<void> {
  await invoke('simulate_copy');
}

// Direct copy - sends Ctrl+C to currently focused window WITHOUT restoring foreground
// Use this for terminal mode where the user already has terminal focused
export async function simulateCopyDirect(): Promise<void> {
  await invoke('simulate_copy_direct');
}

// Terminal copy - sends Enter key to copy selection in Windows legacy console
// In Windows console, Enter copies the selected text (not Ctrl+C which cancels)
export async function simulateTerminalCopy(): Promise<void> {
  await invoke('simulate_terminal_copy');
}

export async function simulatePaste(): Promise<void> {
  await invoke('simulate_paste');
}

// Paste into a specific app (captured at voice first-press), bypassing the
// live foreground tracker so it lands where the user started.
export async function simulatePasteToApp(app: string, pos?: [number, number] | null): Promise<void> {
  // pos = the target window's position snapshotted at operation START (voice) — without it
  // the Rust side falls back to the live-tracked slot, which another operation may have
  // overwritten while a long recording was in flight.
  await invoke('simulate_paste_to_app', { app, winX: pos?.[0] ?? null, winY: pos?.[1] ?? null });
}

// Get terminal selection using Console APIs (AttachConsole + GetConsoleSelectionInfo)
// This uses Windows Console APIs to read selected text directly from terminal buffer
// Must be called IMMEDIATELY when shortcut is pressed, before any focus change
export async function getTerminalSelection(): Promise<string> {
  return await invoke('get_terminal_selection');
}

// Debug terminal info - returns detailed info about detected terminal type
export async function debugTerminalInfo(): Promise<string> {
  return await invoke('debug_terminal_info');
}
