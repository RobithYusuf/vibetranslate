import { invoke } from '@tauri-apps/api/core';
import type { AIProvider } from '@/types';
import { diag } from '@/services/diag';

// API keys live in the OS credential store (Keychain on macOS, Credential Manager on
// Windows), not in settings.json. They used to sit in that file at 0644, readable by any
// process running as the user.
//
// Everything here fails soft on READ and loud on WRITE: a store that cannot be reached should
// not stop the app from starting, but it must not silently swallow a key the user just typed
// and leave them believing it was saved.
//
// ONE credential holds every key (JSON). It used to be one item per provider, and macOS asks
// for the login password once PER ITEM whenever the app's signature changes: moving to a
// stable signature cost users three password prompts in a row, the last one arriving late
// enough to look like something was wrong. One item means one prompt at most, it is also one
// read per window instead of six, and one write per change.
//
// The old per-provider items are migrated once (read one at a time, so prompts never stack)
// and then left alone: deleting an item an older build created can itself prompt. If the
// combined item cannot be written (Windows caps a credential at ~2.5KB), everything falls back
// to per-provider items, so no key is ever lost.

const PROVIDERS: AIProvider[] = ['server', 'openai', 'openrouter', 'groq', 'gemini', 'custom'];
const COMBINED = 'apikeys';

const legacyKeyFor = (provider: AIProvider) => `apikey-${provider}`;

type KeyMap = Partial<Record<AIProvider, string>>;

// What the credential store holds, as far as this window knows. null = not loaded yet.
let cache: KeyMap | null = null;
// The combined item could not be written here: use per-provider items from now on.
let perProvider = false;

function toRecord(keys: KeyMap): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of PROVIDERS) out[p] = keys[p] || null;
  return out;
}

function normalize(keys: Record<string, string | null | undefined>): KeyMap {
  const out: KeyMap = {};
  for (const p of PROVIDERS) {
    const v = (keys[p] ?? '').trim();
    if (v) out[p] = v;
  }
  return out;
}

function same(a: KeyMap, b: KeyMap): boolean {
  return PROVIDERS.every((p) => (a[p] ?? '') === (b[p] ?? ''));
}

// "absent" and "error" must never be confused. Treating a failed read (store locked, prompt
// dismissed) as absent would migrate stale per-provider items over the real ones, or let the
// next save overwrite the combined item with only the key just typed.
type CombinedRead = { state: 'ok'; keys: KeyMap } | { state: 'absent' } | { state: 'error' };

async function readCombined(): Promise<CombinedRead> {
  let raw: string | null;
  try {
    raw = await invoke<string | null>('secret_get', { key: COMBINED });
  } catch (e) {
    console.warn('[Secrets] combined read failed', e);
    return { state: 'error' };
  }
  if (!raw) return { state: 'absent' };
  try {
    const parsed = JSON.parse(raw) as { v?: number; keys?: Record<string, string> };
    if (parsed && parsed.v === 1 && parsed.keys && typeof parsed.keys === 'object') {
      return { state: 'ok', keys: normalize(parsed.keys) };
    }
  } catch { /* unreadable payload: treated as an error, never overwritten blindly */ }
  return { state: 'error' };
}

async function writeCombined(keys: KeyMap): Promise<boolean> {
  try {
    await invoke('secret_set', { key: COMBINED, value: JSON.stringify({ v: 1, keys }) });
    return true;
  } catch (e) {
    console.warn('[Secrets] combined write failed, using one item per provider', e);
    return false;
  }
}

async function readLegacy(provider: AIProvider): Promise<string | null> {
  try {
    return await invoke<string | null>('secret_get', { key: legacyKeyFor(provider) });
  } catch (e) {
    console.warn('[Secrets] read failed for', provider, e);
    return null;
  }
}

async function writeLegacy(prev: KeyMap, next: KeyMap): Promise<void> {
  // Sequential on purpose: some credential stores serialise writes anyway, and a partial
  // failure is easier to reason about than six racing ones. Unchanged keys are skipped.
  for (const p of PROVIDERS) {
    if ((prev[p] ?? '') === (next[p] ?? '')) continue;
    await invoke('secret_set', { key: legacyKeyFor(p), value: next[p] ?? '' });
  }
}

export async function loadAllApiKeys(): Promise<Record<string, string | null>> {
  const combined = await readCombined();
  if (combined.state === 'ok') {
    cache = combined.keys;
    return toRecord(combined.keys);
  }
  if (combined.state === 'error') {
    // Fail soft for the app (start with no keys), but leave `cache` unset so that nothing is
    // written until a later read succeeds.
    cache = null;
    diag('keys', 'keychain read failed; keys not loaded');
    return toRecord({});
  }
  // No combined item yet: read the old per-provider items, one at a time so that any
  // password prompts come one after another rather than stacked.
  const legacy: KeyMap = {};
  for (const p of PROVIDERS) {
    const v = await readLegacy(p);
    if (v) legacy[p] = v;
  }
  cache = legacy;
  const count = Object.keys(legacy).length;
  if (count > 0 && !perProvider) {
    if (await writeCombined(legacy)) diag('keys', `moved ${count} API key(s) into one keychain item`);
    else perProvider = true;
  }
  return toRecord(legacy);
}

export async function getApiKey(provider: AIProvider): Promise<string | null> {
  if (!cache) await loadAllApiKeys();
  return cache?.[provider] ?? null;
}

export async function saveAllApiKeys(keys: Record<string, string | null>): Promise<void> {
  if (!cache) await loadAllApiKeys();
  if (!cache) {
    // The store could not be read: writing now could overwrite keys we never saw. Loud.
    throw new Error('Keychain is unavailable; API keys were not saved. Try again.');
  }
  const prev = cache;
  const next = normalize(keys);
  if (same(prev, next)) return; // nothing changed: no credential-store round-trip at all
  if (!perProvider) {
    if (await writeCombined(next)) { cache = next; return; }
    perProvider = true;
  }
  await writeLegacy(prev, next);
  cache = next;
}

export async function setApiKey(provider: AIProvider, value: string | null): Promise<void> {
  if (!cache) await loadAllApiKeys();
  await saveAllApiKeys({ ...toRecord(cache ?? {}), [provider]: value });
}

/**
 * Move keys that an older build left in settings.json into the credential store, then report
 * that the caller must rewrite the settings file WITHOUT them.
 *
 * Returns true when something was migrated. The plaintext copy is only considered gone once
 * the caller has actually saved — deleting it here, before the new copy is known good, would
 * risk losing the user's key entirely.
 */
export async function migratePlaintextKeys(
  saved: Record<string, string | null> | undefined,
): Promise<boolean> {
  if (!saved) return false;
  const present = Object.entries(saved).filter(([, v]) => !!v);
  if (present.length === 0) return false;
  if (!cache) await loadAllApiKeys();
  // Store unreadable right now: keep the plaintext copy (report nothing migrated) and retry
  // on the next start rather than risk overwriting keys we could not see.
  if (!cache) return false;
  // One write for all of them, not one per key.
  await saveAllApiKeys({ ...toRecord(cache ?? {}), ...Object.fromEntries(present) });
  console.log(`[Secrets] migrated ${present.length} API key(s) out of the settings file`);
  return true;
}
