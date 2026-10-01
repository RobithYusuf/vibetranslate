import { CheckCircle, AlertTriangle, ArrowRightLeft, MessageSquare, Terminal, Mic, Languages, Sparkles, Bug, Lightbulb } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/i18n';
import { LANGUAGES } from '@/utils/constants';
import { formatShortcut, isMac } from '@/utils/helpers';

interface Props {
  /** Something the app needs is not granted (Accessibility off, mic blocked). */
  permsNeedAttention: boolean;
  /** Jump to another Settings tab ('general', 'shortcuts', 'feedback'). */
  onOpenTab: (tab: 'general' | 'shortcuts' | 'feedback') => void;
}

const Kbd = ({ children, tone = 'text-white/85' }: { children: React.ReactNode; tone?: string }) => (
  <kbd className={`inline-flex items-center px-1.5 py-0.5 rounded bg-[#3c3c3c] border border-white/10 font-sans text-[11.5px] leading-none whitespace-nowrap ${tone}`}>{children}</kbd>
);

/**
 * Tutorial: what to do first, the user's ACTUAL shortcuts (read live from settings, so it never
 * shows a default the user has changed), the keys that work while recording, and where to go
 * when something breaks. Scannable rows rather than paragraphs.
 */
export default function TutorialTab({ permsNeedAttention, onOpenTab }: Props) {
  const { t } = useI18n();
  const s = useAppStore();
  const MOD = isMac() ? '⌘' : 'Ctrl';
  const targetName = LANGUAGES.find((l) => l.code === s.targetLang)?.name ?? s.targetLang;
  const voiceHow = s.voiceHoldToTalk ? t('tutVoiceHold') : t('tutVoiceToggle');

  const shortcuts: { icon: React.ReactNode; tint: string; title: string; desc: string; keys: string; hint?: string }[] = [
    { icon: <ArrowRightLeft size={14} className="text-blue-400" />, tint: 'bg-blue-500/15', title: t('tutReplace'), desc: t('tutReplaceDesc'), keys: s.shortcut },
    { icon: <MessageSquare size={14} className="text-green-400" />, tint: 'bg-green-500/15', title: t('tutPopup'), desc: t('tutPopupDesc'), keys: s.popupShortcut },
    { icon: <Terminal size={14} className="text-amber-400" />, tint: 'bg-amber-500/15', title: t('tutCli'), desc: t('tutCliDesc'), keys: s.terminalShortcut },
  ];
  if (s.voiceEnabled) {
    shortcuts.push(
      { icon: <Mic size={14} className="text-cyan-400" />, tint: 'bg-cyan-500/15', title: t('tutVoiceTranslate'), desc: t('tutVoiceTranslateDesc'), keys: s.voiceShortcut, hint: voiceHow },
      { icon: <Mic size={14} className="text-cyan-400" />, tint: 'bg-cyan-500/15', title: t('tutVoiceText'), desc: t('tutVoiceTextDesc'), keys: s.voiceOriginalShortcut, hint: voiceHow },
    );
  }

  return (
    <div className="space-y-4 w-full">
      {/* 1. Get started: three steps, the first one live-checked */}
      <section className="bg-[#252526] rounded-lg p-4">
        <h3 className="text-[14px] font-semibold text-white mb-3">{t('tutSetupTitle')}</h3>
        <ol className="space-y-2.5">
          {isMac() && (
            <li className="flex items-center gap-3">
              {permsNeedAttention
                ? <AlertTriangle size={16} className="text-amber-400 shrink-0" />
                : <CheckCircle size={16} className="text-green-400 shrink-0" />}
              <span className={`flex-1 text-[13px] ${permsNeedAttention ? 'text-white/85' : 'text-white/55'}`}>
                {permsNeedAttention ? t('tutStepPerms') : t('tutStepPermsOk')}
              </span>
              {permsNeedAttention && (
                <button onClick={() => onOpenTab('general')} className="shrink-0 px-2.5 py-1 text-[12px] font-medium bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors">
                  {t('tutFixNow')}
                </button>
              )}
            </li>
          )}
          <li className="flex items-center gap-3">
            <Languages size={16} className="text-blue-400 shrink-0" />
            <span className="flex-1 text-[13px] text-white/85">
              {t('tutStepLang')} <span className="text-white/45">({t('tutStepLangNow')} {targetName})</span>
            </span>
            <button onClick={() => onOpenTab('general')} className="shrink-0 px-2.5 py-1 text-[12px] bg-white/5 hover:bg-white/10 text-white/70 rounded border border-white/10 transition-colors">
              {t('tutChange')}
            </button>
          </li>
          <li className="flex items-center gap-3">
            <Sparkles size={16} className="text-purple-400 shrink-0" />
            <span className="flex-1 text-[13px] text-white/85">{t('tutStepUse')}</span>
          </li>
        </ol>
      </section>

      {/* 2. The user's own shortcuts */}
      <section className="bg-[#252526] rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[14px] font-semibold text-white">{t('tutShortcutsTitle')}</h3>
          <button onClick={() => onOpenTab('shortcuts')} className="px-2.5 py-1 text-[12px] bg-white/5 hover:bg-white/10 text-white/70 rounded border border-white/10 transition-colors">
            {t('tutChange')}
          </button>
        </div>
        <ul className="divide-y divide-white/5">
          {shortcuts.map((sc) => (
            <li key={sc.title} className="flex items-center gap-3 py-2.5">
              <span className={`w-7 h-7 rounded-md grid place-items-center shrink-0 ${sc.tint}`}>{sc.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-white/90">{sc.title}</div>
                <div className="text-[12px] text-white/45">
                  {sc.desc}{sc.hint && <span className="text-white/35"> · {sc.hint}</span>}
                </div>
              </div>
              <Kbd>{formatShortcut(sc.keys)}</Kbd>
            </li>
          ))}
        </ul>
      </section>

      {/* 3. Keys while recording (voice only) */}
      {s.voiceEnabled && (
        <section className="bg-[#252526] rounded-lg p-4">
          <h3 className="text-[14px] font-semibold text-white mb-3">{t('tutRecordingTitle')}</h3>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-white/60">
            <span className="flex items-center gap-1.5"><Kbd>↵</Kbd> {t('tutKeyPaste')}</span>
            <span className="flex items-center gap-1.5"><Kbd>esc</Kbd> {t('tutKeyCancel')}</span>
          </div>
          {s.voiceLiveMode && (
            <div className="mt-3 pt-3 border-t border-white/5">
              <div className="text-[11.5px] uppercase tracking-wide text-white/35 mb-2">{t('tutLiveOnly')}</div>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-white/60">
                <span className="flex items-center gap-1.5"><Kbd>⌫</Kbd> {t('tutKeyDeleteWord')}</span>
                <span className="flex items-center gap-1.5"><Kbd>{MOD} ⌫</Kbd> {t('tutKeyClear')}</span>
                <span className="flex items-center gap-1.5"><Kbd>{MOD} Z</Kbd> {t('tutKeyUndo')}</span>
              </div>
            </div>
          )}
          <p className="mt-3 text-[12px] text-white/40">{t('tutRecordingNote')}</p>
        </section>
      )}

      {/* 4. Good to know */}
      <section className="bg-[#252526] rounded-lg p-4">
        <h3 className="text-[14px] font-semibold text-white mb-2.5 flex items-center gap-2">
          <Lightbulb size={15} className="text-amber-400" /> {t('tutTipsTitle')}
        </h3>
        <ul className="space-y-1.5 text-[12.5px] text-white/55">
          <li><strong className="text-white/80 font-medium">{t('tipAlwaysRunning')}</strong> {t('tipAlwaysRunningDesc')}</li>
          <li><strong className="text-white/80 font-medium">{t('tipBuiltinFree')}</strong> {t('tipBuiltinFreeDesc')} <strong className="text-white/80 font-medium">{t('tipOwnApiKey')}</strong> {t('tipOwnApiKeyDesc')}</li>
          <li><strong className="text-white/80 font-medium">{t('tipMessagingApps')}</strong> {t('tipMessagingAppsDesc')}</li>
          <li><strong className="text-white/80 font-medium">{t('tutTipMouse')}</strong> {t('tutTipMouseDesc')}</li>
          {s.enhanceEnabled && (
            <li><strong className="text-purple-300 font-medium">{t('enhanceModeActive')}</strong> {t('enhanceModeActiveDesc')}</li>
          )}
        </ul>
      </section>

      {/* 5. Help */}
      <section className="bg-[#252526] rounded-lg p-4 flex items-start gap-3">
        <span className="w-7 h-7 rounded-md grid place-items-center shrink-0 bg-rose-500/15"><Bug size={14} className="text-rose-400" /></span>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="text-[13px] font-medium text-white/90">{t('tutHelpTitle')}</div>
          <p className="text-[12px] text-white/50">{t('tutHelpDiag')}</p>
          {s.voiceEnabled && <p className="text-[12px] text-white/50">{t('tutHelpMic')}</p>}
        </div>
        <button onClick={() => onOpenTab('feedback')} className="shrink-0 px-2.5 py-1 text-[12px] bg-white/5 hover:bg-white/10 text-white/70 rounded border border-white/10 transition-colors">
          {t('tutOpen')}
        </button>
      </section>
    </div>
  );
}
