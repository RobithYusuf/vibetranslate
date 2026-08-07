// Speech-to-Text via a Whisper-compatible /audio/transcriptions endpoint.
// Reuses the user's existing per-provider API keys (Groq preferred, then OpenAI).

import { AIProvider } from '@/types';
import { STT_PROVIDERS } from '@/utils/constants';
import APP_CONFIG from '@/config';

interface TranscribeOptions {
  blob: Blob;
  provider: AIProvider;
  apiKeys: Record<AIProvider, string | null>;
  preferProvider?: string; // 'groq' | 'openai' from the Settings engine picker ('auto' = old behavior)
  // Optional ISO-639-1 hint (e.g. 'id', 'en'). Omit or 'auto' = let Whisper detect.
  language?: string;
  // When auto-detecting (language omitted/'auto') and Whisper returns a wrong (non-Latin)
  // script, retry once forcing this language. Ignored when `language` is set explicitly.
  fallbackLanguage?: string;
  // Whisper context/vocabulary hint — biases recognition toward these words/phrases
  // (e.g. "typo, hapus, commit, deploy"). Fixes similar-sounding short words.
  prompt?: string;
  signal?: AbortSignal;
}

// Whisper auto-detect mis-transcribes short/noisy audio specifically into CJK scripts
// (Chinese / Japanese kana / Korean hangul) — that's the hallucination we guard against.
// Flag a transcript that is MOSTLY CJK so a Latin-script speaker's clip can be retried with a
// forced language. Deliberately scoped to CJK only: "any non-Latin" would WRONGLY discard a
// correct Russian/Arabic/Greek/etc. transcript when the source is left on auto-detect.
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯ｦ-ﾟ]/g;
function looksWrongScript(text: string): boolean {
  // Keep only letters (drop spaces, digits, punctuation, symbols, emoji).
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (letters.length < 2) return false;
  const cjk = (letters.match(CJK_RE) || []).length;
  return cjk / letters.length > 0.5; // majority CJK/kana/hangul -> mis-detection
}

// Pick the first STT provider the user actually has a key for.
function pickProvider(apiKeys: Record<AIProvider, string | null>, prefer?: string) {
  // Explicit engine choice from Settings ('groq' | 'openai') wins when its key exists.
  if (prefer === 'groq' || prefer === 'openai') {
    const cfg = STT_PROVIDERS.find((c) => c.provider === prefer);
    const key = apiKeys[prefer as AIProvider];
    if (cfg && key && key.trim()) return { cfg, key: key.trim() };
    return null; // chosen engine has no key -> caller falls back to the server
  }
  for (const cfg of STT_PROVIDERS) {
    const key = apiKeys[cfg.provider];
    if (key && key.trim()) {
      return { cfg, key: key.trim() };
    }
  }
  return null;
}

function fileExtensionFor(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

// --- Whisper hallucination defenses (mirror of server/src/routes/transcribe.ts) ---
interface WhisperSegment { text?: string; no_speech_prob?: number; avg_logprob?: number; compression_ratio?: number }

function keepSegment(s: WhisperSegment): boolean {
  const noSpeech = s.no_speech_prob ?? 0;
  const logprob = s.avg_logprob ?? 0;
  const compression = s.compression_ratio ?? 0;
  if (noSpeech > 0.6 && logprob < -1.0) return false; // Whisper's silence rule (needs BOTH)
  if (compression > 2.4) return false;                // repetition / gibberish loop
  return true;
}

const HALLUCINATION_PHRASES = new Set([
  'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
  'thank you for watching', 'please subscribe', 'you', '.', 'bye', 'bye.',
  'subtitles by the amara.org community', 'terima kasih', 'terima kasih.',
  'terima kasih telah menonton', 'terima kasih sudah menonton',
]);

function isHallucinationPhrase(t: string): boolean {
  const n = t.toLowerCase().replace(/\s+/g, ' ').trim();
  return HALLUCINATION_PHRASES.has(n) || HALLUCINATION_PHRASES.has(n.replace(/[.!?,]+$/g, '').trim());
}

// Clean transcript from a verbose_json (segments) or plain ({text}) response.
function cleanTranscript(data: { text?: string; segments?: WhisperSegment[] }): string {
  let text: string;
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    text = data.segments.filter(keepSegment).map((s) => s.text || '').join('').trim();
  } else {
    text = (data.text || '').trim();
  }
  if (!text || isHallucinationPhrase(text)) return '';
  return text;
}

// Server-side transcription via the built-in free server (uses the server's Groq key).
async function transcribeViaServer(
  blob: Blob,
  language?: string,
  prompt?: string,
  signal?: AbortSignal
): Promise<string> {
  const ext = fileExtensionFor(blob.type);
  const form = new FormData();
  form.append('file', blob, `recording.${ext}`);
  if (language && language !== 'auto') form.append('language', language);
  if (prompt && prompt.trim()) form.append('prompt', prompt.trim());

  let response: Response;
  try {
    response = await fetch(`${APP_CONFIG.API_URL}/api/transcribe`, {
      method: 'POST',
      body: form,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('Transcription cancelled');
    throw new Error(`Could not reach transcription server: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    // Clear, to-the-point messages per status (the overlay shows these directly).
    if (response.status === 422) throw new Error('No speech detected — speak a bit louder/closer to the mic.');
    if (response.status === 429) throw new Error('Too many requests — wait a moment and try again.');
    if (response.status === 413) throw new Error('Recording too long — try a shorter clip.');
    if (response.status === 503) throw new Error('Voice server unavailable — add your own Groq/OpenAI key in Settings.');
    throw new Error(`Transcription failed: ${detail || `server error ${response.status}`}`);
  }

  const data = await response.json();
  // Server already filters; apply the phrase blocklist as a final client-side net.
  const text = (data?.text ?? '').trim();
  if (!text || isHallucinationPhrase(text)) throw new Error('No speech detected. Please try again.');
  return text;
}

// Direct transcription using the user's own Groq/OpenAI key.
async function transcribeDirect(
  blob: Blob,
  apiKeys: Record<AIProvider, string | null>,
  language?: string,
  prompt?: string,
  signal?: AbortSignal,
  prefer?: string
): Promise<string> {
  const picked = pickProvider(apiKeys, prefer);
  if (!picked) {
    throw new Error(
      'Voice input needs a Groq or OpenAI API key, or switch provider to Built-in (Free).'
    );
  }

  const { cfg, key } = picked;
  const ext = fileExtensionFor(blob.type);

  const form = new FormData();
  form.append('file', blob, `recording.${ext}`);
  form.append('model', cfg.model);
  form.append('response_format', 'verbose_json'); // per-segment quality signals
  form.append('temperature', '0');                // deterministic; less gibberish
  if (language && language !== 'auto') form.append('language', language);
  if (prompt && prompt.trim()) form.append('prompt', prompt.trim());

  let response: Response;
  try {
    response = await fetch(`${cfg.baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('Transcription cancelled');
    throw new Error(`Network error contacting ${cfg.provider}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    if (response.status === 401) throw new Error(`Invalid ${cfg.provider} API key.`);
    if (response.status === 429) throw new Error(`${cfg.provider} rate limit — try again shortly.`);
    if (response.status === 413) throw new Error('Recording too long — try a shorter clip.');
    throw new Error(`Transcription failed: ${detail || `${cfg.provider} error ${response.status}`}`);
  }

  const data = await response.json();
  const text = cleanTranscript(data); // drop hallucinated/silence segments + phrase blocklist
  if (!text) throw new Error('No speech detected — speak a bit louder/closer to the mic.');
  return text;
}

/**
 * Transcribe an audio Blob to text.
 *
 * Routing (prefer the user's own key so it works without depending on the server):
 * - A Groq/OpenAI key is set → transcribe directly with that key.
 * - Otherwise (incl. Built-in/Free provider with no key) → use the free server endpoint.
 */
export async function transcribe(options: TranscribeOptions): Promise<string> {
  const { blob, apiKeys, language, fallbackLanguage, prompt, signal, preferProvider } = options;

  if (!blob || blob.size === 0) {
    throw new Error('No audio was recorded. Try again and speak after the indicator appears.');
  }

  const explicit = preferProvider === 'groq' || preferProvider === 'openai';
  const hasOwnKey = explicit
    ? !!(apiKeys[preferProvider as AIProvider] || '').trim()
    : !!(apiKeys.groq || apiKeys.openai);
  const runOnce = (lang?: string) =>
    hasOwnKey ? transcribeDirect(blob, apiKeys, lang, prompt, signal, preferProvider) : transcribeViaServer(blob, lang, prompt, signal);

  const text = await runOnce(language);

  // Auto-detect safety net: if Whisper guessed a non-Latin script (the JP/CN failure mode),
  // retry once with the user's forced language. Only when we actually auto-detected.
  const autoDetected = !language || language === 'auto';
  if (autoDetected && fallbackLanguage && fallbackLanguage !== 'auto' && looksWrongScript(text)) {
    console.warn(`[STT] auto-detect returned non-Latin script, retrying as '${fallbackLanguage}'`);
    try {
      return await runOnce(fallbackLanguage);
    } catch {
      return text; // retry failed (e.g. network) -> keep the original rather than nothing
    }
  }
  return text;
}
