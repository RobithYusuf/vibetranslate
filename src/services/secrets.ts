import { invoke } from '@tauri-apps/api/core';
import type { AIProvider } from '@/types';

// API keys live in the OS credential store (Keychain on macOS, Credential Manager on
// Windows), not in settings.json. They used to sit in that file at 0644, readable by any
// process running as the user.
//
// Everything here fails soft on READ and loud on WRITE: a store that cannot be reached should
// not stop the app from starting, but it must not silently swallow a key the user just typed
// and leave them believing it was saved.

const PROVIDERS: AIProvider[] = ['server', 'openai', 'openrouter', 'groq', 'gemini', 'custom'];

const keyFor = (provider: AIProvider) => `apikey-${provider}`;

export async function getApiKey(provider: AIProvider): Promise<string | null> {
  try {
    return await invoke<string | null>('secret_get', { key: keyFor(provider) });
  } catch (e) {
    console.warn('[Secrets] read failed for', provider, e);
    return null;
  }
}

export async function setApiKey(provider: AIProvider, value: string | null): Promise<void> {
  await invoke('secret_set', { key: keyFor(provider), value: value ?? '' });
}

export async function loadAllApiKeys(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  await Promise.all(
    PROVIDERS.map(async (p) => {
      out[p] = await getApiKey(p);
    }),
  );
  return out;
}

export async function saveAllApiKeys(keys: Record<string, string | null>): Promise<void> {
  // Sequential on purpose: some credential stores serialise writes anyway, and a partial
  // failure is easier to reason about than six racing ones.
  for (const p of PROVIDERS) {
    await setApiKey(p, keys[p] ?? null);
  }
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
  for (const [provider, value] of present) {
    await setApiKey(provider as AIProvider, value as string);
  }
  console.log(`[Secrets] migrated ${present.length} API key(s) out of the settings file`);
  return true;
}
