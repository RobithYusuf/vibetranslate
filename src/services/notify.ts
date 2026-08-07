import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

// Best-effort system notification (shared). Used when a small overlay can only fit a short
// status and the actionable detail ("speak closer to the mic", "check your connection")
// deserves a fuller message. Never throws; silently no-ops without permission.
export async function notify(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    if (granted) {
      sendNotification({ title: `VibeTranslate: ${title}`, body });
    }
  } catch {
    /* notifications are an enhancement, never a requirement */
  }
}
