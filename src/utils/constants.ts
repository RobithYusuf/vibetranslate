import { Language, SupportedLanguage, AIProvider } from '@/types';

// Note: Gemini uses OpenAI-compatible API via Google AI Studio

export const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+T';
export const DEFAULT_POPUP_SHORTCUT = 'CommandOrControl+Alt+P';
export const DEFAULT_ENHANCE_SHORTCUT = 'CommandOrControl+Alt+E';
export const DEFAULT_TERMINAL_SHORTCUT = 'CommandOrControl+Alt+Shift+T';
// Voice-to-Text shortcuts: press to start recording, press again to stop & process
export const DEFAULT_VOICE_SHORTCUT = 'CommandOrControl+Alt+V'; // voice → translate
export const DEFAULT_VOICE_ORIGINAL_SHORTCUT = 'CommandOrControl+Alt+Shift+V'; // voice → raw transcription
export const DEFAULT_VOICE_HOLD_TO_TALK = false; // false = press twice, true = hold and release
export const DEFAULT_SOURCE_LANG: SupportedLanguage = 'auto';
export const DEFAULT_TARGET_LANG: SupportedLanguage = 'en';
// Speech-to-text reuses the translation source language (the "From" setting). When that is
// 'auto', Whisper auto-detects — but it can mis-guess short/noisy clips as Japanese/Chinese,
// so transcription guards the result: a non-Latin transcript is retried ONCE forcing this
// fallback language. (Setting From to a specific language skips detection entirely.)
export const VOICE_AUTODETECT_FALLBACK_LANG = 'id';
// Where the listening popup appears on screen: 'top' | 'center' | 'bottom'.
export const DEFAULT_VOICE_POPUP_POSITION = 'top';
// Play a sound when voice recording starts/stops (separate from the general sound feedback).
export const DEFAULT_VOICE_SOUND_ENABLED = true;

// User-configurable voice caps (Settings > Voice). These are THE defaults — the store and
// every fallback derive from them, so they can't drift apart.
export const DEFAULT_VOICE_MAX_MINUTES = 10;   // recording hard cap (1–15)
export const DEFAULT_VOICE_SILENCE_SEC = 1.5;  // auto-stop: pause length that ends the utterance

// --- Microphone capture tuning ---
// Single user-facing mic knob ("Boost quiet mic"): ON = apply a real software gain
// (Web Audio GainNode) to the RECORDED audio so a soft mic is actually heard (the
// usual fix for "No speech detected"). We do NOT rely on the browser autoGainControl
// constraint — WKWebView (macOS) silently ignores it, so the toggle would do nothing.
// Default ON. Noise suppression stays always-on internally (not exposed).
export const DEFAULT_MIC_AUTO_GAIN = true;
// Software boost factor when the knob is ON. ~2.5x ≈ +8dB: lifts a quiet mic clearly
// without the harsh clipping a larger multiplier causes on already-loud input.
export const MIC_BOOST_GAIN = 2.5;
export const DEFAULT_MODE = 'replace';
// The built-in free server, so a fresh install works before the user has configured
// anything. Defaulting to a BYOK provider meant every first run hit "no API key" — and that
// path produced no visible feedback at all, so the app simply looked broken.
export const DEFAULT_PROVIDER: AIProvider = 'server';

// Maximum characters for translation (API token limits)
export const MAX_TRANSLATE_CHARS = 5000;

// Provider configurations
export const AI_PROVIDERS: Record<AIProvider, {
  name: string;
  baseURL: string;
  defaultModel: string;
  models: { id: string; name: string; free?: boolean }[];
  keyPrefix: string;
  keyPlaceholder: string;
  isServer?: boolean; // If true, uses server endpoint (models from ENV/Admin panel)
}> = {
  server: {
    name: 'Built-in (Free)',
    baseURL: '', // Not used - server handles this
    defaultModel: '',
    models: [], // Will be populated from server
    keyPrefix: '',
    keyPlaceholder: '',
    isServer: true,
  },
  // NOTE: these are FALLBACK lists shown before a key is entered. Once a key is set,
  // the live /models list is fetched and used. IDs verified current as of Jun 2026.
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini', // cheap, fast, great multilingual translation
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (cheap, fast)' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano (cheapest)' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-5.5', name: 'GPT-5.5 (most capable)' },
    ],
    keyPrefix: 'sk-',
    keyPlaceholder: 'sk-...',
  },
  openrouter: {
    name: 'OpenRouter (Free)',
    baseURL: 'https://openrouter.ai/api/v1',
    // Same sweep: OpenRouter's :free variant of Llama 3.3 70B is gone from its live list too
    // (the paid variant remains). Replaced with models confirmed present today.
    defaultModel: 'openai/gpt-oss-120b:free',
    models: [
      { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B (free)', free: true },
      { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)', free: true },
      { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)', free: true },
      { id: 'openai/gpt-oss-20b:free', name: 'GPT-OSS 20B (free)', free: true },
      { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B (free)', free: true },
    ],
    keyPrefix: 'sk-or-',
    keyPlaceholder: 'sk-or-...',
  },
  groq: {
    name: 'Groq (Free & Fast)',
    baseURL: 'https://api.groq.com/openai/v1',
    // Groq's PRODUCTION text models, checked against its live model list. Both Llama entries
    // that used to be here were removed by Groq outright — gone from GET /models, not merely
    // deprecated — and anyone whose saved model was one of them got a failure on every
    // translation. Qwen3.6-27B works but Groq classes it "preview, for evaluation only", so
    // it is deliberately not offered: preview is the category that just broke.
    defaultModel: 'openai/gpt-oss-120b',
    models: [
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B (best)', free: true },
      { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B (fastest)', free: true },
    ],
    keyPrefix: 'gsk_',
    keyPlaceholder: 'gsk_...',
  },
  gemini: {
    name: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash', // stable, fast, strong multilingual
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (recommended)', free: true },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', free: true },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite (fast)', free: true },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', free: true },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', free: true },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)', free: true },
    ],
    keyPrefix: 'AIza',
    keyPlaceholder: 'AIza...',
  },
  custom: {
    name: 'Custom (OpenAI-compatible)',
    baseURL: '', // user-provided in Settings
    defaultModel: '',
    models: [], // user types the model name
    keyPrefix: '',
    keyPlaceholder: 'your-api-key',
  },
};

export const LANGUAGES: Language[] = [
  { code: 'auto', name: 'Auto-detect' },
  { code: 'id', name: 'Indonesian' },
  { code: 'en', name: 'English' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'ru', name: 'Russian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'pt', name: 'Portuguese' },
];

export const LANGUAGE_MAP: Record<string, string> = Object.fromEntries(
  LANGUAGES.map((l) => [l.code, l.name])
);

export const STATUS_MESSAGES: Record<string, string> = {
  idle: '',
  copying: 'Copying text...',
  translating: 'Translating...',
  pasting: 'Replacing text...',
  done: 'Done!',
  error: 'Error',
};

// =============================================================================
// Appearance (user-configurable in Settings)
// =============================================================================

// Selectable UI fonts (bundled via @fontsource; 'system' uses the OS default).
export const FONT_OPTIONS: { id: string; name: string; stack: string }[] = [
  { id: 'inter', name: 'Inter', stack: "'Inter Variable', system-ui, sans-serif" },
  { id: 'geist', name: 'Geist', stack: "'Geist Variable', system-ui, sans-serif" },
  { id: 'manrope', name: 'Manrope', stack: "'Manrope Variable', system-ui, sans-serif" },
  { id: 'jakarta', name: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans Variable', system-ui, sans-serif" },
  { id: 'system', name: 'System (default)', stack: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
];

export const DEFAULT_UI_FONT = 'inter';

export function fontStackFor(id: string): string {
  return (FONT_OPTIONS.find((f) => f.id === id) || FONT_OPTIONS[0]).stack;
}

// UI zoom levels (applied via CSS zoom so EVERYTHING scales, incl. fixed-px text).
export const UI_SCALE_OPTIONS: { id: string; name: string; value: number }[] = [
  { id: 'sm', name: 'Small', value: 0.9 },
  { id: 'md', name: 'Normal', value: 1.0 },
  { id: 'lg', name: 'Large', value: 1.15 },
  { id: 'xl', name: 'Extra Large', value: 1.3 },
];

export const DEFAULT_UI_SCALE = 'md';

export function scaleValueFor(id: string): number {
  return (UI_SCALE_OPTIONS.find((s) => s.id === id) || UI_SCALE_OPTIONS[1]).value;
}

// =============================================================================
// Speech-to-Text (Voice) configuration
// =============================================================================

// Max recording duration (ms) - safety stop so a forgotten recording doesn't run forever
// (the system stays muted while recording). FALLBACK only — the user-facing setting is
// voiceMaxMinutes in the store (Settings > Voice > Max recording length, default 10 min);
// keep this fallback equal to that default. 10 min of Opus/WebM stays under the 25MB cap.
export const MAX_RECORDING_MS = 600_000;

// Voice Activity Detection (VAD) tuning.
// Adaptive-floor + spectral-flux detector: ambient music/noise becomes the "floor",
// the (closer/louder, fluctuating) voice is detected above it, and end-of-utterance
// fires when both level returns near the floor AND flux collapses — so it auto-stops
// even while music keeps playing. All ms below are converted to audio-frame counts.
// --- timing ---
export const VAD_CALIB_MS = 350;            // seed floor + flux baseline at start (assume ambient)
export const VAD_ONSET_MS = 100;            // hold above ON this long before latching speech
export const VAD_HANGOVER_MS = 850;         // grace after level drops; bridges between-word pauses
// (energy-VAD silence window now derives from the user's voiceSilenceSec setting + 700ms margin)
export const VAD_NO_SPEECH_TIMEOUT_MS = 8000; // no speech at all -> auto-cancel
export const VAD_MIN_UTTERANCE_MS = 250;    // shorter than this when end fires -> treat as noise
export const VAD_FLUX_RECENCY_MS = 1000;    // after last fluxActive frame, overOff may still sustain (bridge longer pauses near fan noise)

// Voice Input ships ON (feature enabled + shortcuts registered by default)...
export const DEFAULT_VOICE_ENABLED = true;
// ...but its stop mode defaults to manual: false = manual (press shortcut again). Auto-stop
// (VAD) is BETA — it can be inaccurate or cut off mid-sentence — so it ships OFF; opt in via Settings.
export const DEFAULT_VOICE_AUTO_STOP = false;

// --- Silero neural VAD (primary endpointer; energy/flux VAD above is the fallback) ---
// A small ONNX model classifies each ~32ms frame as speech/not-speech. Unlike the
// energy/flux heuristic, it ignores fan/AC/music noise by construction, so we can use
// a generous silence grace (redemption) without fan turbulence re-triggering speech.
export const VAD_SILERO_ENABLED = true;            // master switch; false = energy/flux only
export const VAD_SILERO_REDEMPTION_MS = 1500;      // silence after speech before end-of-utterance fires (bridges natural pauses; higher = won't cut you off mid-thought)
export const VAD_SILERO_MIN_SPEECH_MS = 400;       // segments shorter than this are misfires (not real speech); matches the post-stop min-duration guard
export const VAD_SILERO_PRESPEECH_PAD_MS = 400;    // (unused for endpointing; pad on returned audio)
export const VAD_SILERO_POSITIVE_THRESHOLD = 0.35; // speech prob >= this starts/holds speech
export const VAD_SILERO_NEGATIVE_THRESHOLD = 0.25; // speech prob <= this counts toward redemption
// --- adaptive floor (linear RMS EMA, updated only when NOT speaking) ---
export const VAD_FLOOR_ALPHA_UP = 0.08;     // floor rises (music starts): ~95% in ~1.6s
export const VAD_FLOOR_ALPHA_DOWN = 0.20;   // floor falls faster (music stops)
export const VAD_FLOOR_CALIB_ALPHA = 0.30;  // fast convergence during calibration
export const VAD_FLOOR_MIN = 0.0008;        // clamp; never collapse to 0
// --- level smoothing (asymmetric EMA) ---
export const VAD_LEVEL_ATTACK = 0.6;        // fast rise -> catch onsets
export const VAD_LEVEL_RELEASE = 0.15;      // slow fall -> ride through inter-word dips
// --- onset/offset thresholds, relative to floor (hysteresis) ---
export const VAD_ON_RATIO = 1.8;            // speech ON when level >= floor*1.8 (lower = catch quieter speech)
export const VAD_ON_ABS_MARGIN = 0.003;     // AND level >= floor + this
export const VAD_OFF_RATIO = 1.35;          // stay "talking" until level <= floor*1.35 (lower = less premature cutoff)
export const VAD_OFF_ABS_MARGIN = 0.0025;
export const VAD_ABS_MIN = 0.001;           // hard floor: below this is always silence
// --- spectral flux / band confirmation (from AnalyserNode) ---
export const VAD_ANALYSER_SMOOTHING = 0.3;  // analyser.smoothingTimeConstant (default 0.8 kills flux)
export const VAD_FLUX_EMA = 0.3;            // fast EMA of per-frame spectral flux
export const VAD_FLUX_BASE_UP = 0.02;       // flux baseline rises slowly (absorbs steady music)
export const VAD_FLUX_BASE_DOWN = 0.10;     // flux baseline falls faster
export const VAD_FLUX_FACTOR = 1.6;         // fluxActive when fluxEma >= factor * baseline
export const VAD_LOWBAND_HZ = 3500;         // speech-band upper edge for advisory band-ratio
export const VAD_LOWBAND_MIN_RATIO = 1.3;   // (low/high) above this = speech-shaped (advisory)
export const VAD_FLUX_LO_HZ = 250;          // flux band lower edge: exclude fan/AC rumble bins
export const VAD_FLUX_HI_HZ = 3800;         // flux band upper edge: speech formants; drop >3.8k hiss
// --- fan/turbulence hardening ---
// Turbulent fan noise is broadband with HIGH-VARIANCE flux: its own spikes cross a
// fixed 1.6x-of-MEAN bar, which used to refresh the hold forever (recording never
// stopped). Two cheap, orthogonal guards on the EXISTING flux pipeline fix this
// WITHOUT touching any timer (latency/pause behavior unchanged):
export const VAD_FLUX_STD_K = 3.0;          // additive bar = base + K*stddev(flux); a turbulent
                                            // baseline raises its OWN bar above its flicker. In a
                                            // steady/quiet room stddev~0 -> bar collapses to 1.6*base.
export const VAD_FLUX_CONFIRM_MS = 90;      // consecutive fluxActive ms (~2 frames) required to
                                            // REFRESH the hold; kills isolated 1-frame turbulence spikes.
// --- analysis-path high-pass (BiquadFilterNode) to strip sub-250Hz fan/AC rumble ---
// Inserted between source and BOTH the analyser (flux) and the ScriptProcessor (RMS),
// so rumble no longer inflates the floor NOR jitters low bins into flux. The mic->
// MediaRecorder path is on the raw stream and is UNAFFECTED (recorded audio full-band).
export const VAD_HPF_HZ = 200;              // 2nd-order Butterworth cutoff: -12dB@100Hz, ~0dB@>=1kHz
export const VAD_HPF_Q = 0.707;            // maximally-flat passband (no resonant bump)

// STT providers that expose a Whisper-compatible /audio/transcriptions endpoint.
// We reuse the user's existing per-provider API keys (no new key needed).
// Order = preference: try groq first (free & fast), then openai.
export const STT_PROVIDERS: {
  provider: 'groq' | 'openai';
  baseURL: string;
  model: string;
}[] = [
  {
    provider: 'groq',
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
  },
  {
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    model: 'whisper-1',
  },
];

export const VOICE_STATUS_MESSAGES: Record<string, string> = {
  idle: '',
  starting: 'Getting ready…',
  recording: 'Listening',
  transcribing: 'Transcribing…',
  translating: 'Translating…',
  cleaning: 'Tidying…',
  pasting: 'Pasting…',
  done: 'Done',
  error: 'Error',
};

// Number of bars in the recording level visualizer.
export const VOICE_BAR_COUNT = 5;
