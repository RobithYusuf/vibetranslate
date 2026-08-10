import { useEffect, useRef, useState } from 'react';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from './stores/appStore';
import { useSettings } from './hooks/useSettings';
import { useGlobalShortcut } from './hooks/useGlobalShortcut';
import { useTranslation } from './hooks/useTranslation';
import { useVoiceInput } from './hooks/useVoiceInput';
import { useAppStatus } from './hooks/useAppStatus';
import { useUpdater } from './hooks/useUpdater';
import { fontStackFor, scaleValueFor } from './utils/constants';
import { encodeMouseShortcut } from './utils/mouseShortcut';
import Settings from './components/Settings';
import TranslationPopup from './components/TranslationPopup';
import LoadingOverlay from './components/LoadingOverlay';
import RecordingOverlay from './components/RecordingOverlay';
import { TranscriptOverlay } from '@/components/TranscriptOverlay';
import { Paywall } from './components/Paywall';
import UpdateModal from './components/UpdateModal';
import logo from '@/assets/logo.png';

function App() {
  const { shortcut, popupShortcut, terminalShortcut, enhanceEnabled, enhanceShortcut, appEnabled,
    voiceEnabled, voiceShortcut, voiceOriginalShortcut, uiFont, uiScale, recordingShortcut,
    voiceLiveMode } = useAppStore();
  const { translate, translatePopup, translateTerminal, enhance, enhancePopup, enhanceTerminal } = useTranslation();
  const { voiceTranslate, voiceOriginal } = useVoiceInput();
  const { loading: statusLoading, shouldShowPaywall, checkStatus } = useAppStatus();
  const [paywallDismissed, setPaywallDismissed] = useState(false);

  // The live transcript overlay is built when live mode is ON — here on startup, and again
  // when the toggle flips — never when a dictation starts. Creating it 1.4s before showing it
  // was not enough time for React to mount, and the user got a blank white rectangle. Users
  // who never enable live dictation still never pay for the window.
  useEffect(() => {
    if (!voiceLiveMode) return;
    void invoke('prepare_transcript_window').catch(() => {});
  }, [voiceLiveMode]);

  // Check if this is the main settings window (not popup or loading)
  // Shortcuts should ONLY be registered in the main window to avoid conflicts
  const hash = window.location.hash;
  const isMainWindow = hash !== '#/popup' && hash !== '#/loading' && hash !== '#/recording' && hash !== '#/transcript';

  // In-app auto-update (main window only): auto-checks then shows a confirm modal.
  const updater = useUpdater(isMainWindow);

  useSettings();

  // While a voice recording is active, forward Enter/Esc to the overlay from THIS window too.
  // The overlay is focused on show, but activation can race and land key status on the settings
  // window instead — without this, Enter (finish) / Esc (cancel) would silently do nothing.
  const isRecordingVoice = useAppStore((s) => s.isRecording);
  useEffect(() => {
    if (!isMainWindow || !isRecordingVoice) return;
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack Enter while the user is typing in a field (Esc is fine to forward).
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === 'Enter' && !typing) { e.preventDefault(); void emitTo('recording', 'voice-stop'); }
      else if (e.key === 'Escape') { e.preventDefault(); void emitTo('recording', 'voice-cancel'); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isMainWindow, isRecordingVoice]);

  // Record which microphone the overlay ACTUALLY captured from (shown under the mic picker
  // in Settings, so "System default" is never a mystery).
  const setLastMicUsed = useAppStore((s) => s.setLastMicUsed);
  useEffect(() => {
    if (!isMainWindow) return;
    const un = listen<string>('voice-mic-used', (e) => setLastMicUsed(e.payload || ''));
    return () => { un.then((f) => f()); };
  }, [isMainWindow, setLastMicUsed]);

  // Keep the tray menu's feature list + shortcuts in sync with the user's actual settings
  // (emitted on load + whenever a shortcut / toggle changes; the tray rebuilds its menu).
  useEffect(() => {
    if (!isMainWindow) return;
    void emit('tray-shortcuts', {
      translate: shortcut,
      popup: popupShortcut,
      terminal: terminalShortcut,
      enhance: enhanceShortcut,
      voice: voiceShortcut,
      voiceOriginal: voiceOriginalShortcut,
      voiceEnabled,
      enhanceEnabled,
    });
  }, [isMainWindow, shortcut, popupShortcut, terminalShortcut, enhanceShortcut, voiceShortcut, voiceOriginalShortcut, voiceEnabled, enhanceEnabled]);

  // Global mouse-button shortcuts. The native hook (mouse_hook.rs) forwards every extra
  // mouse-button press (middle/back/forward/side) as `global-mouse-button` with the DOM button
  // number, no matter which app is focused. If that button is bound to a feature ("Mouse3" etc.)
  // we trigger it — this is what makes a mouse shortcut work while you're in ANOTHER app (the
  // webview alone only sees mouse events over its own window). A ref keeps the handler fresh
  // without re-subscribing the listener on every render.
  const lastMouseFireRef = useRef(0);
  const mouseTriggerRef = useRef<(btn: number) => void>(() => {});
  mouseTriggerRef.current = (key: number) => {
    if (!appEnabled) return;
    const bindings: Array<[string, () => void, boolean]> = [
      [shortcut, enhanceEnabled ? enhance : translate, true],
      [popupShortcut, enhanceEnabled ? enhancePopup : translatePopup, true],
      [terminalShortcut, enhanceEnabled ? enhanceTerminal : translateTerminal, true],
      [enhanceShortcut, enhance, true],
      [voiceShortcut, voiceTranslate, voiceEnabled],
      [voiceOriginalShortcut, voiceOriginal, voiceEnabled],
    ];
    for (const [sc, action, enabled] of bindings) {
      if (enabled && encodeMouseShortcut(sc) === key) {
        const now = performance.now();
        if (now - lastMouseFireRef.current < 300) return; // debounce doubled presses
        lastMouseFireRef.current = now;
        action();
        break;
      }
    }
  };
  useEffect(() => {
    if (!isMainWindow) return;
    const unlisten = listen<number>('global-mouse-button', (e) => mouseTriggerRef.current(e.payload));
    return () => { unlisten.then((fn) => fn()); };
  }, [isMainWindow]);

  // The native mouse hook fails to start until Accessibility is granted. restart_mouse_hook is a
  // no-op once it's running, so calling it on mount + whenever the window regains focus lets the
  // hook come alive right after the user grants permission — without needing to relaunch the app.
  useEffect(() => {
    if (!isMainWindow) return;
    const retry = () => { void invoke('restart_mouse_hook').catch(() => {}); };
    retry();
    window.addEventListener('focus', retry);
    return () => window.removeEventListener('focus', retry);
  }, [isMainWindow]);

  // Tell the native hook which mouse buttons are actually bound to an ENABLED feature, so it only
  // swallows + forwards those (an unbound Back button still navigates the browser normally). Sent
  // whenever the shortcut set or enabled state changes.
  useEffect(() => {
    if (!isMainWindow) return;
    const active: string[] = [];
    // While recording a shortcut, bind nothing so the button being pressed reaches the recorder
    // (isn't swallowed) and doesn't fire its action.
    if (appEnabled && !recordingShortcut) {
      active.push(shortcut, popupShortcut, terminalShortcut, enhanceShortcut);
      if (voiceEnabled) active.push(voiceShortcut, voiceOriginalShortcut);
    }
    const keys = active
      .map(encodeMouseShortcut)
      .filter((k): k is number => k !== null);
    void invoke('set_mouse_bindings', { keys });
  }, [isMainWindow, appEnabled, voiceEnabled, recordingShortcut, shortcut, popupShortcut, terminalShortcut, enhanceShortcut, voiceShortcut, voiceOriginalShortcut]);

  // Appearance: apply the selected font app-wide (every window) via the --app-font
  // CSS variable, and the UI zoom only in the main settings window (so floating
  // overlays/popups keep their fixed size).
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font', fontStackFor(uiFont));
  }, [uiFont]);
  useEffect(() => {
    if (!isMainWindow) return;
    (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(scaleValueFor(uiScale));
  }, [uiScale, isMainWindow]);

  // Replace shortcut: select text → press shortcut → auto copy, translate/enhance, paste/replace
  // When enhanceEnabled is ON, this does enhance instead of translate
  // Only active when appEnabled is true
  useGlobalShortcut({
    shortcut,
    onTrigger: enhanceEnabled ? enhance : translate,
    enabled: isMainWindow && appEnabled,
  });

  // Popup shortcut: select text → press shortcut → auto copy, translate/enhance, show popup
  // When enhanceEnabled is ON, this does enhance instead of translate
  // Only active when appEnabled is true
  useGlobalShortcut({
    shortcut: popupShortcut,
    onTrigger: enhanceEnabled ? enhancePopup : translatePopup,
    enabled: isMainWindow && appEnabled,
  });

  // Terminal shortcut: for PowerShell/CMD/Terminal
  // Uses special paste method (Ctrl+A to select line, then Ctrl+V)
  // When enhanceEnabled is ON, this does enhance instead of translate
  // Only active when appEnabled is true
  useGlobalShortcut({
    shortcut: terminalShortcut,
    onTrigger: enhanceEnabled ? enhanceTerminal : translateTerminal,
    enabled: isMainWindow && appEnabled,
  });

  // Enhance shortcut: dedicated hotkey that always enhances the selected text (independent
  // of the enhanceEnabled toggle, which instead makes the main/popup/terminal shortcuts
  // enhance). Previously this shortcut was recordable + shown in Settings but never
  // registered — a dead control. Now it works.
  useGlobalShortcut({
    shortcut: enhanceShortcut,
    onTrigger: enhance,
    enabled: isMainWindow && appEnabled,
  });

  // Voice → Translate: press to record, press again to transcribe + translate + paste
  useGlobalShortcut({
    shortcut: voiceShortcut,
    onTrigger: voiceTranslate,
    enabled: isMainWindow && appEnabled && voiceEnabled,
  });

  // Voice → Original: press to record, press again to transcribe (raw) + paste
  useGlobalShortcut({
    shortcut: voiceOriginalShortcut,
    onTrigger: voiceOriginal,
    enabled: isMainWindow && appEnabled && voiceEnabled,
  });

  // Note: the entire voice lifecycle (capture/transcribe/translate/paste + the ✗/✓
  // buttons + Esc/Enter keys) now lives in the always-visible recording overlay
  // window (so it isn't suspended when the main window is hidden in the tray). The
  // main window only triggers it (voiceTranslate/voiceOriginal) and shows/hides the
  // overlay; see useVoiceInput.ts for the cross-window event protocol.

  // Get cancel function from store
  const cancelTranslation = useAppStore((state) => state.cancelTranslation);

  useEffect(() => {
    const unlistenSettings = listen('menu:settings', async () => {
      await invoke('show_settings_window');
    });

    const unlistenTray = listen('tray:click', async () => {
      await invoke('show_settings_window');
    });

    // Listen for cancel event from loading overlay
    const unlistenCancel = listen('translation-cancel', () => {
      console.log('[App] Cancel event received');
      cancelTranslation();
    });

    return () => {
      unlistenSettings.then((fn) => fn());
      unlistenTray.then((fn) => fn());
      unlistenCancel.then((fn) => fn());
    };
  }, [cancelTranslation]);

  // Route to different components based on window hash
  // (hash is already defined above for isMainWindow check)
  if (hash === '#/popup') {
    return <TranslationPopup />;
  }

  if (hash === '#/loading') {
    return <LoadingOverlay />;
  }

  if (hash === '#/transcript') {
    return <TranscriptOverlay />;
  }

  if (hash === '#/recording') {
    return <RecordingOverlay />;
  }

  // Show loading while checking status
  if (statusLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#1e1e1e] text-white">
        <div className="text-center">
          <img src={logo} alt="VibeTranslate" className="w-12 h-12 mx-auto mb-4 animate-pulse" />
          <p className="text-white/60">Loading...</p>
        </div>
      </div>
    );
  }

  // Show paywall if required
  if (shouldShowPaywall && !paywallDismissed) {
    return (
      <Paywall
        onActivated={() => {
          setPaywallDismissed(true);
          checkStatus(); // Re-check status
        }}
      />
    );
  }

  return (
    <>
      <Settings onCheckForUpdates={updater.checkNow} />
      <UpdateModal
        phase={updater.phase}
        info={updater.info}
        progress={updater.progress}
        error={updater.error}
        onInstall={updater.install}
        onDismiss={updater.dismiss}
        onRetry={updater.checkNow}
        onSkip={updater.skip}
      />
    </>
  );
}

export default App;
