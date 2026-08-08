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
  private draining = false;
  private active = false;
  private failed = false;

  /** True once the recogniser is up and consuming audio. */
  get isActive(): boolean {
    return this.active;
  }

  /** Begin bringing the model up. Never awaited by the caller — see note 1 above. */
  begin(onUnavailable?: (err: unknown) => void): void {
    this.queue = [];
    this.failed = false;
    void startLive()
      .then(() => {
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
    if (this.failed) return;
    this.queue.push(pcm);
    if (this.queue.length > 150) this.queue.shift();
    void this.drain();
  }

  /** Flush the recogniser and return the final text. The session ends here. */
  async finish(): Promise<string> {
    this.active = false;
    return finishLive();
  }

  /** Abandon without producing text. Safe to call while startup is still in flight — the
   *  recogniser side treats cancel of a not-yet-started session as a no-op. */
  cancel(): void {
    this.active = false;
    this.queue = [];
    void cancelLive();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
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
    this.draining = false;
  }
}
