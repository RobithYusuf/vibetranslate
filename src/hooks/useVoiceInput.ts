import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { useAppStore } from '@/stores/appStore';
import { VoiceMode, AIProvider } from '@/types';
import { captureForegroundHwnd } from '@/services/keyboard';
import { DEFAULT_VOICE_MAX_MINUTES, DEFAULT_VOICE_SILENCE_SEC } from '@/utils/constants';
import type { VoiceCorrection } from '@/utils/voiceCorrections';

// If the overlay never reports back (dropped 'voice-finished' / overlay wedged), force-clear
// the recording flag after the max recording window + a generous processing budget, so the
// next shortcut press isn't misread as a "stop" (which would lock the user out of voice).
// Processing budget after the recording cap. Scales with clip length: transcribing +
// translating a 15-minute clip on the free server can take well over a fixed 30s.
const watchdogGraceMs = (voiceMaxMs: number) => 30_000 + Math.ceil(voiceMaxMs / 4);

/**
 * Voice-to-Text trigger (runs in the MAIN window).
 *
 * The MAIN window is the only place the global shortcuts are registered, but when
 * it is hidden in the tray macOS suspends its WKWebView — which would freeze any
 * mic capture / transcription / button handling that lived here. So the ENTIRE
 * voice lifecycle (capture + VAD + transcription + translation + paste + mute +
 * Done/Cancel/Esc) now lives in the always-VISIBLE recording overlay window
 * (#/recording, src/components/RecordingOverlay.tsx), which is never suspended.
 *
 * This hook is just the trigger + the show/hide of the overlay. It talks to the
 * overlay over Tauri's cross-window event bus:
 *
 *   MAIN  --emitTo('recording', 'voice-start', {...})-->  OVERLAY
 *   MAIN  --emitTo('recording', 'voice-stop')-->          OVERLAY  (manual finish)
 *   MAIN  --emitTo('recording', 'voice-cancel')-->        OVERLAY  (Esc / cancel)
 *   OVERLAY --emit('voice-finished')-->                          MAIN     (clear isRecording flag)
 *
 * The MAIN window keeps ONLY: the shortcut entry point (toggleVoice), the
 * foreground-app capture (paste target), showing/hiding the overlay, and the
 * isRecording flag (used as the status-bar recording indicator).
 */

// Config snapshot sent to the overlay on each run. Plain object (must survive the
// structured-clone across the Tauri event boundary), so no functions / store refs.
export interface VoiceStartPayload {
  // Unique per run. The overlay ignores a 'voice-start' whose id it already began, so the
  // cold-start re-emit can't resurrect a run the user already cancelled/finished.
  sessionId: number;
  mode: VoiceMode;
  targetApp: string;
  targetPos: [number, number] | null; // target window pos snapshotted at capture (see paste)
  config: {
    apiKeys: Record<AIProvider, string | null>;
    provider: AIProvider;
    model: string;
    sourceLang: string;
    targetLang: string;
    voiceAutoStop: boolean;
    voiceMaxMs: number; // per-user safety cap (Settings > Voice > Max recording length)
    voiceSilenceMs: number; // AUTO-STOP: pause length that ends the utterance
    micDeviceId: string; // preferred microphone ('' = system default)
    voiceCorrections: VoiceCorrection[]; // post-transcription dictionary
    soundEnabled: boolean;
    voiceSoundEnabled: boolean;
    micAutoGain: boolean;       // AGC: boost quiet mics (single mic knob)
    voiceSttEngine: string;     // 'auto' | 'omnilingual-300m' (offline, experimental)
    voiceLiveMode: boolean;     // live dictation (dev only for now)
    voiceCleanup: boolean;      // Original mode: AI transcript proofreading
    customBaseURL: string; // for provider === 'custom' (voice→translate step)
    customModel: string;
  };
}

export function useVoiceInput() {
  const setIsRecording = useAppStore((s) => s.setIsRecording);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reEmitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startingRef = useRef(false);
  const stopAfterStartRef = useRef(false);
  const sessionCounterRef = useRef(0);

  const clearReEmit = () => {
    if (reEmitRef.current) { clearTimeout(reEmitRef.current); reEmitRef.current = null; }
  };
  const clearWatchdog = () => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  };
  const endSession = useCallback(() => {
    clearWatchdog();
    clearReEmit();
    setIsRecording(false);
  }, [setIsRecording]);

  // The overlay owns the recording; when it finishes/cancels/errors it emits
  // 'voice-finished' so we clear the status-bar recording flag (+ cancel the watchdog).
  useEffect(() => {
    const un = listen('voice-finished', () => { endSession(); });
    return () => { un.then((f) => f()); clearWatchdog(); };
  }, [endSession]);

  const toggleVoice = useCallback(async (mode: VoiceMode) => {
    const { isRecording, apiKeys, provider, model, sourceLang, targetLang, voiceAutoStop, soundEnabled, voiceSoundEnabled, voicePopupPosition, micAutoGain, voiceSttEngine, voiceLiveMode, voiceCleanup, voiceMaxMinutes, voiceSilenceSec, micDeviceId, voiceCorrections, customBaseURL, customModel } =
      useAppStore.getState();
    // Per-user cap from Settings (minutes -> ms); falls back to the built-in default.
    const voiceMaxMs = (voiceMaxMinutes && voiceMaxMinutes >= 1 ? voiceMaxMinutes : DEFAULT_VOICE_MAX_MINUTES) * 60_000;
    const voiceSilenceMs = Math.round((voiceSilenceSec && voiceSilenceSec >= 0.5 ? voiceSilenceSec : DEFAULT_VOICE_SILENCE_SEC) * 1000);

    // Already recording -> this press is the manual "finish". The overlay does the
    // actual stop + transcribe + paste; we just tell it to.
    if (isRecording) { void emitTo('recording', 'voice-stop'); return; }

    // NOTE: no pre-start key guard. Voice transcription ALWAYS falls back to the built-in
    // free server when there's no personal Groq/OpenAI key (see transcription.ts) — so it
    // works for ANY active provider (custom / gemini / openrouter included). The old guard
    // wrongly blocked those providers. A genuinely-unreachable backend surfaces as a clear
    // error at transcribe time instead.

    // A result popup may still be open when the user fires voice — hide it first (same
    // as the translate flow) so the recording overlay is the only thing that comes up.
    try { await invoke('hide_popup'); } catch { /* popup might not exist */ }

    // Capture the foreground app NOW (before the overlay steals focus) so the
    // overlay can paste back into wherever the user started. Best-effort.
    let targetApp = '';
    // live=true: query the ACTUAL frontmost window at press time. The old cache read
    // (live=false, ~120ms faster) pasted into the previous window on the previous monitor
    // when the user switched and immediately fired voice — the user starts speaking only
    // after the overlay shows, so the round-trip is imperceptible.
    try { targetApp = await captureForegroundHwnd(true); } catch (e) { console.warn('[Voice] capture foreground:', e); }
    // Snapshot the captured window's position NOW: the recording can run for minutes, and a
    // translate fired meanwhile overwrites the live slot — the paste must still hit the
    // window the user STARTED in.
    let targetPos: [number, number] | null = null;
    try { targetPos = (await invoke<[number, number] | null>('get_captured_target_pos')) ?? null; } catch { /* best effort */ }

    // Show the overlay FIRST. Only mark recording + hand off if it actually showed —
    // otherwise isRecording would be stuck true and the next press would misfire as a stop.
    try {
      await invoke('show_recording', { position: voicePopupPosition });
    } catch (e) {
      console.error('[Voice] show_recording failed, aborting voice start:', e);
      return;
    }

    setIsRecording(true);
    // Watchdog: force-clear the flag if the overlay never reports back.
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      console.warn('[Voice] watchdog: no voice-finished, clearing stuck recording state');
      setIsRecording(false);
      void invoke('hide_recording').catch(() => {});
      // The overlay normally unmutes on finish; in this wedged-overlay path it never did,
      // so unmute here too — otherwise the user's system audio stays muted indefinitely.
      void invoke('set_audio_muted', { mute: false }).catch(() => {});
    }, voiceMaxMs + watchdogGraceMs(voiceMaxMs));

    // Hand the whole run off to the overlay with a plain config snapshot.
    const payload: VoiceStartPayload = {
      sessionId: ++sessionCounterRef.current,
      mode,
      targetApp,
      targetPos,
      config: { apiKeys, provider, model, sourceLang, targetLang, voiceAutoStop, soundEnabled, voiceSoundEnabled, micAutoGain, voiceSttEngine, voiceLiveMode, voiceCleanup, voiceMaxMs, voiceSilenceMs, micDeviceId, voiceCorrections, customBaseURL, customModel },
    };
    void emitTo('recording', 'voice-start', payload);
    // Cold-start insurance: Tauri events aren't buffered, so if the overlay's listener wasn't
    // ready for the first emit it would be lost. Re-emit once shortly after — the overlay ignores
    // it (same sessionId) if the run already began. Cancelled on finish/cancel so a stale re-emit
    // can't resurrect an aborted run.
    clearReEmit();
    reEmitRef.current = setTimeout(() => { reEmitRef.current = null; void emitTo('recording', 'voice-start', payload); }, 250);
  }, [setIsRecording]);

  const voiceTranslate = useCallback(() => toggleVoice('translate'), [toggleVoice]);
  const voiceOriginal = useCallback(() => toggleVoice('original'), [toggleVoice]);

  // Push-to-talk uses the same start/stop events as tap mode. The small in-flight
  // guard handles a very quick press-and-release before show_recording resolves.
  const startVoice = useCallback(async (mode: VoiceMode) => {
    if (useAppStore.getState().isRecording || startingRef.current) return;
    startingRef.current = true;
    try {
      await toggleVoice(mode);
    } finally {
      startingRef.current = false;
      if (stopAfterStartRef.current) {
        stopAfterStartRef.current = false;
        if (useAppStore.getState().isRecording) void emitTo('recording', 'voice-stop');
      }
    }
  }, [toggleVoice]);

  const stopVoice = useCallback(() => {
    if (startingRef.current) {
      stopAfterStartRef.current = true;
      return;
    }
    if (useAppStore.getState().isRecording) void emitTo('recording', 'voice-stop');
  }, []);

  // Esc / external cancel: tell the overlay to abort + hide. Clear the flag locally
  // too (the overlay also emits 'voice-finished', this is just immediate feedback).
  const cancelVoice = useCallback(() => {
    void emitTo('recording', 'voice-cancel');
    endSession();
  }, [endSession]);

  return { toggleVoice, voiceTranslate, voiceOriginal, startVoice, stopVoice, cancelVoice };
}
