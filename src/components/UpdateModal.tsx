import { useState } from 'react';
import { Download, RefreshCw, AlertTriangle, X, ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { UpdatePhase, UpdateInfo } from '@/hooks/useUpdater';

interface UpdateModalProps {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: number; // 0..1
  error: string | null;
  onInstall: () => void;
  onDismiss: () => void;
  onRetry: () => void;
  onSkip: () => void;
}

// Confirm-before-install update dialog. Never installs silently — the user sees the
// new version + release notes and decides. Shows download progress, then an
// "installing / will restart" state.
export default function UpdateModal({ phase, info, progress, error, onInstall, onDismiss, onRetry, onSkip }: UpdateModalProps) {
  const { t } = useI18n();
  const [showNotes, setShowNotes] = useState(false);
  const visible = phase === 'available' || phase === 'downloading' || phase === 'installing' || phase === 'error';
  if (!visible) return null;

  const busy = phase === 'downloading' || phase === 'installing';
  const pct = Math.round(progress * 100);

  // Notes arrive from the manifest as "• line\n• line…" — render as a clean list. A single
  // paragraph (older manifests) falls back to plain text.
  const noteLines = (info?.notes || '')
    .split('\n')
    .map((l) => l.replace(/^[•\-]\s*/, '').trim())
    .filter(Boolean);
  const notesPanel = (
    <div className="bg-[#252526] rounded-lg p-3 max-h-52 overflow-y-auto">
      <span className="text-[11px] font-medium text-white/40 uppercase tracking-wide">{t('updateWhatsNew')}</span>
      {noteLines.length > 1 ? (
        <ul className="mt-1.5 space-y-1.5">
          {noteLines.map((line, i) => (
            <li key={i} className="flex gap-2 text-[12.5px] text-white/80 leading-relaxed">
              <span className="text-cyan-400 shrink-0 mt-[1px]">•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[12.5px] text-white/80 whitespace-pre-line leading-relaxed">
          {info?.notes?.trim() || t('updateGenericNotes')}
        </p>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className={`p-2 rounded-lg ${phase === 'error' ? 'bg-red-500/20' : 'bg-cyan-500/20'}`}>
            {phase === 'error'
              ? <AlertTriangle size={20} className="text-red-400" />
              : busy
                ? <RefreshCw size={20} className="text-cyan-400 animate-spin" />
                : <Download size={20} className="text-cyan-400" />}
          </div>
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-white/90">
              {phase === 'error' ? t('updateFailed')
                : phase === 'installing' ? t('updateInstalling')
                : phase === 'downloading' ? t('updateDownloading')
                : t('updateAvailable')}
            </h2>
            {info && phase !== 'error' && (
              <p className="text-[12px] text-white/50">v{info.currentVersion} → <span className="text-cyan-400 font-medium">v{info.version}</span></p>
            )}
          </div>
          {phase !== 'installing' && (
            <button onClick={onDismiss} className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/80" aria-label="close">
              <X size={16} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 pb-4">
          {phase === 'available' && info && notesPanel}

          {phase === 'downloading' && (
            <div className="py-1 space-y-3">
              <div>
                <div className="h-2 w-full rounded-full bg-[#2a2a2a] overflow-hidden">
                  <div className="h-full bg-cyan-500 transition-[width] duration-200" style={{ width: `${pct || 4}%` }} />
                </div>
                <p className="mt-2 text-[12px] text-white/50 text-center">{pct > 0 ? `${pct}%` : t('updateStarting')}</p>
              </div>
              {/* Something to read while waiting: a small toggle revealing the release notes */}
              {info?.notes && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setShowNotes((v) => !v)}
                    className="flex items-center gap-1 text-[11.5px] text-white/45 hover:text-white/80 transition-colors mx-auto"
                  >
                    {showNotes ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {t('updateWhatsNew')}
                  </button>
                  {showNotes && notesPanel}
                </div>
              )}
            </div>
          )}

          {phase === 'installing' && (
            <p className="text-[12.5px] text-white/70 py-2 text-center">{t('updateRestartNote')}</p>
          )}

          {phase === 'error' && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-[12.5px] text-red-300/90 break-words">{error || 'Unknown error'}</p>
              <p className="mt-1 text-[11px] text-white/40">{t('updateManualHint')}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        {(phase === 'available' || phase === 'error') && (
          <div className="flex items-center gap-2 px-5 py-3 bg-[#181818] border-t border-[#2a2a2a]">
            {phase === 'available' && (
              <button
                onClick={onSkip}
                className="mr-auto text-[11.5px] text-white/40 hover:text-white/70 transition-colors"
              >
                {t('updateSkip')}
              </button>
            )}
            <button
              onClick={onDismiss}
              className={`${phase === 'error' ? 'ml-auto ' : ''}px-3.5 py-1.5 text-[12.5px] rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors`}
            >
              {phase === 'error' ? t('updateClose') : t('updateLater')}
            </button>
            {phase === 'error' && (
              <button
                onClick={onRetry}
                className="px-3.5 py-1.5 text-[12.5px] font-medium rounded-md bg-cyan-600 hover:bg-cyan-500 text-white transition-colors flex items-center gap-1.5"
              >
                <RefreshCw size={14} /> {t('updateRetry')}
              </button>
            )}
            {phase === 'available' && (
              <button
                onClick={onInstall}
                className="px-3.5 py-1.5 text-[12.5px] font-medium rounded-md bg-cyan-600 hover:bg-cyan-500 text-white transition-colors flex items-center gap-1.5"
              >
                <Download size={14} /> {t('updateNow')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
