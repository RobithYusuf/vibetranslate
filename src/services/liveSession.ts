import { startLive, pushLive, finishLive, cancelLive } from './sttStream';

/**
 * One live-dictation session: model startup, audio queueing, and teardown, in one place.
 *
 * This logic first lived inline in RecordingOverlay and grew three subtleties that were easy
 * to break by touching the component:
 *
 * 1. Recording must start IMMEDIATELY, before the model has loaded. Loading takes seconds the
 *    first time, and words spoken during a wait are words lost — so audio is queued here and
 *    handed over the moment the recogniser is up.
 * 2. Chunks must stay ordered. Everything flows through one sequential drain, even after the
 *    model is ready; pushing a fresh chunk directly would let it overtake queued audio and
 *    scramble the transcript.
 * 3. The queue must be bounded. It also absorbs the model-load window, so a failed start
 *    would otherwise grow it for the whole dictation (~30s cap = 150 chunks of 200ms).
 */
export class LiveSession {
  private queue: Int16Array[] = [];
  private drainPromise: Promise<void> | null = null;
  private active = false;
  private failed = false;
  private cancelled = false;
  private onUnavailable?: (err: unknown) => void;

  /** True once the recogniser is up and consuming audio. */
  get isActive(): boolean {
    return this.active;
  }

  /** Begin bringing the model up. Never awaited by the caller — see note 1 above. */
  begin(onUnavailable?: (err: unknown) => void): void {
    this.queue = [];
    this.failed = false;
    this.onUnavailable = onUnavailable;
    void startLive()
      .then(() => {
        // The load can outlive the dictation: a session cancelled while its model was
        // still loading must stay dead, not wake up and start consuming.
        if (this.cancelled) return;
        this.active = true;
        void this.drain();
      })
      .catch((e) => {
        // Model missing or failed to load: the caller falls back to one-shot transcription
        // rather than refusing to record. The user still gets their dictation.
        this.failed = true;
        this.queue = [];
        onUnavailable?.(e);
      });
  }

  /** Called from the audio tap with each ~200ms PCM chunk. */
  feed(pcm: Int16Array): void {
    if (this.failed || this.cancelled) return;
    this.queue.push(pcm);
    if (this.queue.length > 150) {
      // The cap is only ever hit while the model is still loading. Splicing chunks out of
      // the middle of a stateful stream garbles it — but the one-shot fallback still has
      // the COMPLETE recording blob, so failing over loses nothing at all.
      this.failed = true;
      this.queue = [];
      this.onUnavailable?.(new Error('model load outlasted the audio queue'));
      return;
    }
    void this.drain();
  }

  /** Flush the recogniser and return the final text. The session ends here. */
  async finish(): Promise<string> {
    // Let the queue empty first: an in-flight push racing stream_stt_finish could land its
    // 200ms of audio on the NEXT utterance's fresh stream, opening it with a stray syllable.
    await (this.drainPromise ?? Promise.resolve());
    await this.drain();
    this.active = false;
    return finishLive();
  }

  /** Abandon without producing text. Safe to call while startup is still in flight — the
   *  recogniser side treats cancel of a not-yet-started session as a no-op. */
  cancel(): void {
    this.cancelled = true;
    this.active = false;
    this.queue = [];
    void cancelLive();
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    // The reset MUST live outside the async body. An async IIFE runs synchronously until its
    // first await, so when there is nothing to drain — which is every call made while the
    // model is still loading — the body reached `drainPromise = null` BEFORE the outer
    // assignment overwrote it with the (already resolved) promise. From then on the guard
    // above returned that stale promise forever and pushLive was never called again: the
    // recogniser received zero audio and every dictation came back empty.
    const run = async () => {
      while (this.active && this.queue.length) {
        const pcm = this.queue.shift();
        if (pcm) {
          try {
            await pushLive(pcm);
          } catch {
            /* a dropped chunk costs a word, not the session */
          }
        }
      }
    };
    const p = run().finally(() => {
      if (this.drainPromise === p) this.drainPromise = null;
    });
    this.drainPromise = p;
    return p;
  }
}
