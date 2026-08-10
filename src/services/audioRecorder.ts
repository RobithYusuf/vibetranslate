// Microphone capture (MediaRecorder) + adaptive Voice Activity Detection.
//
// VAD runs inside a ScriptProcessorNode.onaudioprocess callback (driven by the
// audio engine, so it keeps firing even when the host window is hidden — unlike
// setInterval, which the OS throttles in background windows).
//
// Detection is RELATIVE, not a fixed threshold: a slow EMA tracks the ambient/
// music "floor"; the (closer, louder, fluctuating) voice is detected above it via
// level + spectral-flux confirmation. End-of-utterance fires when the level
// returns near the floor AND flux collapses — so it auto-stops even while music
// keeps playing. Designed + adversarially verified (see docs/superpowers/plans).

import {
  MAX_RECORDING_MS,
  VOICE_BAR_COUNT,
  VAD_CALIB_MS,
  VAD_ONSET_MS,
  VAD_HANGOVER_MS,
  VAD_NO_SPEECH_TIMEOUT_MS,
  VAD_MIN_UTTERANCE_MS,
  VAD_FLUX_RECENCY_MS,
  VAD_FLOOR_ALPHA_UP,
  VAD_FLOOR_ALPHA_DOWN,
  VAD_FLOOR_CALIB_ALPHA,
  VAD_FLOOR_MIN,
  VAD_LEVEL_ATTACK,
  VAD_LEVEL_RELEASE,
  VAD_ON_RATIO,
  VAD_ON_ABS_MARGIN,
  VAD_OFF_RATIO,
  VAD_OFF_ABS_MARGIN,
  VAD_ABS_MIN,
  VAD_ANALYSER_SMOOTHING,
  VAD_FLUX_EMA,
  VAD_FLUX_BASE_UP,
  VAD_FLUX_BASE_DOWN,
  VAD_FLUX_FACTOR,
  VAD_FLUX_LO_HZ,
  VAD_FLUX_HI_HZ,
  VAD_FLUX_STD_K,
  VAD_FLUX_CONFIRM_MS,
  VAD_HPF_HZ,
  VAD_HPF_Q,
  VAD_SILERO_ENABLED,
  VAD_SILERO_REDEMPTION_MS,
  VAD_SILERO_MIN_SPEECH_MS,
  VAD_SILERO_PRESPEECH_PAD_MS,
  VAD_SILERO_POSITIVE_THRESHOLD,
  VAD_SILERO_NEGATIVE_THRESHOLD,
  MIC_BOOST_GAIN,
} from '@/utils/constants';
import { MicVAD } from '@ricky0123/vad-web';

export type AutoStopReason = 'silence' | 'nospeech' | 'maxed';

interface StartOptions {
  /// Called with ~200ms of 16kHz mono PCM16 while recording, for live transcription. Tapped
  /// AFTER the gain/limiter so the live text hears exactly the audio the final recording
  /// contains — tapping the raw mic instead would make the preview disagree with the result.
  onPcmChunk?: (pcm: Int16Array) => void;
  // Awaited immediately before the recorder starts capturing, and allowed to throw to abort.
  // The caller uses it to keep "system output is muted before the first chunk" true while
  // doing the mute concurrently with opening the microphone, and to bail if the user
  // cancelled during startup — a cancel that lands earlier can't stop a recorder that does
  // not exist yet, which used to leave a live microphone in a hidden overlay.
  beforeStart?: () => Promise<void>;
  onAutoStop?: (reason: AutoStopReason) => void;
  onLevel?: (bars: number[]) => void;
  // false = manual mode: VAD never auto-stops (user stops by re-pressing the
  // shortcut). The bars/level meter still run. The maxMs cap (below) still applies
  // so a forgotten recording can't run forever.
  autoStop?: boolean;
  // Single user-facing mic knob ("Boost quiet mic"). ON = apply a real software gain
  // (Web Audio GainNode) to the RECORDED audio so a soft mic is actually captured —
  // the usual fix for "No speech detected". We don't use the browser autoGainControl
  // constraint (WKWebView ignores it). Default ON. Noise suppression stays always-on.
  autoGain?: boolean;
  // Per-user recording cap in ms (Settings > Voice > Max recording length). Falls back to
  // MAX_RECORDING_MS. The cap always applies — even manual mode — because system audio stays
  // muted while recording, so a forgotten session must eventually stop.
  maxMs?: number;
  // AUTO-STOP only: how long a pause (ms) ends the utterance. Drives the Silero redemption
  // window directly; the energy fallback stays +700ms more patient (it's less accurate).
  silenceMs?: number;
  // Preferred microphone (MediaDeviceInfo.deviceId). '' / undefined = system default.
  // If the device is unavailable at record time we fall back to the default.
  deviceId?: string;
  // Reports the label of the microphone ACTUALLY captured (ground truth from the audio
  // track) — surfaces "which mic is the system default right now" in Settings.
  onDeviceLabel?: (label: string) => void;
}

let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let chunks: Blob[] = [];
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

// Separate AudioContext that applies the software "boost" gain to the RECORDED path
// only (raw stream still feeds the VAD/meter untouched). null when boost is off.
let boostContext: AudioContext | null = null;
let pcmTap: ScriptProcessorNode | null = null;


/**
 * Attach the live-dictation PCM tap to a node in an audio graph. Resampled to 16kHz here
 * rather than in Rust: the recogniser wants 16k, and doing it once at the source keeps every
 * chunk a whole number of samples. Lives OUTSIDE the boost graph on purpose — it used to be
 * nested inside `if (boost)`, so turning Mic boost off silently starved live dictation of
 * every sample: the session went active, heard nothing, and finished empty.
 */
function attachPcmTap(
  ctx: AudioContext,
  from: AudioNode,
  onPcmChunk: (pcm: Int16Array) => void,
): ScriptProcessorNode {
  const inRate = ctx.sampleRate;
  const node = ctx.createScriptProcessor(4096, 1, 1);
  let carry: number[] = [];
  const RATIO = inRate / 16000;
  node.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0);
    // Cheap decimation with a fractional cursor. Good enough for ASR features, and far
    // cheaper than an OfflineAudioContext resample on every 85ms block.
    for (let i = 0; i < input.length; i += RATIO) {
      carry.push(input[Math.floor(i)]);
    }
    // ~200ms at 16kHz. Smaller chunks mean more IPC for no perceptible gain; larger
    // ones make the live text visibly lag behind the voice.
    while (carry.length >= 3200) {
      const slice = carry.slice(0, 3200);
      carry = carry.slice(3200);
      const pcm = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        const v = Math.max(-1, Math.min(1, slice[i]));
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      onPcmChunk(pcm);
    }
  };
  from.connect(node);
  // ScriptProcessor only runs while connected to a destination; a zero gain keeps it
  // alive without adding the microphone to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);
  return node;
}

let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let processor: ScriptProcessorNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let hpFilter: BiquadFilterNode | null = null;

// Silero neural VAD (primary endpointer). Reuses our AudioContext + MediaStream
// (no second mic, no second context). null when disabled or while still loading.
let vad: MicVAD | null = null;
let sileroNoSpeechTimer: ReturnType<typeof setTimeout> | null = null;
// Resumes the AudioContext if the OS/webview suspends it while the (hidden) main window
// is backgrounded — otherwise the meter freezes and the energy VAD stalls.
let ctxKeepAlive: (() => void) | null = null;

// Speech summary of the latest recording, surfaced by stopRecording() so the
// caller can skip the API call (and avoid hallucinations) on near-silent clips.
// Defaults assume speech, so if VAD can't initialize we never wrongly block.
let lastVoicedMs = 0;
let lastHadSpeech = true;

export interface RecordingResult {
  blob: Blob;
  voicedMs: number;   // estimated voiced duration
  hadSpeech: boolean; // VAD confirmed a real (>= min-utterance) speech segment
}

export function isRecording(): boolean {
  return mediaRecorder !== null && mediaRecorder.state === 'recording';
}

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function teardownAudioGraph() {
  if (sileroNoSpeechTimer) { clearTimeout(sileroNoSpeechTimer); sileroNoSpeechTimer = null; }
  if (vad) {
    // destroy() pauses (our pauseStream is a no-op, so it won't stop the shared
    // tracks) and releases the ONNX session. ownsAudioContext is false (we passed
    // our own), so it will NOT close the context we close just below.
    const v = vad; vad = null;
    v.destroy().catch(() => {});
  }
  if (processor) { try { processor.disconnect(); } catch { /* */ } processor.onaudioprocess = null; processor = null; }
  if (hpFilter) { try { hpFilter.disconnect(); } catch { /* */ } hpFilter = null; }
  if (sourceNode) { try { sourceNode.disconnect(); } catch { /* */ } sourceNode = null; }
  analyser = null;
  if (ctxKeepAlive) { document.removeEventListener('visibilitychange', ctxKeepAlive); ctxKeepAlive = null; }
  if (audioContext) { audioContext.onstatechange = null; audioContext.close().catch(() => {}); audioContext = null; }
}

function cleanup() {
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  teardownAudioGraph();
  if (pcmTap) { try { pcmTap.disconnect(); } catch { /* */ } pcmTap.onaudioprocess = null; pcmTap = null; }
  if (boostContext) { boostContext.close().catch(() => {}); boostContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  mediaRecorder = null;
}

// Per-band magnitudes for the visualizer, from an already-read frequency array.
// `scale` mirrors the recording boost so the meter visibly reacts to a quiet mic
// (otherwise the bars stay tiny and the boost looks broken even when it isn't).
function computeBarsFrom(freq: Uint8Array, scale = 1): number[] {
  const usable = Math.min(96, freq.length);
  const per = Math.max(1, Math.floor(usable / VOICE_BAR_COUNT));
  const bars: number[] = [];
  for (let b = 0; b < VOICE_BAR_COUNT; b++) {
    let sum = 0;
    for (let i = 0; i < per; i++) sum += freq[b * per + i] || 0;
    bars.push(Math.min(1, (sum / per / 255) * 1.7 * scale));
  }
  return bars;
}

function startVad(stream: MediaStream, opts: StartOptions) {
  const { onAutoStop, onLevel } = opts;
  const autoStop = opts.autoStop !== false; // default true
  // Visual-only: when boost is on, scale the meter so a quiet mic still moves the
  // bars (the recorded audio is boosted the same amount). Does NOT touch the VAD
  // floor/RMS math below, which stays on the raw signal.
  const barScale = opts.autoGain !== false ? MIC_BOOST_GAIN : 1;
  try {
    const Ctx: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audioContext = new Ctx();
    audioContext.resume().catch(() => {});
    // Keep it running even when the main window is hidden in the tray (WKWebView/WebView2
    // suspend the AudioContext on hidden documents). Re-resume on visibility change AND
    // whenever the context reports it went suspended.
    {
      const ctx = audioContext;
      ctxKeepAlive = () => { ctx.resume().catch(() => {}); };
      ctx.onstatechange = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
      document.addEventListener('visibilitychange', ctxKeepAlive);
    }
    sourceNode = audioContext.createMediaStreamSource(stream);
    // Analysis-path high-pass: strips sub-250Hz fan/AC rumble from BOTH the RMS path
    // (so rumble can't inflate the floor) AND the flux path (so turbulent low bins
    // can't jitter fluxActive true). 2nd-order Butterworth @200Hz: ~-12dB@100Hz,
    // ~0dB@>=1kHz, so all speech formants pass intact. The mic->MediaRecorder path is
    // on the raw stream and is untouched: recorded/translated audio stays full-band.
    hpFilter = audioContext.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.value = VAD_HPF_HZ; // 200
    hpFilter.Q.value = VAD_HPF_Q;          // 0.707 (maximally flat)
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = VAD_ANALYSER_SMOOTHING; // 0.8 default kills flux responsiveness
    processor = audioContext.createScriptProcessor(2048, 1, 1);
    // Filtered signal feeds BOTH consumers (analyser flux + processor RMS/visualizer).
    sourceNode.connect(hpFilter);
    hpFilter.connect(analyser);
    hpFilter.connect(processor);
    // Connect to destination so the callback fires; output stays silent (we never
    // write to the output buffer) so there is no mic passthrough to the speakers.
    processor.connect(audioContext.destination);
  } catch (e) {
    console.warn('[Voice] VAD init failed (manual stop still works):', e);
    teardownAudioGraph();
    return;
  }

  const a = analyser;
  const sr = audioContext.sampleRate;
  const frameMs = (2048 / sr) * 1000;
  const F = (ms: number) => Math.max(1, Math.round(ms / frameMs));
  const CALIB_F = F(VAD_CALIB_MS);
  const ONSET_F = F(VAD_ONSET_MS);
  const HANGOVER_F = F(VAD_HANGOVER_MS);
  const silenceMsOpt = opts.silenceMs && opts.silenceMs >= 500 ? opts.silenceMs : VAD_SILERO_REDEMPTION_MS;
  const SILENCE_F = F(silenceMsOpt + 700); // energy fallback: same patience margin as the 1.5s->2.2s default
  const NOSPEECH_F = F(VAD_NO_SPEECH_TIMEOUT_MS);
  const MINUTTER_F = F(VAD_MIN_UTTERANCE_MS);
  const RECENCY_F = F(VAD_FLUX_RECENCY_MS);
  const FLUXCONFIRM_F = F(VAD_FLUX_CONFIRM_MS); // ~2 frames; spike must persist to refresh hold

  const binHz = sr / a.fftSize;
  // Flux band = speech band only. Lower edge excludes residual rumble that survives the
  // HPF skirt; upper edge drops the >3.8kHz broadband fan hiss. Both clamped in-bounds.
  // Math.min guards fluxLoBin <= fluxHiBin even on an exotic sample rate.
  const fluxHiBin = Math.min(a.frequencyBinCount - 1, Math.max(1, Math.round(VAD_FLUX_HI_HZ / binHz)));
  const fluxLoBin = Math.min(fluxHiBin, Math.max(1, Math.round(VAD_FLUX_LO_HZ / binHz)));
  const fluxBinCount = fluxHiBin - fluxLoBin + 1;
  const freq = new Uint8Array(a.frequencyBinCount);
  const prevMag = new Uint8Array(a.frequencyBinCount);

  // VAD state (frame-counted so it survives a hidden/background window)
  let frame = 0;
  let calibrating = true;
  let floor = 0;
  let lvl = 0;
  let fluxEma = 0;
  let fluxBase = 0;
  let fluxVar = 0;          // EMA of variance of fluxEma about fluxBase (turbulence detector)
  let fluxRun = 0;          // consecutive fluxActive frames (for N-frame confirmation)
  let havePrevMag = false;
  let speechActive = false;
  let hasSpoken = false;
  let onsetCount = 0;
  let hangoverLeft = 0;
  let silenceFrames = 0;
  let voicedFrames = 0;
  let fluxRecency = 0;
  let fired = false;
  // When the Silero neural VAD has loaded, it becomes the sole endpointing authority
  // and the energy/flux heuristic stops making auto-stop decisions (it keeps driving
  // the level meter + serves as the pre-load / load-failure fallback).
  let sileroActive = false;

  // VAD is active now -> start measuring this recording's speech from zero.
  lastVoicedMs = 0;
  lastHadSpeech = false;

  const fire = (reason: AutoStopReason) => {
    if (fired) return;
    if (!autoStop) return; // manual mode: never auto-stop (only the 60s safety timer can)
    fired = true;
    console.log(`[Voice] auto-stop fired: ${reason} (${sileroActive ? 'silero' : 'energy'})`);
    onAutoStop?.(reason);
  };
  // Energy/flux VAD fires only while Silero is NOT the authority (pre-load / fallback).
  const fireEnergy = (reason: AutoStopReason) => { if (!sileroActive) fire(reason); };

  // --- Silero neural VAD: load async, reuse our stream + context, take over endpointing ---
  if (autoStop && VAD_SILERO_ENABLED) {
    const ctx = audioContext;
    const sileroStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    void MicVAD.new({
      // Reuse the already-open mic + AudioContext instead of opening a second one.
      getStream: async () => stream,
      audioContext: ctx,
      // We own the stream's lifecycle (cleanup() stops the tracks); never let the VAD
      // stop/reopen it on pause/resume — that would kill the MediaRecorder mid-clip.
      pauseStream: async () => {},
      resumeStream: async () => stream,
      // Offline assets copied into public/ by scripts/copy-vad-assets.mjs (served from 'self').
      baseAssetPath: '/',
      onnxWASMBasePath: '/',
      model: 'v5',
      // No SharedArrayBuffer in the Tauri webview (not cross-origin-isolated) -> 1 thread.
      ortConfig: (ort) => { ort.env.logLevel = 'error'; ort.env.wasm.numThreads = 1; },
      positiveSpeechThreshold: VAD_SILERO_POSITIVE_THRESHOLD,
      negativeSpeechThreshold: VAD_SILERO_NEGATIVE_THRESHOLD,
      redemptionMs: silenceMsOpt,
      minSpeechMs: VAD_SILERO_MIN_SPEECH_MS,
      preSpeechPadMs: VAD_SILERO_PRESPEECH_PAD_MS,
      onSpeechStart: () => {
        hasSpoken = true;
        lastHadSpeech = true;
        if (sileroNoSpeechTimer) { clearTimeout(sileroNoSpeechTimer); sileroNoSpeechTimer = null; }
      },
      onSpeechEnd: (audio: Float32Array) => {
        // audio is 16kHz mono -> ms = samples / 16. This segment is real speech
        // (>= minSpeechMs by construction), so report it and end the utterance.
        lastVoicedMs = audio.length / 16;
        lastHadSpeech = true;
        fire('silence');
      },
      onVADMisfire: () => { /* segment shorter than minSpeechMs: ignore, keep listening */ },
    })
      .then((instance) => {
        if (fired || audioContext !== ctx) { instance.destroy().catch(() => {}); return; }
        vad = instance;
        sileroActive = true;
        console.log(`[Voice] Silero VAD ready in ${Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now())) - sileroStartMs)}ms (neural endpointing active)`);
        // Independent no-speech auto-cancel: Silero only fires on speech END, so if the
        // user never speaks we still need to give up. Cleared on first onSpeechStart.
        if (sileroNoSpeechTimer) clearTimeout(sileroNoSpeechTimer);
        sileroNoSpeechTimer = setTimeout(() => { if (!hasSpoken) fire('nospeech'); }, VAD_NO_SPEECH_TIMEOUT_MS);
      })
      .catch((err) => {
        // Fall back to the energy/flux endpointer (sileroActive stays false).
        console.warn('[Voice] Silero VAD load failed, using energy/flux fallback:', err);
      });
  }

  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    frame++;
    if (fired) return; // stop burning a full FFT/loop per frame once decided

    // 1) time-domain RMS
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    // 2) single spectrum read -> feeds BOTH the visualizer and the flux feature
    a.getByteFrequencyData(freq);
    if (onLevel) onLevel(computeBarsFrom(freq, barScale));

    // 3) spectral flux (positive change, speech is non-stationary) over the SPEECH band
    //    only [fluxLoBin..fluxHiBin]: excludes sub-250Hz fan rumble and >3.8kHz fan hiss.
    let flux = 0;
    for (let i = fluxLoBin; i <= fluxHiBin; i++) {
      if (havePrevMag) { const d = freq[i] - prevMag[i]; if (d > 0) flux += d; }
      prevMag[i] = freq[i];
    }
    havePrevMag = true;
    flux /= fluxBinCount;
    fluxEma += VAD_FLUX_EMA * (flux - fluxEma);

    // 4) asymmetric level smoothing
    lvl += (rms > lvl ? VAD_LEVEL_ATTACK : VAD_LEVEL_RELEASE) * (rms - lvl);

    // 5) calibration: seed floor + flux baseline, decide nothing yet
    if (calibrating) {
      floor = floor === 0 ? rms : floor + VAD_FLOOR_CALIB_ALPHA * (rms - floor);
      // Characterize fan turbulence up front: track both mean (fluxBase) and variance
      // (fluxVar) of flux so a fan running at startup raises the bar before any decision.
      {
        const d = fluxEma - fluxBase;
        fluxBase += VAD_FLOOR_CALIB_ALPHA * d;
        fluxVar += VAD_FLOOR_CALIB_ALPHA * (d * d - fluxVar);
      }
      if (frame >= CALIB_F) { floor = Math.max(VAD_FLOOR_MIN, floor); calibrating = false; }
      return;
    }

    // 6) relative thresholds (hysteresis) + flux confirmation
    const overOn = lvl >= floor * VAD_ON_RATIO && lvl >= floor + VAD_ON_ABS_MARGIN && lvl >= VAD_ABS_MIN;
    const overOff = lvl > floor * VAD_OFF_RATIO && lvl > floor + VAD_OFF_ABS_MARGIN && lvl >= VAD_ABS_MIN;
    // Variance-aware flux bar: max of the original 1.6x-of-mean test AND a
    // mean+K*stddev test. Steady/quiet room -> fluxStd~0 -> bar == 1.6*base (identical
    // to before, quiet speech unaffected). Turbulent fan -> high fluxStd -> bar rises
    // above the fan's OWN flicker; sustained voice still clears it. Never drops below
    // today's sensitivity (it's a max()).
    const fluxBaseC = Math.max(fluxBase, 1e-6);
    const fluxStd = Math.sqrt(fluxVar > 0 ? fluxVar : 0);
    const fluxThresh = Math.max(VAD_FLUX_FACTOR * fluxBaseC, fluxBaseC + VAD_FLUX_STD_K * fluxStd);
    const fluxActive = fluxEma >= fluxThresh;
    // N-consecutive-frame confirmation: a single-frame turbulence spike must NOT refresh
    // the hold. Real voicing makes long runs; flicker never reaches ~2-in-a-row.
    if (fluxActive) fluxRun++; else fluxRun = 0;
    const fluxConfirmed = fluxRun >= FLUXCONFIRM_F;

    if (!speechActive) {
      // adapt floor + flux baseline ONLY while NOT speaking (asymmetric, so they
      // absorb steady music but never chase the voice)
      floor += (rms < floor ? VAD_FLOOR_ALPHA_DOWN : VAD_FLOOR_ALPHA_UP) * (rms - floor);
      floor = Math.max(VAD_FLOOR_MIN, floor);
      // Update flux mean AND variance together so the bar tracks turbulence (frozen
      // during speech, exactly like fluxBase, so the voice never raises its own bar).
      {
        const a2 = fluxEma < fluxBase ? VAD_FLUX_BASE_DOWN : VAD_FLUX_BASE_UP;
        const d = fluxEma - fluxBase;
        fluxBase += a2 * d;
        fluxVar += a2 * (d * d - fluxVar);
      }

      // ONSET: louder than floor AND fluctuating -> steady music (flux dead) can't latch
      if (overOn && fluxActive) {
        onsetCount++;
        silenceFrames = 0;
        if (onsetCount >= ONSET_F) {
          speechActive = true;
          hasSpoken = true;
          hangoverLeft = HANGOVER_F;
          silenceFrames = 0;
          voicedFrames = onsetCount;
          onsetCount = 0;
          fluxRecency = RECENCY_F;
        }
      } else {
        onsetCount = 0;
        if (hasSpoken) {
          if (++silenceFrames >= SILENCE_F) fireEnergy(voicedFrames >= MINUTTER_F ? 'silence' : 'nospeech');
        } else if (frame >= NOSPEECH_F) {
          fireEnergy('nospeech');
        }
      }
    } else {
      // ACTIVE: flux is the PRIMARY hold. Loudness alone (overOff) only sustains the
      // utterance briefly after recent flux, so steady music after speech ends can't
      // wedge it open (the adversarially-found deadlock).
      if (fluxConfirmed) {
        // Confirmed voicing (>=2 consecutive fluxActive frames): refresh the hold every
        // time, so natural inter-word/inter-sentence pauses never strand a live talker.
        // Turbulent fan can't reach this branch (variance bar + 2-frame confirm reject it),
        // so always-refreshing here does NOT reopen the fan/music hold.
        fluxRecency = RECENCY_F;
        voicedFrames++;
        hangoverLeft = HANGOVER_F;
        silenceFrames = 0;
      } else if (overOff && fluxRecency > 0) {
        // Trailing loudness after recent voicing bridges between-word dips. Only sustains
        // while level stays above OFF, so once it drains the release path runs.
        fluxRecency--;
        voicedFrames++;
        hangoverLeft = HANGOVER_F;
        silenceFrames = 0;
      } else if (hangoverLeft > 0) {
        hangoverLeft--;
      } else {
        speechActive = false;
        silenceFrames = 1;
      }
    }

    // Surface the running speech summary for the post-stop min-duration guard.
    // When Silero is the authority it owns these values (set in its callbacks),
    // so the energy heuristic must not overwrite them.
    if (!sileroActive) {
      lastVoicedMs = voicedFrames * frameMs;
      lastHadSpeech = hasSpoken && voicedFrames >= MINUTTER_F;
    }
  };
}

export async function startRecording(opts: StartOptions = {}): Promise<void> {
  if (isRecording()) {
    console.warn('[Voice] startRecording called while already recording');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access is not available in this environment');
  }

  // Single user knob: "boost" applies a real software gain below (default ON).
  // autoGainControl is forced OFF at the constraint level — WKWebView ignores it
  // anyway, and on Chromium it would fight our gain (double-boost) and let the
  // energy-VAD floor ramp during pauses. Our GainNode is the one true boost.
  const boost = opts.autoGain !== false;

  const baseAudio: MediaTrackConstraints = {
    echoCancellation: true,  // cancel speaker-played music captured by the mic
    noiseSuppression: true,  // attenuate steady music/noise -> lower, cleaner floor
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48000,       // hint only; timing reads ctx.sampleRate at runtime
  };

  let stream: MediaStream;
  try {
    try {
      // Preferred microphone from Settings ('' = system default). exact so we KNOW which
      // device we got; if it's gone (unplugged), fall back to the default below instead of
      // silently recording from a different mic than the user chose.
      const audio = opts.deviceId ? { ...baseAudio, deviceId: { exact: opts.deviceId } } : baseAudio;
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (opts.deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError')) {
        console.warn('[Voice] Selected microphone unavailable - falling back to the system default');
        stream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
      } else {
        throw err;
      }
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('Microphone permission denied. Enable it in System Settings → Privacy → Microphone.');
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      throw new Error('No microphone found. Please connect a microphone.');
    }
    throw new Error(`Could not access microphone: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const label = stream.getAudioTracks()[0]?.label || '';
    if (label) opts.onDeviceLabel?.(label);
  } catch { /* label is cosmetic */ }

  // Some WKWebView/WebView2 builds silently drop these at getUserMedia; re-apply
  // defensively (best-effort). AGC stays off; software boost handles loudness.
  for (const t of stream.getAudioTracks()) {
    t.applyConstraints({ autoGainControl: false, noiseSuppression: true, echoCancellation: true }).catch(() => {});
  }

  mediaStream = stream;
  chunks = [];

  // "Boost quiet mic": amplify the RECORDED audio with a Web Audio GainNode. This
  // works where the browser AGC constraint is ignored (WKWebView). The VAD/meter
  // below still read the RAW `stream`, so the floor logic is unaffected by the boost.
  // If anything in the graph fails, fall back to recording the raw stream.
  let recordStream = stream;
  if (boost) {
    try {
      const Ctx: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      boostContext = new Ctx();
      boostContext.resume().catch(() => {});
      const src = boostContext.createMediaStreamSource(stream);
      const gain = boostContext.createGain();
      gain.gain.value = MIC_BOOST_GAIN;
      // Limiter after the gain: quiet mics get the full boost, but a mic that's
      // already loud is capped near 0 dBFS instead of clipping (which would wreck
      // Whisper accuracy). This is what makes a default-ON 2.5x boost safe for ALL
      // mics, not just quiet ones.
      const limiter = boostContext.createDynamicsCompressor();
      limiter.threshold.value = -6;  // start limiting near the ceiling
      limiter.knee.value = 0;        // hard knee -> true limiter
      limiter.ratio.value = 20;      // ~brick-wall
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      const dest = boostContext.createMediaStreamDestination();
      src.connect(gain);
      gain.connect(limiter);
      limiter.connect(dest);
      recordStream = dest.stream;

      // Live-dictation tap, fed from AFTER the limiter so the recogniser hears exactly
      // what the recording hears.
      if (opts.onPcmChunk) {
        pcmTap = attachPcmTap(boostContext, limiter, opts.onPcmChunk);
      }
    } catch (e) {
      console.warn('[Voice] mic boost graph failed, recording raw:', e);
      if (boostContext) { boostContext.close().catch(() => {}); boostContext = null; }
      recordStream = stream;
      pcmTap = null;
    }
  }
  // Live dictation must hear the microphone whether or not the boost graph exists (boost
  // off, or its construction failed). A minimal context taps the raw stream directly; the
  // recording itself still uses the untouched stream.
  if (opts.onPcmChunk && !pcmTap) {
    try {
      const Ctx: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      boostContext = boostContext ?? new Ctx();
      boostContext.resume().catch(() => {});
      const rawSrc = boostContext.createMediaStreamSource(stream);
      pcmTap = attachPcmTap(boostContext, rawSrc, opts.onPcmChunk);
    } catch (e) {
      console.warn('[Voice] live tap unavailable, live text will be empty:', e);
    }
  }

  const mimeType = pickMimeType();
  // 48kbps Opus: transparent for speech, and keeps even a 15-minute clip at ~5-6MB — far
  // under the 25MB transcribe cap (engine defaults can be 128kbps+, which would exceed it).
  const recOpts = { audioBitsPerSecond: 48_000 };
  mediaRecorder = mimeType
    ? new MediaRecorder(recordStream, { mimeType, ...recOpts })
    : new MediaRecorder(recordStream, recOpts);
  mediaRecorder.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  // Last gate before capture (see StartOptions.beforeStart). On abort, tear the graph down
  // here rather than leaving an open microphone behind.
  if (opts.beforeStart) {
    try {
      await opts.beforeStart();
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  // Timeslice: flush a chunk every 1s. Without it MediaRecorder only emits data on stop(),
  // and when the (capture-owning) main window is hidden in the tray that single event can be
  // throttled/dropped -> empty blob -> "No speech detected". Periodic chunks survive that.
  // Resolve only once the recorder has actually STARTED. start() is asynchronous — the start
  // event arrived ~177ms later when measured — and returning before it meant the caller told
  // the user to speak into a recorder that was not capturing yet.
  const rec = mediaRecorder;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    rec.addEventListener('start', done, { once: true });
    // Never hang the whole voice session on a missing event: some WebView builds have been
    // inconsistent about firing 'start', and by this point capture has been requested anyway.
    setTimeout(done, 400);
    rec.start(1000);
  });
  console.log(`[Voice] Recording started (mime: ${mediaRecorder.mimeType}, mode: ${opts.autoStop === false ? 'MANUAL' : 'AUTO'}, boost: ${boost ? `${MIC_BOOST_GAIN}x` : 'off'})`);

  startVad(stream, opts);

  safetyTimer = setTimeout(() => {
    if (isRecording()) {
      console.warn('[Voice] Max recording duration reached, auto-stopping');
      // 'maxed', NOT 'silence': the cap is a timer verdict. Reporting it as 'silence' made the
      // overlay apply the VAD no-speech guard, which DISCARDED capped recordings (in auto mode
      // the VAD summary is empty precisely because no long pause ever occurred).
      opts.onAutoStop?.('maxed');
    }
  }, opts.maxMs && opts.maxMs > 0 ? opts.maxMs : MAX_RECORDING_MS);
}

export function stopRecording(): Promise<RecordingResult> {
  return new Promise((resolve, reject) => {
    const recorder = mediaRecorder;
    if (!recorder) { reject(new Error('No active recording')); return; }
    const mimeType = recorder.mimeType || 'audio/webm';
    const voicedMs = lastVoicedMs;
    const hadSpeech = lastHadSpeech;
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      chunks = [];
      cleanup();
      console.log(`[Voice] Recording stopped (${blob.size} bytes, ${mimeType}, voiced ${Math.round(voicedMs)}ms, hadSpeech ${hadSpeech})`);
      resolve({ blob, voicedMs, hadSpeech });
    };
    try { recorder.stop(); } catch (err) { cleanup(); reject(err instanceof Error ? err : new Error(String(err))); }
  });
}

export function cancelRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null;
    try { mediaRecorder.stop(); } catch { /* */ }
  }
  chunks = [];
  cleanup();
}
