import { humanizeTranscript } from '@/utils/humanizeTranscript';

/**
 * Editable live-dictation text: what the user has said so far, minus what they deleted.
 *
 * The streaming recogniser keeps revising the sentence it is hearing, so words cannot simply be
 * hidden: its next partial would bring them back. An edit therefore first COMMITS the current
 * segment (Rust flushes the recogniser's look-ahead and starts a new stream, see
 * stream_stt_commit), and only frozen text is ever edited. The text after that comes from a new
 * segment; partials still in flight from the old one carry an older `seg` and are ignored.
 *
 * `committed` is stored already humanized, so the word Backspace removes is exactly the last
 * word the user can see.
 */
export class LiveEditor {
  /** Frozen, editable text (humanized). */
  committed = '';
  /** Raw partial of the segment currently being recognised. */
  live = '';
  private minSeg = 0;
  private undoStack: string[] = [];

  reset(): void {
    this.committed = '';
    this.live = '';
    this.minSeg = 0;
    this.undoStack = [];
  }

  /** True while any deletion is still in effect (undoing everything clears it). */
  get edited(): boolean {
    return this.undoStack.length > 0;
  }

  /** Apply a recogniser partial. Returns false for a stale one from an earlier segment. */
  onPartial(text: string, seg: number): boolean {
    if (seg < this.minSeg) return false;
    if (text === this.live) return false;
    this.live = text;
    return true;
  }

  /** Freeze the flushed text of the segment that just ended; `seg` is the new segment's id. */
  absorb(flushed: string, seg: number): void {
    this.committed = humanizeTranscript(join(this.committed, flushed), true);
    this.live = '';
    this.minSeg = seg;
  }

  deleteWord(): boolean {
    const words = this.committed.split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    this.undoStack.push(this.committed);
    words.pop();
    this.committed = words.join(' ');
    return true;
  }

  clearAll(): boolean {
    if (!this.committed) return false;
    this.undoStack.push(this.committed);
    this.committed = '';
    return true;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (prev === undefined) return false;
    this.committed = prev;
    return true;
  }

  /** Split for display: frozen text, then the part still being recognised. */
  view(): { committed: string; live: string; full: string } {
    const full = humanizeTranscript(join(this.committed, this.live), true);
    if (!this.committed) return { committed: '', live: full, full };
    if (full.startsWith(this.committed)) {
      return { committed: this.committed, live: full.slice(this.committed.length).trim(), full };
    }
    // Humanizing the joined text changed the frozen part (a capital at the boundary): show it
    // whole rather than splitting it wrongly.
    return { committed: full, live: '', full };
  }

  /** Final text once the recogniser has flushed its last segment. */
  finalText(flushedLast: string): string {
    return humanizeTranscript(join(this.committed, flushedLast), true);
  }
}

function join(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  return x && y ? `${x} ${y}` : x || y;
}
