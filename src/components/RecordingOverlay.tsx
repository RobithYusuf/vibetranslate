import { useEffect, useState, useRef } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, Check, X } from 'lucide-react';
import { VoiceStatus, VoiceMode } from '@/types';
import { VOICE_STATUS_MESSAGES, VOICE_BAR_COUNT, MAX_TRANSLATE_CHARS, VOICE_AUTODETECT_FALLBACK_LANG } from '@/utils/constants';
import { startRecording, stopRecording, cancelRecording } from '@/services/audioRecorder';
import { transcribe } from '@/services/transcription';
import { translateText } from '@/services/openai';
import { setClipboardText } from '@/services/clipboard';
import { simulatePasteToApp } from '@/services/keyboard';
import { cleanupTranscript } from '@/services/openai';
import { blobToPcm16kBase64 } from '@/utils/pcm';
import type { VoiceStartPayload } from '@/hooks/useVoiceInput';
import { applyVoiceCorrections } from '@/utils/voiceCorrections';
import { notify } from '@/services/notify';
// Higher-resolution mark: the watermark is rendered far larger than the 32px logo used
// elsewhere, which would visibly soften when scaled and rotated.
import logoMark from '@/assets/logo-mark.png';

const EMPTY_BARS = new Array(VOICE_BAR_COUNT).fill(0);

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Mute/unmute system audio so background sound doesn't bleed into the mic + VAD.
// Returns the invoke promise so the caller can AWAIT the mute landing before it
// starts capturing — otherwise the recorder's first chunk catches speaker audio
// that was still playing while the (async) osascript mute hadn't applied yet.
function setSystemMute(mute: boolean): Promise<void> {
  return invoke('set_audio_muted', { mute }).then(() => {}).catch(() => {});
}

// The overlay is a small one-line box (~286px): long error sentences truncate into "No spee…".
// Map every failure to a SHORT, glanceable label; the full actionable detail goes out as a
// system notification instead (see reportVoiceError).
function shortVoiceError(msg: string): string {
  if (/no speech/i.test(msg)) return 'No speech detected';
  if (/no audio/i.test(msg)) return 'No audio captured';
  if (/too large|too long/i.test(msg)) return 'Recording too long';
  if (/busy|429|rate/i.test(msg)) return 'Server busy — retry';
  if (/unreachable|fetch|network|load failed/i.test(msg)) return 'Server unreachable';
  if (/permission|denied/i.test(msg)) return 'Mic permission needed';
  if (/no microphone|not found/i.test(msg)) return 'No microphone found';
  // Fallback: first clause only, hard-capped.
  const first = msg.split(/[—.:]/)[0].trim();
  return first.length > 32 ? `${first.slice(0, 31)}…` : first || 'Error';
}

// Short label in the box; full guidance (when the message actually carries more) as a
// best-effort system notification so nothing readable is lost.
function reportVoiceError(msg: string): string {
  const short = shortVoiceError(msg);
  if (msg.length > short.length + 4) {
    void notify('Voice input failed', msg);
  }
  return short;
}

type RunConfig = VoiceStartPayload['config'];

/**
 * Recording overlay (route #/recording) — now the FULL voice capturer.
 *
 * This window stays VISIBLE during a recording, so macOS never suspends its
 * WKWebView. That is why the entire voice lifecycle lives here (capture + VAD +
 * transcription + translation + paste + mute + Done/Cancel/Esc) instead of in the
 * main window, which gets suspended when hidden in the tray.
 *
 * Cross-window protocol (see useVoiceInput.ts for the main side):
 *   MAIN  -> 'voice-start'  { mode, targetApp, config }  -> begin a run
 *   MAIN  -> 'voice-stop'                                 -> manual finish (process)
 *   MAIN  -> 'voice-cancel'                               -> abort + hide
 *   OVERLAY -> 'voice-finished'                           -> main clears isRecording
 *
 * getUserMedia runs in THIS window. The mic permission is granted process-wide on
 * macOS (TCC is per-app, not per-WKWebView), so capturing here works the same as
 * it did in the main window — and crucially keeps working while the main window is
 * hidden, because this window is always on-screen during a recording.
 */
export default function RecordingOverlay() {
  const [status, setStatus] = useState<VoiceStatus>('starting');
  const muteGateRef = useRef<Promise<void> | null>(null);
  // Bumped once per voice session. The mute is global system state, so an un-mute belonging to
  // a session that has already ended must never be allowed to fire during the NEXT one.
  const muteSessionRef = useRef(0);
  const [message, setMessage] = useState<string>(VOICE_STATUS_MESSAGES.starting);
  const [bars, setBars] = useState<number[]>(EMPTY_BARS);
  const idleRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Current run's context (set on 'voice-start'). Refs so the event listeners
  // (registered once) always see the latest values.
  const configRef = useRef<RunConfig | null>(null);
  const modeRef = useRef<VoiceMode>('translate');
  const targetAppRef = useRef<string>('');
  const targetPosRef = useRef<[number, number] | null>(null);
  const processingRef = useRef(false);            // re-entrancy guard for process()
  const cancelledRef = useRef(false);             // set by cancel() during the pipeline
  const abortRef = useRef<AbortController | null>(null); // aborts in-flight transcribe/translate
  const startedRef = useRef(false);               // true between begin() and a terminal state (idempotency)
  const sessionIdRef = useRef<number>(-1);         // id of the run we (last) began; blocks re-emit resurrection
  const finishedRef = useRef(false);              // true once a terminal state ran (blocks late process/double-finish)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // deferred hide_recording; cleared on next begin()

  // Button click handlers live inside the lifecycle effect's closure (so they share
  // the same refs/AbortController); bridge them out to the JSX buttons via these refs.
  const processHandlerRef = useRef<() => void>(() => {});
  const cancelHandlerRef = useRef<() => void>(() => {});

  // Set the local status + its localized message (reuse VOICE_STATUS_MESSAGES; no
  // new hardcoded English UI strings). `message` overrides for error detail.
  const announce = (s: VoiceStatus, msg?: string) => {
    setStatus(s);
    setMessage(msg || VOICE_STATUS_MESSAGES[s] || '');
    if (s !== 'recording') setBars(EMPTY_BARS);
  };

  // Terminal state for the run. Idempotent (guards double-finish). Restores mute and clears
  // MAIN's recording flag IMMEDIATELY via 'voice-finished' — NOT deferred behind the hide
  // delay, because a webview about to be hidden could drop a deferred emit. Only the cosmetic
  // hide is delayed (done lingers briefly, error longer so it's readable, cancel hides at once).
  // The mute is now started concurrently with opening the microphone, so an un-mute can be
  // requested while the mute is still in flight. Landing first would leave the user's speakers
  // muted after the session ended, so every un-mute waits for the mute to settle.
  const restoreAudio = async () => {
    const mySession = muteSessionRef.current;
    try { await muteGateRef.current; } catch { /* the mute failing doesn't block restoring */ }
    // A newer session may have started while this was waiting for the mute to settle. Un-muting
    // now would turn the user's audio back on in the MIDDLE of that recording — reported as
    // "YouTube stops, then comes back on halfway through". The new session owns the mute and
    // will restore it when it ends.
    if (muteSessionRef.current !== mySession) return;
    muteGateRef.current = null;
    void setSystemMute(false);
  };

  const finishSession = (visual: 'done' | 'error' | 'cancel') => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    startedRef.current = false;
    setRecStartedAt(0); // stop the elapsed ticker even when status stays 'recording' (cancel path)
    void restoreAudio();
    void emit('voice-finished');
    // On cancel/error/no-speech we didn't paste, so VibeTranslate — which was brought to the
    // foreground to un-mute the mic — would stay in front ("app pops up"). Hand focus straight back
    // to the app the user was in (or hide ourselves if unknown). Success ('done') already returns
    // focus by pasting into the target, so skip it there.
    if (visual !== 'done') {
      void invoke('restore_focus_to_app', { app: targetAppRef.current || '' }).catch(() => {});
    }
    const delay = visual === 'error' ? 2600 : visual === 'done' ? 1100 : 0;
    // Track the hide timer so a fresh begin() can cancel it — otherwise a stale timer
    // from this (finishing) session can hide the NEXT session's overlay mid-recording.
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => { hideTimerRef.current = null; void invoke('hide_recording').catch(() => {}); }, delay);
  };

  // Pre-warm the Silero VAD assets into the HTTP cache at startup — the onnxruntime WASM is ~13MB
  // and the model ~2MB, so fetching them lazily on the FIRST recording delays neural endpointing
  // (during which only the energy fallback runs). Prefetching here (this overlay is pre-created at
  // launch) moves that cost to idle. Best-effort, needs no mic, and never touches the record path.
  useEffect(() => {
    const assets = [
      '/ort-wasm-simd-threaded.wasm',
      '/silero_vad_v5.onnx',
      '/ort-wasm-simd-threaded.mjs',
      '/vad.worklet.bundle.min.js',
    ];
    for (const a of assets) void fetch(a).catch(() => {});
  }, []);

  // mac rounded-corners effect (unchanged).
  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    if (isMac) {
      const moduleName = '@cloudworxx/tauri-plugin-mac-rounded-corners';
      import(/* @vite-ignore */ moduleName)
        .then((mod) => { mod.enableModernWindowStyle({ cornerRadius: 14 }).catch(() => {}); })
        .catch(() => {});
    }
  }, []);

  // --- The voice lifecycle (ported from the old main-window useVoiceInput hook) ---
  useEffect(() => {
    // Finish + paste: stop recording, transcribe, (optionally translate), paste.
    const process = async (auto = false) => {
      if (processingRef.current || finishedRef.current) return; // never run after a terminal state
      const config = configRef.current;
      if (!config) return;
      processingRef.current = true;
      cancelledRef.current = false;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        announce('transcribing');
        const { blob, voicedMs, hadSpeech } = await stopRecording();
        void restoreAudio(); // recording done -> restore audio right away

        // Min-duration guard: only trust the VAD's "no speech" when THIS stop was the VAD's own
        // decision (auto). On a MANUAL finish (Done / Enter / re-press) the user stopped on
        // purpose — and with Silero active `voicedMs` can still be 0 because onSpeechEnd hasn't
        // fired yet — so never block; send it and let the Whisper hallucination filter handle a
        // truly silent clip. (Previously keyed off the auto-stop *config*, which wrongly discarded
        // real speech when the user hit Done before Silero closed the segment.)
        if (auto && (!hadSpeech || voicedMs < 400)) {
          announce('error', 'No speech detected');
          finishSession('error');
          return;
        }

        // Spoken language for Whisper = the translation source ("From"). 'auto' = detect;
        // transcribe() guards a wrong (JP/CN) auto-detect by retrying with the fallback.
        // Experimental offline engine (Settings > Voice). Falls back to the online
        // path on ANY local failure — with a console warning, never silently worse
        // than before the feature existed.
        let rawTranscript: string;
        if (['omnilingual-300m', 'whisper-turbo', 'parakeet-v3'].includes(config.voiceSttEngine)) {
          try {
            const t0 = performance.now();
            const samplesB64 = await blobToPcm16kBase64(blob);
            rawTranscript = await invoke<string>('transcribe_local', { modelId: config.voiceSttEngine, samplesB64, sampleRate: 16000, language: config.sourceLang || '' });
            console.log(`[Voice] local engine ok in ${Math.round(performance.now() - t0)}ms`);
          } catch (localErr) {
            console.warn('[Voice] local engine failed, falling back to online:', localErr);
            // The user picked an offline engine, so uploading the audio is the opposite of what
            // they asked for. It still beats losing the recording, but it must not be silent —
            // a console warning is invisible to them, and the README now promises this is shown.
            announce('transcribing', 'Offline model failed — sending online');
            rawTranscript = await transcribe({
              blob,
              provider: config.provider,
              apiKeys: config.apiKeys,
              preferProvider: config.voiceSttEngine,
              language: config.sourceLang || 'auto',
              fallbackLanguage: VOICE_AUTODETECT_FALLBACK_LANG,
              signal: controller.signal,
            });
          }
        } else {
          rawTranscript = await transcribe({
            blob,
            provider: config.provider,
            apiKeys: config.apiKeys,
            preferProvider: config.voiceSttEngine,
            language: config.sourceLang || 'auto',
            fallbackLanguage: VOICE_AUTODETECT_FALLBACK_LANG,
            signal: controller.signal,
          });
        }
        // User correction dictionary: deterministic fixes for habitual mis-hearings, applied to
        // the transcript BEFORE translation/pasting (voice only).
        const transcript = config.voiceCorrections?.length
          ? applyVoiceCorrections(rawTranscript, config.voiceCorrections)
          : rawTranscript;

        let out = transcript;
        // Original mode + 'AI tidy' toggle: proofread the transcript (mishearings +
        // punctuation only — same language, same style). Failure keeps the raw transcript;
        // this step can never make voice worse than having the feature off.
        if (modeRef.current === 'original' && config.voiceCleanup && transcript.trim()) {
          announce('cleaning');
          try {
            out = await cleanupTranscript({
              text: transcript,
              language: config.sourceLang && config.sourceLang !== 'auto' ? config.sourceLang : VOICE_AUTODETECT_FALLBACK_LANG,
              apiKeys: config.apiKeys,
              provider: config.provider,
              model: config.model,
              baseURL: config.customBaseURL,
              signal: controller.signal,
            });
          } catch (e) {
            console.warn('[Voice] AI tidy failed, pasting raw transcript:', e);
            out = transcript;
          }
        }
        // Over the translate cap (~6 min of speech): NEVER discard the user's dictation — fall
        // back to pasting the raw transcript instead of translating it.
        const canTranslate = transcript.length <= MAX_TRANSLATE_CHARS;
        if (modeRef.current === 'translate' && !canTranslate) {
          console.warn(`[Voice] Transcript ${transcript.length} chars > ${MAX_TRANSLATE_CHARS} - pasting raw transcript instead of translating`);
        }
        if (modeRef.current === 'translate' && canTranslate) {
          announce('translating');
          // Custom provider needs its own base URL + model (same as the main translate flow).
          const isCustom = config.provider === 'custom';
          const chosenModel = isCustom ? config.customModel : config.model;
          const r = await translateText({
            text: transcript,
            sourceLang: config.sourceLang,
            targetLang: config.targetLang,
            apiKey: config.apiKeys[config.provider] || '',
            provider: config.provider,
            model: chosenModel === 'auto' ? undefined : chosenModel,
            baseURL: isCustom ? config.customBaseURL : undefined,
            signal: controller.signal,
          });
          out = r.translatedText;
        }

        if (cancelledRef.current) return; // cancelled during the pipeline -> paste nothing

        announce('pasting');
        await setClipboardText(out);
        await sleep(120);
        await simulatePasteToApp(targetAppRef.current || '', targetPosRef.current);

        if (config.voiceSoundEnabled) { try { await invoke('play_sound', { soundType: 'success' }); } catch { /* */ } }
        announce('done');
        finishSession('done');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const cancelled = cancelledRef.current
          || (err instanceof DOMException && err.name === 'AbortError')
          || /cancel|abort/i.test(msg);
        if (cancelled) {
          console.log('[Voice] Cancelled');
          cancelRecording();
          finishSession('cancel');
        } else {
          console.error('[Voice] Failed:', msg);
          cancelRecording();
          announce('error', reportVoiceError(msg));
          finishSession('error');
        }
      } finally {
        processingRef.current = false;
        abortRef.current = null;
      }
    };

    // Esc / cancel: abort any in-flight transcribe/translate, paste nothing, hide at once.
    const cancel = () => {
      cancelledRef.current = true;
      abortRef.current?.abort();
      cancelRecording();
      processingRef.current = false;
      finishSession('cancel');
    };

    // Begin a run: store the run context, start mic capture (+ VAD). Idempotent — a
    // duplicate 'voice-start' (main re-emits as cold-start insurance) is ignored while a
    // run is already active. The level meter is local; auto-stop calls process().
    const begin = async (payload: VoiceStartPayload) => {
      // Ignore a re-emit for a run we already began (the main window dupes 'voice-start' 250ms
      // later as cold-start insurance). Without this, cancelling within 250ms would let the stale
      // re-emit resurrect the run — opening the mic + muting the system in a now-hidden overlay.
      if (payload.sessionId === sessionIdRef.current) return;
      if (startedRef.current) return; // a run is already active
      sessionIdRef.current = payload.sessionId;
      // Cancel any pending hide from a just-finished session so it can't hide THIS overlay.
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
      startedRef.current = true;
      finishedRef.current = false;
      configRef.current = payload.config;
      {
        const cfg = payload.config;
        const eng = cfg.voiceSttEngine;
        setEngineTag(
          ['omnilingual-300m', 'whisper-turbo', 'parakeet-v3'].includes(eng) ? 'offline'
          : eng === 'groq' ? ((cfg.apiKeys.groq || '').trim() ? 'Groq' : 'server')
          : eng === 'openai' ? ((cfg.apiKeys.openai || '').trim() ? 'OpenAI' : 'server')
          : (cfg.apiKeys.groq || '').trim() ? 'Groq'
          : (cfg.apiKeys.openai || '').trim() ? 'OpenAI'
          : 'server'
        );
        // Surface a FORCED listening language ("· ID") — speaking English while From=Indonesia
        // makes Whisper indonesianize the speech; seeing the tag beats debugging it after.
        if (cfg.sourceLang && cfg.sourceLang !== 'auto') {
          setEngineTag((t) => `${t} · ${cfg.sourceLang.toUpperCase()}`);
        }
      }
      modeRef.current = payload.mode;
      targetAppRef.current = payload.targetApp || '';
      targetPosRef.current = payload.targetPos ?? null;
      processingRef.current = false;
      cancelledRef.current = false;
      // NOT 'recording' yet. Muting the system output and opening the microphone measured
      // ~525ms cold on this machine, and announcing "Listening…" up front told the user to
      // start talking during it — which is exactly why the first words went missing.
      announce('starting');
      setBars(EMPTY_BARS);
      // Start the mute WITHOUT awaiting it and open the microphone at the same time. The mute
      // only has to be finished before the first captured chunk, not before the mic opens, so
      // serialising the two was ~233ms of pure latency. beforeStart below re-imposes the order.
      muteSessionRef.current += 1;
      muteGateRef.current = setSystemMute(true);
      if (cancelledRef.current || finishedRef.current) { void restoreAudio(); return; }
      try {
        await startRecording({
          // Re-imposes the invariant the old serial await gave us for free: the speakers are
          // silenced before the recorder captures anything. It also replaces the cancel check
          // that used to sit after the mute await — throwing here aborts before the recorder
          // starts, instead of leaving a live mic in a hidden overlay.
          beforeStart: async () => {
            await muteGateRef.current;
            if (cancelledRef.current || finishedRef.current) throw new Error('cancelled during startup');
          },
          autoStop: payload.config.voiceAutoStop, // manual mode (false) -> stop only on re-press
          autoGain: payload.config.micAutoGain,   // AGC boosts quiet mics (fixes "No speech detected")
          maxMs: payload.config.voiceMaxMs,       // per-user recording cap from Settings
          silenceMs: payload.config.voiceSilenceMs, // auto-stop pause length from Settings
          deviceId: payload.config.micDeviceId,    // preferred microphone from Settings
          onDeviceLabel: (label) => { void emit('voice-mic-used', label); },
          onAutoStop: (reason) => {
            if (reason === 'nospeech') {
              cancelRecording();
              announce('error', 'No speech detected');
              finishSession('error'); // sets finishedRef -> blocks any late manual process()
            } else if (reason === 'maxed') {
              // Recording-cap hit: a TIMER verdict, not a VAD one. Process like a manual stop —
              // in auto mode the VAD summary is empty here by construction (no long pause ever
              // happened), so the no-speech guard would wrongly discard the whole dictation.
              void process(false);
            } else {
              void process(true); // VAD-decided stop -> apply the no-speech guard
            }
          },
          onLevel: (b) => { setBars(b); }, // local only — this window renders the bars
        });
        // Cancel may have landed while startRecording() was opening the mic (cancelRecording()
        // was then a no-op because the recorder didn't exist yet). Tear the now-live recorder down.
        if (cancelledRef.current || finishedRef.current) { cancelRecording(); void restoreAudio(); return; }
        // Capture is genuinely running now — this is the honest moment to invite speech, and
        // the elapsed timer should count from here rather than from the keypress.
        announce('recording');
        setRecStartedAt(Date.now()); // fresh ticker for THIS session (see the ticker effect below)
        if (payload.config.voiceSoundEnabled) { try { await invoke('play_sound', { soundType: 'start' }); } catch { /* */ } }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Voice] Could not start recording:', msg);
        cancelRecording();
        announce('error', reportVoiceError(msg));
        finishSession('error');
      }
    };

    const unStart = listen<VoiceStartPayload>('voice-start', (e) => { void begin(e.payload); });
    // Manual finish from the main window's re-pressed shortcut.
    const unStop = listen('voice-stop', () => {
      // A stop with NO active run means the main window's isRecording flag is stuck (it
      // missed a 'voice-finished') and this press was swallowed as a no-op "stop". Re-emit
      // 'voice-finished' so the flag self-heals and the NEXT press starts a fresh recording
      // — instead of voice staying dead until the multi-minute watchdog fires.
      if (finishedRef.current || !startedRef.current) { void emit('voice-finished'); return; }
      if (!processingRef.current) void process();
    });
    const unCancel = listen('voice-cancel', () => { cancel(); });

    // Done/Cancel buttons + Enter/Esc keys: call the local handlers directly now
    // (no more 'voice-action' round-trip through the main window).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (!processingRef.current) void process(); }
    };
    window.addEventListener('keydown', onKey);

    // Expose the handlers to the buttons (rendered below) via refs.
    processHandlerRef.current = () => { if (!processingRef.current) void process(); };
    cancelHandlerRef.current = cancel;

    return () => {
      unStart.then((f) => f());
      unStop.then((f) => f());
      unCancel.then((f) => f());
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Elapsed-time ticker: long dictation needs visible feedback that the recording is still
  // live, and how long it has run. Keyed on recStartedAt — NOT just `status` — because after a
  // cancel the status can stay 'recording' (finishSession doesn't announce), so a status-only
  // effect would keep the previous session's interval + start time running into the next run.
  const [elapsed, setElapsed] = useState(0);
  const [recStartedAt, setRecStartedAt] = useState(0);
  // One-word engine tag shown next to the status ("· offline" / "· Groq" / "· server") —
  // the INTENDED engine at start; a mid-process fallback is reported via console/Settings.
  const [engineTag, setEngineTag] = useState('');
  useEffect(() => {
    if (status !== 'recording' || !recStartedAt) { setElapsed(0); return; }
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - recStartedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [status, recStartedAt]);
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  // Idle shimmer so bars never look frozen before the first signal.
  useEffect(() => {
    if (status !== 'recording' || !recStartedAt) {
      if (idleRef.current) { clearInterval(idleRef.current); idleRef.current = null; }
      return;
    }
    idleRef.current = setInterval(() => {
      setBars((prev) => prev.map((v, i) => (v < 0.06 ? 0.05 + Math.abs(Math.sin(Date.now() / 220 + i)) * 0.08 : v)));
    }, 120);
    return () => { if (idleRef.current) clearInterval(idleRef.current); idleRef.current = null; };
  }, [status, recStartedAt]);

  const recording = status === 'recording';
  const icon = recording ? null
    : status === 'done' ? <Check size={15} className="text-green-400" />
    : status === 'error' ? <X size={15} className="text-red-400" />
    : <Loader2 size={15} className="text-blue-400 animate-spin" />;

  const processing = status === 'transcribing' || status === 'translating' || status === 'pasting';
  const busy = recording || processing; // cancel (Esc) is available the whole time

  return (
    <div className="relative h-screen w-screen flex items-center justify-between bg-[#1c1c1e] overflow-hidden pl-2.5 pr-2 gap-2 select-none">
      {/* Tilted logo watermark — a "tattoo" across the pill. Deliberately above everything
          (so it reads as one overlay, not a background) but at ~7% opacity, and clipped by
          the pill edges. absolute + pointer-events-none: it must never take layout space or
          swallow a click meant for the ✓/✗ buttons underneath. */}
      <img
        src={logoMark}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="vt-watermark pointer-events-none absolute right-1 top-1/2 z-20 h-[58px] w-[58px] select-none"
      />
      <div className="flex items-center gap-2 min-w-0">
        {recording ? (
          <div className="flex items-end gap-[3px] h-4 shrink-0">
            {bars.map((b, i) => (
              <span
                key={i}
                className="w-[3px] rounded-full bg-red-500"
                style={{ height: `${Math.max(15, Math.min(100, b * 100))}%`, transition: 'height 70ms ease-out' }}
              />
            ))}
          </div>
        ) : (
          <span className="shrink-0">{icon}</span>
        )}
        <span className={`text-[11px] font-medium leading-normal truncate py-0.5 ${status === 'error' ? 'text-red-300' : 'text-white/85'}`}>
          {message}
        </span>
        {recording && elapsed > 0 && (
          <span className="text-[10px] text-white/40 tabular-nums shrink-0">{elapsedLabel}</span>
        )}
        {recording && engineTag && (
          <span className="text-[10px] text-white/30 shrink-0" title={`Mesin transkripsi: ${engineTag}`}>· {engineTag}</span>
        )}
      </div>

      {busy ? (
        <div className="flex items-center gap-1.5 shrink-0">
          {/* ✓ = finish -> transcribe & paste (click, Enter, or re-press shortcut) */}
          {recording && (
            <button
              type="button"
              onClick={() => processHandlerRef.current()}
              title="Done — Enter, or press the voice shortcut again (works from any app)"
              aria-label="Done"
              className="flex items-center justify-center w-6 h-6 rounded-md bg-green-500/20 hover:bg-green-500/35 text-green-300 leading-none cursor-pointer transition-colors"
            >
              <Check size={14} />
            </button>
          )}
          {/* ✗ = cancel (pastes nothing) — click or Esc */}
          <button
            type="button"
            onClick={() => cancelHandlerRef.current()}
            title="Cancel (Esc)"
            aria-label="Cancel (Esc)"
            className="flex items-center justify-center w-6 h-6 rounded-md bg-red-500/20 hover:bg-red-500/35 text-red-300 leading-none cursor-pointer transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        // The watermark now carries the branding, so the idle state no longer needs a logo
        // occupying a flex slot. Keeps the pill the same width in every state.
        <span className="w-4 shrink-0" />
      )}
    </div>
  );
}
