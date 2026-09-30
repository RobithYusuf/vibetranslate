import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { onLiveTranscript } from '@/services/sttStream';

const IS_MAC = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/**
 * Live transcript, in its own window under the listening pill.
 *
 * Separate from RecordingOverlay on purpose. The first version grew that pill to fit the text,
 * and the text ended up crowding the level bars and the done/cancel buttons — precisely what
 * the user is watching while they speak. Keeping them apart means the listening indicator is
 * exactly what it was before live dictation existed.
 *
 * Everything here is provisional by nature: these words WILL change as the recogniser hears
 * more, so they are styled as a draft, and only the final text is ever pasted anywhere.
 */
export function TranscriptOverlay() {
  // Frozen (editable) text and the part still being recognised, from RecordingOverlay, which
  // owns the dictation. `keys`: whether edit keys reach the overlay right now (they do only
  // while one of our windows holds the keyboard; on Windows it may not).
  const [committed, setCommitted] = useState('');
  const [live, setLive] = useState('');
  const [keys, setKeys] = useState(false);
  const [finishKey, setFinishKey] = useState('');
  const [holdToTalk, setHoldToTalk] = useState(false);
  const [focused, setFocused] = useState(false);
  const text = committed || live;
  const boxRef = useRef<HTMLDivElement>(null);
  const hintsRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLParagraphElement>(null);
  // When the user scrolled up on purpose, reading back, the tail-follow waits instead of
  // yanking the view down on every new word.
  const userScrolledAtRef = useRef(0);

  // Round the NATIVE window, the same way the listening pill does. rounded-2xl on the div
  // only curves the content — the rectangular webview showed through at the corners as four
  // pale wedges, which is exactly how it was reported.
  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    if (isMac) {
      const moduleName = '@cloudworxx/tauri-plugin-mac-rounded-corners';
      import(/* @vite-ignore */ moduleName)
        .then((mod) => { mod.enableModernWindowStyle({ cornerRadius: 16 }).catch(() => {}); })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    onLiveTranscript((p) => {
      // A final result means the window is about to hide; clearing here keeps the PREVIOUS
      // session's sentence from flashing up when the next session opens the window.
      if (p.isFinal) { setCommitted(''); setLive(''); }
    }).then((f) => { un = f; });
    const unView = listen<{ committed: string; live: string; keys: boolean; finishKey?: string; holdToTalk?: boolean }>('transcript-view', (e) => {
      setCommitted(e.payload.committed);
      setLive(e.payload.live);
      setKeys(e.payload.keys);
      setFinishKey(e.payload.finishKey || '');
      setHoldToTalk(!!e.payload.holdToTalk);
    });
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      un?.();
      unView.then((f) => f());
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Enter/Esc must work no matter which of the two overlay windows happens to hold the
  // keyboard. When this window appeared it could take key focus from the listening pill, and
  // then Enter went nowhere — the user was left clicking the checkmark by hand. Rather than
  // fight over focus, both windows drive the same events.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); void emitTo('recording', 'voice-stop'); }
      else if (e.key === 'Escape') { e.preventDefault(); void emitTo('recording', 'voice-cancel'); }
      else if (e.key === 'Backspace') { e.preventDefault(); void emitTo('recording', 'voice-edit', e.metaKey || e.ctrlKey ? 'all' : 'word'); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); void emitTo('recording', 'voice-edit', 'undo'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Follow the tail: a long dictation should show what was said last, not the beginning —
  // unless the user scrolled up in the last few seconds to read something back.
  // And size the window to the content; Rust caps it relative to the screen, after which the
  // text scrolls inside it.
  const lastHeightRef = useRef(0);
  useEffect(() => {
    const el = boxRef.current;
    if (el && Date.now() - userScrolledAtRef.current > 3000) el.scrollTop = el.scrollHeight;
    if (!el) return;
    // The text's own height, not the box's: the box fills the window, so measuring it could
    // only ever grow the window, never shrink it back after a deletion. 14 = the box padding.
    const want = Math.ceil((contentRef.current?.offsetHeight ?? 0) + 14 + (hintsRef.current?.offsetHeight ?? 0));
    if (Math.abs(want - lastHeightRef.current) < 4) return;
    lastHeightRef.current = want;
    void invoke('resize_transcript_window', { height: want }).catch(() => { /* cosmetic */ });
  }, [committed, live, keys, focused]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    userScrolledAtRef.current = atBottom ? 0 : Date.now();
  };

  const keysHere = keys || focused;

  return (
    <div className="h-screen w-screen flex flex-col bg-[#1c1c1e]/90 overflow-hidden select-none">
      <div ref={boxRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-3 pt-2 pb-1.5">
        {text ? (
          <p ref={contentRef} className="text-[13px] leading-relaxed">
            {/* Frozen text is final and editable; the rest can still change as the
                recogniser hears more, so it is drawn lighter. */}
            {committed && <span className="text-white/85">{committed}</span>}
            {committed && live && ' '}
            {live && <span className="text-white/55">{live}</span>}
            {/* Static, not pulsing. A blinking caret next to text that is ALREADY changing on
                its own reads as the whole overlay flickering — which is exactly how it was
                reported. The text updating is signal enough that something is happening. */}
            <span className="ml-1 inline-block h-[12px] w-[2px] translate-y-[2px] bg-white/30" />
          </p>
        ) : (
          <p ref={contentRef} className="text-[12px] italic text-white/25">Mendengarkan…</p>
        )}
      </div>
      {/* One quiet line. With the keyboard here: the edit keys. Without it (another app in
          front): only how to finish — the pill above already says it is still listening. */}
      {text && (
        <div ref={hintsRef} className="shrink-0 px-3 pb-1.5 text-[10.5px] text-white/35 flex flex-wrap gap-x-3">
          {keysHere ? (
            <>
              <span><kbd className="font-sans text-white/55">⌫</kbd> hapus kata</span>
              <span><kbd className="font-sans text-white/55">{MOD}⌫</kbd> hapus semua</span>
              <span><kbd className="font-sans text-white/55">{MOD}Z</kbd> urungkan</span>
              <span><kbd className="font-sans text-white/55">↵</kbd> tempel</span>
              <span><kbd className="font-sans text-white/55">esc</kbd> batal</span>
            </>
          ) : finishKey ? (
            <span>{holdToTalk ? 'Lepas' : 'Tekan'} <kbd className="font-sans text-white/55">{finishKey}</kbd> untuk selesai</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
