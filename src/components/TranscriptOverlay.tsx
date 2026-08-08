import { useEffect, useRef, useState } from 'react';
import { emitTo } from '@tauri-apps/api/event';
import { onLiveTranscript } from '@/services/sttStream';
import { humanizeTranscript } from '@/utils/humanizeTranscript';

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
  const [text, setText] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

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
      if (p.isFinal) setText('');
      else setText(humanizeTranscript(p.text, true));
    }).then((f) => { un = f; });
    return () => { un?.(); };
  }, []);

  // Enter/Esc must work no matter which of the two overlay windows happens to hold the
  // keyboard. When this window appeared it could take key focus from the listening pill, and
  // then Enter went nowhere — the user was left clicking the checkmark by hand. Rather than
  // fight over focus, both windows drive the same events.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); void emitTo('recording', 'voice-stop'); }
      else if (e.key === 'Escape') { e.preventDefault(); void emitTo('recording', 'voice-cancel'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Follow the tail: a long dictation should show what was said last, not the beginning.
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="h-screen w-screen bg-[#1c1c1e]/90 overflow-hidden select-none">
      <div ref={boxRef} className="h-full w-full overflow-y-auto px-3 py-2">
        {text ? (
          <p className="text-[13px] leading-relaxed text-white/80">
            {text}
            {/* Static, not pulsing. A blinking caret next to text that is ALREADY changing on
                its own reads as the whole overlay flickering — which is exactly how it was
                reported. The text updating is signal enough that something is happening. */}
            <span className="ml-1 inline-block h-[12px] w-[2px] translate-y-[2px] bg-white/30" />
          </p>
        ) : (
          <p className="text-[12px] italic text-white/25">Mendengarkan…</p>
        )}
      </div>
    </div>
  );
}
