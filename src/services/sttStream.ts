import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// Live dictation: text appears while you speak, and is inserted into your app ONCE, at the end.
// Not a typing-as-you-speak feature — see the note at the top of src-tauri/src/stt_stream.rs
// for why that is a trap for an app that pastes via the clipboard.

export const LIVE_MODEL_ID = 'streaming-multi';

export interface PartialTranscript {
  text: string;
  isFinal: boolean;
}

export async function startLive(): Promise<void> {
  await invoke('stream_stt_start', { modelId: LIVE_MODEL_ID });
}

export async function pushLive(pcm: Int16Array): Promise<void> {
  // btoa over a binary string: the chunk is 6.4KB, so the copy is not worth optimising until
  // profiling says otherwise.
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  await invoke('stream_stt_push', { samplesB64: btoa(binary), sampleRate: 16000 });
}

export async function finishLive(): Promise<string> {
  return await invoke<string>('stream_stt_finish');
}

export async function cancelLive(): Promise<void> {
  await invoke('stream_stt_cancel');
}

/**
 * Load the model ahead of time, so the FIRST press of the voice shortcut is as instant as
 * every later one. Without this the first dictation pays several seconds of model loading —
 * and a user who is already speaking loses those words.
 */
export async function warmLive(): Promise<void> {
  await invoke('stream_stt_start', { modelId: LIVE_MODEL_ID });
}

/** Free the model when live dictation is switched off. It holds a few hundred megabytes. */
export async function releaseLive(): Promise<void> {
  await invoke('stream_stt_release');
}

export function onLiveTranscript(cb: (p: PartialTranscript) => void): Promise<UnlistenFn> {
  return listen<{ text: string; is_final: boolean }>('live-transcript', (e) =>
    cb({ text: e.payload.text, isFinal: e.payload.is_final }),
  );
}
