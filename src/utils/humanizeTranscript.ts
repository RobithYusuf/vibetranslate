/**
 * Make a streaming-recogniser transcript readable.
 *
 * These models emit their whole vocabulary in upper case with no punctuation — "INI ADALAH
 * SUARA REAL TIME" — which is how the tokens are stored, not a fault. Pasting that into
 * someone's document is unusable, so the text is normalised here before it goes anywhere.
 *
 * Deliberately local and deterministic: it runs on every partial result while the user speaks,
 * so it cannot involve the network or a model. It fixes CASE only. Punctuation needs real
 * language understanding — there is no sherpa punctuation model for Indonesian, only zh-en,
 * English and Russian — so that is left to the existing optional AI cleanup, which already
 * runs once on the final text.
 */

// Words a reader expects to stay capitalised even mid-sentence. Kept deliberately short: a
// long list guesses wrong more often than it helps, and a wrong capital reads worse than a
// missing one.
const ALWAYS_CAPS = new Set([
  'i',
  'indonesia',
  'inggris',
  'english',
  'jakarta',
  'vibetranslate',
]);

export function humanizeTranscript(raw: string, force = false): string {
  const text = raw.trim();
  if (!text) return '';

  // Judge by PROPORTION, not by "every single letter is capital". The recogniser is not
  // uniformly loud: it emits some tokens in lower case, so a real transcript looks like
  // "ok INI ADALAH PERCOBAAN". Requiring 100% upper case meant a single stray "ok" at the
  // front made this function do nothing at all — which is exactly what shipped.
  // `force` exists because of a flicker: while a live transcript grows word by word, the
  // ratio crosses the threshold back and forth, so the SAME sentence flipped between shouted
  // and normalised on screen. Callers that know the text came from the streaming recogniser
  // pass force and get a stable result; the heuristic remains for anything else.
  // The streaming model serves eight languages including Chinese, Japanese and Thai, and it
  // has no way to be told which one is being spoken. The first moments of an utterance — a
  // breath, a keyboard clack — regularly decode as CJK ("好an terakhir…"). When the sentence
  // is overwhelmingly Latin, those characters are artifacts, not words: drop them. A genuine
  // Chinese dictation is mostly CJK and sails through untouched.
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  const cjkCount = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u0e00-\u0e7f]/g) || []).length;
  let cleaned = text;
  if (cjkCount > 0 && latinCount > cjkCount * 2) {
    cleaned = text
      .replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u0e00-\u0e7f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!force) {
    const letters = cleaned.replace(/[^A-Za-z]/g, '');
    if (letters.length < 4) return cleaned;
    const upper = (cleaned.match(/[A-Z]/g) || []).length;
    const ratio = upper / letters.length;
    // Normal prose sits far below this: even a sentence full of names rarely passes half.
    if (ratio < 0.6) return cleaned;
  }

  const lower = cleaned.toLowerCase();

  // Capitalise the first letter, and anything following sentence-ending punctuation — which
  // usually means just the first letter, since these models emit none.
  let out = lower.replace(/(^\s*|[.!?]\s+)([a-z])/g, (_, lead, ch) => lead + ch.toUpperCase());

  out = out.replace(/\b[a-z]+\b/g, (w) => (ALWAYS_CAPS.has(w) ? w[0].toUpperCase() + w.slice(1) : w));

  // The rule above lower-cases a leading "I"; put it back for the English pronoun only when it
  // stands alone.
  out = out.replace(/\bi\b/g, 'I');

  return out;
}
