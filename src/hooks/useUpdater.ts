import { useEffect, useState, useCallback, useRef } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useAppStore } from '@/stores/appStore';

// In-app auto-update (Tauri updater). Runs ONLY in the main window. Auto-checks once
// shortly after startup; when an update exists it surfaces a confirm modal (see
// UpdateModal) so the user sees the new version + notes and chooses to install — we
// never install silently. Install = download (with progress) → install → relaunch.
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error';

export interface UpdateInfo {
  version: string;        // new version
  currentVersion: string; // installed version
  notes: string;          // release notes (manifest `notes`)
}

export function useUpdater(enabled: boolean) {
  const autoUpdateCheck = useAppStore((s) => s.autoUpdateCheck);
  const setSkippedUpdateVersion = useAppStore((s) => s.setSkippedUpdateVersion);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0); // 0..1 (0 when total unknown)
  const [error, setError] = useState<string | null>(null);
  const updateRef = useRef<Update | null>(null);
  const checkedRef = useRef(false);
  const installingRef = useRef(false); // re-entrancy guard: block a second install() (double-click)

  const runCheck = useCallback(async (manual: boolean) => {
    try {
      setError(null);
      setPhase('checking');
      const res = await check();
      if (res?.available) {
        // Honor "skip this version" on the AUTOMATIC check only; a manual "Check for
        // updates" always shows the result (read fresh so it's never a stale closure).
        const skipped = useAppStore.getState().skippedUpdateVersion;
        if (!manual && res.version === skipped) { setPhase('idle'); return false; }
        updateRef.current = res;
        setInfo({ version: res.version, currentVersion: res.currentVersion, notes: res.body || '' });
        setPhase('available');
        return true;
      }
      setPhase('idle'); // up to date
      return false;
    } catch (e) {
      // Network hiccup / dev build / endpoint down: stay quiet on the automatic check,
      // surface only when the user asked explicitly.
      console.warn('[Updater] check failed:', e);
      setError(e instanceof Error ? e.message : String(e));
      setPhase(manual ? 'error' : 'idle');
      return false;
    }
  }, []);

  // Auto-check once, a few seconds after the main window settles — unless the user
  // turned auto-check off in Settings.
  useEffect(() => {
    if (!enabled || !autoUpdateCheck || checkedRef.current) return;
    checkedRef.current = true;
    const t = setTimeout(() => { void runCheck(false); }, 4000);
    return () => clearTimeout(t);
  }, [enabled, autoUpdateCheck, runCheck]);

  const install = useCallback(async () => {
    const upd = updateRef.current;
    if (!upd || installingRef.current) return; // guard against a double-click starting two downloads
    installingRef.current = true;
    try {
      setError(null);
      setPhase('downloading');
      setProgress(0);
      let total = 0;
      let downloaded = 0;
      await upd.downloadAndInstall((ev) => {
        switch (ev.event) {
          case 'Started':
            total = ev.data.contentLength ?? 0;
            break;
          case 'Progress':
            downloaded += ev.data.chunkLength;
            if (total > 0) setProgress(Math.min(1, downloaded / total));
            break;
          case 'Finished':
            setPhase('installing');
            break;
        }
      });
      // New version staged — relaunch into it.
      await relaunch();
    } catch (e) {
      console.error('[Updater] install failed:', e);
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
      installingRef.current = false; // allow a retry after a failed download/install
    }
  }, []);

  const dismiss = useCallback(() => { setPhase('idle'); }, []);
  const checkNow = useCallback(() => runCheck(true), [runCheck]);
  // Skip this version: remember it so the automatic check won't prompt again until a
  // newer version appears. (A manual "Check for updates" still shows it.)
  const skip = useCallback(() => {
    const v = updateRef.current?.version;
    if (v) setSkippedUpdateVersion(v);
    setPhase('idle');
  }, [setSkippedUpdateVersion]);

  return { phase, info, progress, error, install, dismiss, checkNow, skip };
}
