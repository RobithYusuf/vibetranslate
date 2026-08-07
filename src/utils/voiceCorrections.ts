// User-defined voice correction dictionary: deterministic find-and-replace applied to the
// TRANSCRIPT (after Whisper, before translate/paste). This exists because prompt-biasing the
// STT model proved too weak to fix habitual mis-hearings ("podman" -> "kuotman"); a plain
// post-processing replace is reliable. Applies to voice input only — never to normal translate.

export interface VoiceCorrection {
  from: string; // what the STT typically (mis)hears
  to: string;   // what it should become
}

export const MAX_CORRECTIONS = 100;
export const MAX_CORRECTION_LEN = 60;

// Validate + normalize an arbitrary loaded value into a safe corrections list.
export function sanitizeCorrections(value: unknown): VoiceCorrection[] {
  if (!Array.isArray(value)) return [];
  const out: VoiceCorrection[] = [];
  for (const item of value) {
    if (out.length >= MAX_CORRECTIONS) break;
    if (!item || typeof item !== 'object') continue;
    const from = String((item as VoiceCorrection).from ?? '').trim().slice(0, MAX_CORRECTION_LEN);
    const to = String((item as VoiceCorrection).to ?? '').trim().slice(0, MAX_CORRECTION_LEN);
    if (from) out.push({ from, to });
  }
  return out;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Apply the dictionary to a transcript. Case-insensitive, whole-word ("word boundary" defined
// as not-adjacent-to-a-letter/digit so it works for non-Latin scripts too). When the matched
// text starts with an uppercase letter, the replacement's first letter is uppercased as well,
// so sentence-initial words stay capitalized.
export function applyVoiceCorrections(text: string, corrections: VoiceCorrection[]): string {
  let result = text;
  for (const { from, to } of corrections) {
    if (!from) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(from)}(?![\\p{L}\\p{N}])`, 'giu');
    result = result.replace(re, (match) => {
      const upper = match.charAt(0) === match.charAt(0).toUpperCase() && match.charAt(0) !== match.charAt(0).toLowerCase();
      return upper && to ? to.charAt(0).toUpperCase() + to.slice(1) : to;
    });
  }
  return result;
}
