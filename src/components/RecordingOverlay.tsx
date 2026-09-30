import { useEffect, useState, useRef } from 'react';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, Check, X } from 'lucide-react';
import { VoiceStatus, VoiceMode } from '@/types';
import { VOICE_STATUS_MESSAGES, VOICE_BAR_COUNT, MAX_TRANSLATE_CHARS, VOICE_AUTODETECT_FALLBACK_LANG } from '@/utils/constants';
import { startRecording, stopRecording, cancelRecording, micDeliveredNoSignal, micLevelSummary, isVirtualInput } from '@/services/audioRecorder';
import { onLiveTranscript } from '@/services/sttStream';
import { LiveSession } from '@/services/liveSession';
import { LiveEditor } from '@/services/liveEditor';
import { transcribe, prewarmTranscription } from '@/services/transcription';
import { translateText } from '@/services/openai';
import { setClipboardText } from '@/services/clipboard';
import { simulatePasteToApp } from '@/services/keyboard';
import { cleanupTranscript } from '@/services/openai';
import { blobToPcm16kBase64 } from '@/utils/pcm';
import type { VoiceStartPayload } from '@/hooks/useVoiceInput';
import { applyVoiceCorrections } from '@/utils/voiceCorrections';
import { notify } from '@/services/notify';
import { diag, errorKind } from '@/services/diag';
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

// The overlay is a small one-line box: long error sentences use a short glanceable label.
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

// "You were quiet" vs "macOS is not letting us hear you". Without an Apple certificate every
// update silently revokes the microphone grant while System Settings still shows it ON; the
// mic then delivers silence, so blaming the user's voice would be wrong far more often than
// it is right. Used by EVERY no-speech exit: the silent-mic case lands on the VAD and server
// no-speech paths far more often than on the empty-text one.
// The input heard almost nothing for several seconds (wrong input device, or input volume at
// the bottom). Diagnostics AEUG7PST: 5-14 s dictations each held ~1 s of sound, the start
// chime, and Whisper returned a few garbage characters.
function micHearsNothing(): boolean {
  const m = micLevelSummary();
  return m.heardMs >= 3000 && m.loudMs < 250;
}

let quietMicWarnedAt = 0;
function warnQuietMic(): void {
  if (Date.now() - quietMicWarnedAt < 10 * 60_000) return; // at most once per 10 minutes
  quietMicWarnedAt = Date.now();
  void notify(
    'Your microphone barely hears you',
    'Check System Settings › Sound › Input: pick your microphone and watch the level move while you speak. You can also choose the microphone in VibeTranslate › Settings › Voice.',
  );
}

async function noSpeechReason(): Promise<string> {
  // Exact digital silence: macOS reports the grant as fine but hands us a dead microphone.
  // Seen right after an update changed the app's signature; only re-granting fixes it.
  if (micDeliveredNoSignal()) {
    diag('voice', 'mic delivered exact silence (permission tied to an old signature?)');
    void notify(
      'Microphone gives no audio',
      'macOS is blocking the microphone for VibeTranslate. Open System Settings › Privacy & Security › Microphone, turn VibeTranslate off and on again, then retry.',
    );
    void invoke('open_microphone_settings').catch(() => {});
    return 'Mic permission blocked — re-allow';
  }
  if (micHearsNothing()) {
    diag('voice', 'microphone heard almost nothing (wrong input device or input volume?)');
    warnQuietMic();
    return 'Mic hears almost nothing — check input';
  }
  try {
    const p = await invoke<{ microphone: string }>('permission_status');
    if (p.microphone === 'denied') return 'Microphone blocked — re-grant it in System Settings';
    if (p.microphone === 'restricted') return 'Microphone restricted by device policy';
    if (p.microphone === 'undetermined') return 'Microphone permission not granted yet';
  } catch { /* status is a nicety; never let it swallow the real outcome */ }
  return 'No speech detected';
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
  const recStartedAtRef = useRef(0);
  const livePartialsRef = useRef(0);               // partial results received this dictation (diagnostics)              // capture start, for the diagnostics duration
  const captureLiveRef = useRef(false);           // the recorder is actually capturing (set after startRecording)
  const pendingStopRef = useRef(false);           // a stop arrived during 'starting'; run it once capture is live

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
    if (liveRef.current) {
      liveRef.current.cancel();
      liveRef.current = null;
    }
    editorRef.current.reset();
    void emitTo('transcript', 'transcript-view', { committed: '', live: '', keys: false }).catch(() => {});
    setLiveText('');
    transcriptShownRef.current = false;
    void invoke('hide_transcript').catch(() => { /* cosmetic */ });
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

  // Partial transcripts from the streaming recogniser. Subscribed once for the window's life:
  // the overlay is pre-created and reused for every session, so re-subscribing per session
  // would leak listeners.
  useEffect(() => {
    let un: (() => void) | undefined;
    onLiveTranscript((p) => {
      if (!liveRef.current?.isActive || p.isFinal) return;
      livePartialsRef.current++;
      if (editorRef.current.onPartial(p.text, p.seg)) publishView();
    }).then((f) => { un = f; });
    return () => { un?.(); };
  }, []);

  // --- The voice lifecycle (ported from the old main-window useVoiceInput hook) ---
  useEffect(() => {
    // Live editing (Backspace / Cmd-Backspace / Cmd-Z while dictating live). Edits run one at a
    // time: each one first freezes the current segment (a round-trip to the recogniser), and a
    // second Backspace must see the text the first one left behind.
    let editChain: Promise<void> = Promise.resolve();
    const edit = (op: 'word' | 'all' | 'undo') => {
      editChain = editChain.then(async () => {
        const session = liveRef.current;
        if (!session?.isActive || processingRef.current || finishedRef.current || !captureLiveRef.current) return;
        const ed = editorRef.current;
        if (op !== 'undo') {
          const r = await session.commit();
          // The dictation ended or was cancelled while freezing; this edit is moot.
          // (process() waits for this chain before it detaches the session, so a finish
          // never loses the text frozen here.)
          if (liveRef.current !== session) return;
          ed.absorb(r.text, r.seg);
        }
        if (op === 'word') ed.deleteWord();
        else if (op === 'all') ed.clearAll();
        else ed.undo();
        diag('live', `edit ${op}`);
        publishView();
      }).catch((e) => { console.warn('[Voice] live edit failed:', e); });
      return editChain;
    };

    // Finish + paste: stop recording, transcribe, (optionally translate), paste.
    const process = async (auto = false) => {
      if (processingRef.current || finishedRef.current) return; // never run after a terminal state
      const config = configRef.current;
      if (!config) return;
      // A stop that arrives before the microphone is live (quick push-to-talk tap, Enter during
      // "Starting…") had no recorder to stop: it errored with "No active recording", or hung
      // waiting for a 'stop' event from a recorder that had not started. Run it once capture is up.
      if (!captureLiveRef.current) { pendingStopRef.current = true; return; }
      // Every ref below is shared by all sessions, and begin() resets them for the next one. A
      // run that was cancelled while awaiting something that cannot be aborted (local model,
      // live finish, PCM conversion) would otherwise wake up inside the NEXT session, paste its
      // stale text there and end the new recording. Compare against the session it started in.
      const runId = sessionIdRef.current;
      const stale = () => cancelledRef.current || sessionIdRef.current !== runId;
      processingRef.current = true;
      cancelledRef.current = false;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        announce('transcribing');
        const { blob, voicedMs, hadSpeech } = await stopRecording();
        if (sessionIdRef.current !== runId) return;
        const tStt = performance.now();
        const lvl = micLevelSummary();
        diag('voice', `stop ${auto ? 'auto' : 'manual'} rec=${recStartedAtRef.current ? ((Date.now() - recStartedAtRef.current) / 1000).toFixed(1) : '?'}s audio=${Math.round(blob.size / 1024)}KB voiced=${Math.round(voicedMs)}ms level loud=${lvl.loudMs}ms/${lvl.heardMs}ms peak=${lvl.peak}`);
        // Even when something gets transcribed, a near-silent input usually means garbage text
        // from the start chime or the room: tell the user where to look.
        if (micHearsNothing()) {
          diag('voice', 'microphone heard almost nothing during this dictation');
          warnQuietMic();
        }
        void restoreAudio(); // recording done -> restore audio right away
        // The transcript window's job ended with the recording. Leaving it up while the paste
        // pipeline runs made the whole feature look like it was still listening.
        setLiveText('');
        void invoke('hide_transcript').catch(() => { /* cosmetic */ });

        // Min-duration guard: only trust the VAD's "no speech" when THIS stop was the VAD's own
        // decision (auto). On a MANUAL finish (Done / Enter / re-press) the user stopped on
        // purpose — and with Silero active `voicedMs` can still be 0 because onSpeechEnd hasn't
        // fired yet — so never block; send it and let the Whisper hallucination filter handle a
        // truly silent clip. (Previously keyed off the auto-stop *config*, which wrongly discarded
        // real speech when the user hit Done before Silero closed the segment.)
        if (auto && (!hadSpeech || voicedMs < 400)) {
          const reason = await noSpeechReason();
          diag('voice', `no speech (auto): ${reason}`);
          if (stale()) return;
          announce('error', reason);
          finishSession('error');
          return;
        }

        // Spoken language for Whisper = the translation source ("From"). 'auto' = detect;
        // transcribe() guards a wrong (JP/CN) auto-detect by retrying with the fallback.
        // Experimental offline engine (Settings > Voice). Falls back to the online
        // path on ANY local failure — with a console warning, never silently worse
        // than before the feature existed.
        let rawTranscript: string;
        // Which path produced the text, for the diagnostics log.
        let sttPath = ['omnilingual-300m', 'whisper-turbo', 'parakeet-v3'].includes(config.voiceSttEngine) ? 'offline' : 'online';
        // Detach the live session on EVERY branch, not just the active one. A session whose
        // model was still loading when the user stopped used to stay referenced through the
        // whole transcribe→translate→paste pipeline; when the load finally resolved it went
        // active, drained 30s of queued audio, and popped the transcript window back open
        // mid-paste replaying the finished sentence.
        // An edit still freezing its segment must land first, or its text would be lost.
        await editChain;
        const liveSession = liveRef.current;
        liveRef.current = null;
        if (liveSession && !liveSession.isActive) {
          // Startup may still be in flight; a late resolve must find a cancelled session,
          // not one it can activate. The recording blob below still has the full audio.
          liveSession.cancel();
        }
        if (liveSession?.isActive) {
          // The text has been accumulating the whole time the user was speaking; finishing
          // flushes the recogniser's look-ahead and returns the final version. The recogniser
          // shouts (its vocabulary is upper case) — fix that before ANYTHING else touches the
          // text, because corrections, cleanup, translation and the paste are all downstream.
          const liveFinal = editorRef.current.finalText(await liveSession.finish());
          diag('live', `partials=${livePartialsRef.current} final chars=${liveFinal.length}`);
          rawTranscript = liveFinal;
          sttPath = 'live';
          // Hybrid: the on-device model is instant but has no punctuation and mishears more
          // than Whisper. When the user's engine is an online one anyway (so uploading the audio
          // is what they already chose) and they made no edits, re-transcribe the whole
          // recording and paste that instead. Bounded, and any failure keeps the live text:
          // this step can only improve the result, never lose it. Edited text always wins,
          // because a fresh transcript would bring the deleted words back.
          const onlineEngine = !['omnilingual-300m', 'whisper-turbo', 'parakeet-v3'].includes(config.voiceSttEngine);
          // Also when the live text is EMPTY: that is exactly when the live model failed to hear
          // anything, and requiring live text first turned a working recording into "No speech
          // detected" (diagnostics 3TS3SKQK: every live run chars=0, every normal run fine).
          if (onlineEngine && !editorRef.current.edited && blob.size > 0) {
            const hc = new AbortController();
            const onAbort = () => hc.abort();
            controller.signal.addEventListener('abort', onAbort, { once: true });
            const timer = setTimeout(() => hc.abort(), 5000);
            try {
              const better = await transcribe({
                blob,
                provider: config.provider,
                apiKeys: config.apiKeys,
                preferProvider: config.voiceSttEngine,
                language: config.sourceLang || 'auto',
                fallbackLanguage: VOICE_AUTODETECT_FALLBACK_LANG,
                signal: hc.signal,
              });
              if (better.trim()) { rawTranscript = better; sttPath = liveFinal.trim() ? 'live+whisper' : 'live-empty->whisper'; }
            } catch (e) {
              if (controller.signal.aborted) throw e; // user cancelled: not a fallback case
              console.warn('[Voice] live: whole-recording pass failed, keeping live text:', e);
              diag('stt', `live: whole-recording pass skipped (${errorKind(String(e))}), kept live text`);
            } finally {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', onAbort);
            }
          }
        } else if (['omnilingual-300m', 'whisper-turbo', 'parakeet-v3'].includes(config.voiceSttEngine)) {
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
        if (stale()) return;
        diag('stt', `${sttPath} ok ${Math.round(performance.now() - tStt)}ms chars=${rawTranscript.length}`);
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
          if (stale()) return;
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

        if (stale()) return; // cancelled during the pipeline -> paste nothing

        // Nothing to paste is an outcome, not a success: without this, a silent dictation
        // wrote '' to the clipboard (destroying whatever the user had there), pasted
        // nothing, and played the success chime.
        if (!out.trim()) {
          const reason = await noSpeechReason();
          diag('voice', `empty result: ${reason}`);
          if (stale()) return;
          announce('error', reason);
          finishSession('error');
          return;
        }

        announce('pasting');
        await setClipboardText(out);
        await sleep(120);
        await simulatePasteToApp(targetAppRef.current || '', targetPosRef.current);

        diag('voice', `pasted chars=${out.length} mode=${modeRef.current}`);
        if (config.voiceSoundEnabled) { try { await invoke('play_sound', { soundType: 'success' }); } catch { /* */ } }
        announce('done');
        finishSession('done');
      } catch (err) {
        // A newer session owns the recorder and the overlay now: touching either would end it.
        if (sessionIdRef.current !== runId) return;
        const msg = err instanceof Error ? err.message : String(err);
        const cancelled = cancelledRef.current
          || (err instanceof DOMException && err.name === 'AbortError')
          || /cancel|abort/i.test(msg);
        if (cancelled) {
          diag('voice', 'cancelled');
          console.log('[Voice] Cancelled');
          cancelRecording();
          finishSession('cancel');
        } else if (/no speech/i.test(msg)) {
          diag('voice', 'no speech (server)');
          // Server 422 / empty transcript: same silent-mic question as the other no-speech exits.
          cancelRecording();
          const reason = await noSpeechReason();
          if (sessionIdRef.current !== runId) return;
          announce('error', reason);
          finishSession('error');
        } else {
          console.error('[Voice] Failed:', msg);
          diag('voice', `failed: ${errorKind(msg)}`);
          cancelRecording();
          announce('error', reportVoiceError(msg));
          finishSession('error');
        }
      } finally {
        if (sessionIdRef.current === runId) {
          processingRef.current = false;
          abortRef.current = null;
        }
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
          cfg.voiceLiveMode ? 'live'
          : ['omnilingual-300m', 'whisper-turbo', 'parakeet-v3'].includes(eng) ? 'offline'
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
      captureLiveRef.current = false;
      pendingStopRef.current = false;
      // This run is over once cancelled OR once a newer session replaced it. The shared refs
      // alone cannot say which run they describe: cancel + an immediate re-press resets them
      // before this run's microphone request has even returned.
      const mySession = payload.sessionId;
      const gone = () => cancelledRef.current || finishedRef.current || sessionIdRef.current !== mySession;
      // Play the start chime BEFORE muting: afplay goes through the system output, so a chime
      // started after the mute was never heard.
      if (payload.config.voiceSoundEnabled) void invoke('play_sound', { soundType: 'start' }).catch(() => {});
      // NOT 'recording' yet. Muting the system output and opening the microphone measured
      // ~525ms cold on this machine, and announcing "Listening…" up front told the user to
      // start talking during it — which is exactly why the first words went missing.
      announce('starting');
      setBars(EMPTY_BARS);
      // Start the mute WITHOUT awaiting it and open the microphone at the same time. The mute
      // only has to be finished before the first captured chunk, not before the mic opens, so
      // serialising the two was ~233ms of pure latency. beforeStart below re-imposes the order.
      // Warm the connection to the transcription server now, while the user speaks, so the
      // request at the end skips the TLS handshake (the step measured stalling on flaky
      // networks). Offline engines never contact it.
      if (!['omnilingual-300m', 'whisper-turbo', 'parakeet-v3'].includes(payload.config.voiceSttEngine)) {
        prewarmTranscription();
      }
      // Live dictation. All the startup/queueing subtleties live in LiveSession — see the
      // header comment there before changing the ordering here.
      const wantLive = !!payload.config.voiceLiveMode;
      const tBegin = Date.now();
      diag('voice', `start mode=${payload.mode} engine=${payload.config.voiceSttEngine} live=${wantLive} hold=${!!payload.config.holdToTalk} autostop=${payload.config.voiceAutoStop}`);
      // Dev scaffolding: Vite replaces import.meta.env.DEV with a literal, so this whole line
      // is removed from production bundles rather than firing an IPC call users never see the
      // output of.
      if (import.meta.env.DEV) {
        void invoke('dev_log', { msg: `voice-start wantLive=${wantLive} engine=${payload.config.voiceSttEngine} mic=${payload.config.micDeviceId || 'default'} boost=${payload.config.micAutoGain}` }).catch(() => {});
      }
      liveRef.current = null;
      editorRef.current.reset();
      livePartialsRef.current = 0;
      setLiveText('');
      if (wantLive) {
        const session = new LiveSession();
        liveRef.current = session;
        session.begin((e) => {
          if (import.meta.env.DEV) void invoke('dev_log', { msg: `live unavailable: ${e}` }).catch(() => {});
          console.warn('[Voice] live mode unavailable, using one-shot transcription:', e);
          diag('live', `unavailable, using one-shot: ${errorKind(String(e))}`);
          // Only detach OUR session: a stale rejection from a previous press must not
          // kill the live mode of the session that replaced it.
          if (liveRef.current === session) liveRef.current = null;
        });
      }

      muteSessionRef.current += 1;
      muteGateRef.current = setSystemMute(true);
      if (gone()) { void restoreAudio(); return; }
      try {
        await startRecording({
          // Re-imposes the invariant the old serial await gave us for free: the speakers are
          // silenced before the recorder captures anything. It also replaces the cancel check
          // that used to sit after the mute await — throwing here aborts before the recorder
          // starts, instead of leaving a live mic in a hidden overlay.
          beforeStart: async () => {
            await muteGateRef.current;
            if (gone()) throw new Error('cancelled during startup');
          },
          autoStop: payload.config.voiceAutoStop, // manual mode (false) -> stop only on re-press
          autoGain: payload.config.micAutoGain,   // AGC boosts quiet mics (fixes "No speech detected")
          maxMs: payload.config.voiceMaxMs,       // per-user recording cap from Settings
          silenceMs: payload.config.voiceSilenceMs, // auto-stop pause length from Settings
          deviceId: payload.config.micDeviceId,    // preferred microphone from Settings
          onDeviceLabel: (label) => {
            void emit('voice-mic-used', label);
            // Device names only ("MacBook Air Microphone", "BlackHole 2ch"): what the recording
            // actually listened to is the first thing to know when a voice report comes in.
            diag('audio', `input: ${label}${isVirtualInput(label) ? ' (virtual/loopback device)' : ''}${payload.config.micDeviceId ? ' (chosen in Settings)' : ' (system default)'}`);
          },
          onDeviceFallback: (from, to) => {
            diag('audio', `system input "${from}" is a loopback device; used "${to}" instead`);
            void notify(
              `Using ${to}`,
              `Your Mac's input is set to "${from}", which records the computer's own sound rather than your voice. VibeTranslate used ${to} instead. To choose permanently: Settings › Voice › Microphone.`,
            );
          },
          onAutoStop: (reason) => {
            if (reason === 'nospeech') {
              cancelRecording();
              processingRef.current = true; // block a late manual process() while the status resolves
              void noSpeechReason().then((why) => {
                if (sessionIdRef.current !== mySession || finishedRef.current) return; // cancelled meanwhile
                processingRef.current = false;
                announce('error', why);
                finishSession('error');
              });
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
          onPcmChunk: wantLive ? (pcm) => liveRef.current?.feed(pcm) : undefined,
        });
        // Cancel may have landed while startRecording() was opening the mic (cancelRecording()
        // was then a no-op because the recorder didn't exist yet). Tear the now-live recorder down.
        if (gone()) {
          // Only tear down a recorder that is still ours; a newer session's must survive.
          if (sessionIdRef.current === mySession) { cancelRecording(); void restoreAudio(); }
          return;
        }
        // Capture is genuinely running now — this is the honest moment to invite speech, and
        // the elapsed timer should count from here rather than from the keypress.
        captureLiveRef.current = true;
        diag('voice', `capturing after ${Date.now() - tBegin}ms`);
        announce('recording');
        recStartedAtRef.current = Date.now();
        setRecStartedAt(recStartedAtRef.current); // fresh ticker for THIS session (see the ticker effect below)
        if (pendingStopRef.current) { pendingStopRef.current = false; void process(); }
      } catch (err) {
        if (sessionIdRef.current !== mySession || cancelledRef.current) return; // superseded or cancelled: not an error
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Voice] Could not start recording:', msg);
        diag('voice', `could not start recording: ${errorKind(msg)}`);
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
      // Live edits. This window holds the keyboard while recording, so these never reach the
      // app being dictated into.
      else if (e.key === 'Backspace') { e.preventDefault(); void edit(e.metaKey || e.ctrlKey ? 'all' : 'word'); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); void edit('undo'); }
    };
    window.addEventListener('keydown', onKey);
    // The same keys pressed while the transcript window holds focus.
    const unEdit = listen<'word' | 'all' | 'undo'>('voice-edit', (e) => { void edit(e.payload); });

    // Expose the handlers to the buttons (rendered below) via refs.
    processHandlerRef.current = () => { if (!processingRef.current) void process(); };
    cancelHandlerRef.current = cancel;

    return () => {
      unStart.then((f) => f());
      unStop.then((f) => f());
      unCancel.then((f) => f());
      unEdit.then((f) => f());
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
  // Provisional text while speaking. Kept separate from `message` so the status line and the
  // transcript never fight over the same slot.
  const [liveText, setLiveText] = useState('');
  const liveRef = useRef<LiveSession | null>(null);
  const editorRef = useRef(new LiveEditor());
  // One source of truth for what the transcript window shows: frozen (editable) text and the
  // part still being recognised, plus whether edit keys will actually reach us right now.
  const publishView = () => {
    const v = editorRef.current.view();
    setLiveText(v.full);
    void emitTo('transcript', 'transcript-view', {
      committed: v.committed,
      live: v.live,
      keys: document.hasFocus(),
      finishKey: configRef.current?.finishKey || '',
      holdToTalk: !!configRef.current?.holdToTalk,
    }).catch(() => { /* cosmetic */ });
  };
  // Focus moving to or from this window changes what the hint row should say (edit keys vs
  // "still recording, how to finish"), so republish then too, not only on new words.
  useEffect(() => {
    const refresh = () => { if (liveRef.current?.isActive) publishView(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('blur', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('blur', refresh);
    };
  }, []);

  // The transcript lives in its OWN window below this one (see TranscriptOverlay). Growing
  // this pill to fit a sentence pushed the text over the level bars and the done/cancel
  // buttons — the things being watched while speaking.
  //
  // Shown ONCE per session, not on every text change. This effect used to run show_transcript
  // on each partial — five times a second — and macOS re-showing an already-visible window
  // makes it flicker. That was the "coarse, rewriting-from-scratch blink": the WINDOW was
  // blinking, not the text.
  const transcriptShownRef = useRef(false);
  useEffect(() => {
    if (liveText.trim().length > 0 && !transcriptShownRef.current) {
      transcriptShownRef.current = true;
      void invoke('show_transcript').catch(() => { /* cosmetic */ });
    }
  }, [liveText]);
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
    <div className="relative flex h-screen w-screen items-center justify-between gap-1.5 overflow-hidden bg-[#1c1c1e] px-2.5 select-none">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <img
            src={logoMark}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="relative h-5 w-5 select-none object-contain opacity-90"
          />
        {recording ? (
          <div className="ml-1.5 flex h-4 shrink-0 items-end gap-[3px]">
            {bars.map((b, i) => (
              <span
                key={i}
                className="w-[3px] rounded-full bg-red-500"
                style={{ height: String(Math.max(15, Math.min(100, b * 100))) + '%', transition: 'height 70ms ease-out' }}
              />
            ))}
          </div>
        ) : (
          <span className="shrink-0">{icon}</span>
        )}
        <span className={'mx-1 min-w-[52px] flex-1 overflow-hidden whitespace-nowrap py-0.5 text-[11px] font-medium leading-normal ' + (status === 'error' ? 'text-red-300' : 'text-white/85')}>
          {message}
        </span>
        {recording && (
          <span className="flex w-[70px] shrink-0 items-center gap-1.5 text-[10px] text-white/40">
            <span className="w-7 shrink-0 text-right tabular-nums">{elapsedLabel}</span>
            {engineTag && (
              <>
                <span className="h-3 w-px shrink-0 bg-white/15" aria-hidden="true" />
                <span className="min-w-0 truncate text-[9px] text-white/30" title="Transcription engine">{engineTag}</span>
              </>
            )}
          </span>
        )}
      </div>

      {busy ? (
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-black/20 p-0.5 shadow-inner">
          {/* ✓ = finish -> transcribe & paste (click, Enter, or re-press shortcut) */}
          {recording && (
            <button
              type="button"
              onClick={() => processHandlerRef.current()}
              title="Done — Enter, or press the voice shortcut again (works from any app)"
              aria-label="Done"
              className="vt-action-button vt-action-button-done flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-emerald-200 transition-all duration-150 active:scale-90"
            >
              <Check size={14} strokeWidth={2.5} />
            </button>
          )}
          {/* ✗ = cancel (pastes nothing) — click or Esc */}
          <button
            type="button"
            onClick={() => cancelHandlerRef.current()}
            title="Cancel (Esc)"
            aria-label="Cancel (Esc)"
            className="vt-action-button vt-action-button-cancel flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-rose-200 transition-all duration-150 active:scale-90"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>
      ) : (
        <span className="w-4 shrink-0" />
      )}
    </div>
  );
}
