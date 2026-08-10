import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { warmLive, releaseLive } from '@/services/sttStream';
import { 
  Key, Languages, Keyboard, Sparkles, Copy, Globe, Accessibility,
  Volume2, Loader2, CheckCircle, XCircle, BookOpen, MessageSquare, MousePointer, AlertTriangle, Mic, Palette, ChevronRight, RefreshCw, X,
  Gift, HardDrive, Lock, Cloud, Download
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useSettings } from '@/hooks/useSettings';
import { useAppStatus } from '@/hooks/useAppStatus';
import { useServerModels } from '@/hooks/useServerModels';
import toast, { Toaster } from 'react-hot-toast';
import { LANGUAGES, AI_PROVIDERS, FONT_OPTIONS, UI_SCALE_OPTIONS, fontStackFor } from '@/utils/constants';
import { CHANGELOG } from '@/utils/changelog';
import { AIProvider } from '@/types';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';
import { translateText, fetchModels } from '@/services/openai';
import APP_CONFIG from '@/config';
import Toggle from './Toggle';
import Select from './Select';
import { useI18n, UI_LANGUAGES, Language } from '@/i18n';
import logo from '@/assets/logo.png';

type TabType = 'general' | 'shortcuts' | 'appearance' | 'feedback' | 'tutorial';

// Session cache of live-fetched models, keyed by provider+baseURL+key-prefix, so
// switching providers/tabs doesn't re-hit the /models endpoint every time.
const MODEL_CACHE = new Map<string, string[]>();

interface SettingsProps {
  // Triggers the app-wide updater check (shows the update modal if one is found).
  // Returns true if an update is available. Wired from App's useUpdater.
  onCheckForUpdates?: () => Promise<boolean>;
}

export default function Settings({ onCheckForUpdates }: SettingsProps = {}) {
  const {
    appEnabled,
    settingsLoaded,
    uiLanguage,
    apiKeys,
    provider,
    model,
    customBaseURL,
    customModel,
    shortcut,
    sourceLang,
    targetLang,
    autoStart,
    enhanceEnabled,
    enhanceShortcut,
    popupShortcut,
    terminalShortcut,
    voiceEnabled,
    voiceShortcut,
    voiceOriginalShortcut,
    voiceAutoStop,
    voiceMaxMinutes,
    voiceSilenceSec,
    micDeviceId,
    lastMicUsed,
    voiceCorrections,
    voicePopupPosition,
    voiceSoundEnabled,
    micAutoGain,
    uiFont,
    uiScale,
    soundEnabled,
    loadingEnabled,
    autoUpdateCheck,
    setAutoUpdateCheck,
    setUiFont,
    setUiScale,
    setAppEnabled,
    setUiLanguage,
    setApiKey,
    setProvider,
    setModel,
    setCustomBaseURL,
    setCustomModel,
    setShortcut,
    setSourceLang,
    setTargetLang,
    setAutoStart,
    setEnhanceEnabled,
    setEnhanceShortcut,
    setPopupShortcut,
    setTerminalShortcut,
    setVoiceEnabled,
    setVoiceAutoStop,
    setVoicePopupPosition,
    setVoiceSoundEnabled,
    setMicAutoGain,
    voiceSttEngine,
    setVoiceSttEngine,
    setApiKeyFor,
    voiceCleanup,
    voiceLiveMode,
    setVoiceLiveMode,
    setVoiceCleanup,
    setVoiceMaxMinutes,
    setVoiceSilenceSec,
    setMicDeviceId,
    setVoiceCorrections,
    setVoiceShortcut,
    setVoiceOriginalShortcut,
    setSoundEnabled,
    setLoadingEnabled,
    swapLanguages,
    setRecordingShortcut,
  } = useAppStore();
  
  const { t } = useI18n();
  
  const apiKey = apiKeys[provider];

  const { save } = useSettings();
  const { warningMessage } = useAppStatus();
  const { serverModels, defaultModel: serverDefaultModel, serverAvailable } = useServerModels();

  // Models fetched live from the provider's /models endpoint (no hardcoding).
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const modelsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Get available models for selected provider (prefer live-fetched list)
  // Offline TEXT translation needs a helper binary + a 615MB model that the app cannot
  // install yet (no downloader is wired up). Offering the option regardless meant picking
  // it always failed — so it is only listed once mt_model_status() confirms it is usable.
  const [mtReady, setMtReady] = useState(false);
  useEffect(() => {
    void invoke<boolean>('mt_model_status').then(setMtReady).catch(() => setMtReady(false));
  }, []);

  const availableModels = useMemo(() => {
    if (provider === 'server' && serverAvailable && serverModels.length > 0) {
      return [
        ...serverModels.map(m => ({ id: m.id, name: m.name, free: true, isServer: true })),
        // Offline MT (OPUS-MT id<->en via CTranslate2) — lives in the model list so the
        // choice is one mental model: "which brain translates my text".
        ...(mtReady
          ? [{ id: 'offline-nllb', name: 'Offline — NLLB', free: true, isServer: true }]
          : []),
      ];
    }
    // "Auto" lets the app pick the provider's recommended model automatically.
    const auto = { id: 'auto', name: '✨ Auto (recommended)', free: false, isServer: false };
    if (provider !== 'server' && fetchedModels.length > 0) {
      return [auto, ...fetchedModels.map(id => ({ id, name: id, free: false, isServer: false }))];
    }
    if (provider !== 'server' && provider !== 'custom') {
      return [auto, ...AI_PROVIDERS[provider].models.map(m => ({ ...m, isServer: false }))];
    }
    return AI_PROVIDERS[provider].models.map(m => ({ ...m, isServer: false }));
  }, [provider, serverAvailable, serverModels, fetchedModels, mtReady]);
  
  // Filter providers - only show 'server' if serverAvailable
  const availableProviders = useMemo(() => {
    return (Object.keys(AI_PROVIDERS) as AIProvider[]).filter(p => {
      if (p === 'server') return serverAvailable;
      return true;
    });
  }, [serverAvailable]);

  // Fetch the live model list from the provider's /models endpoint (debounced).
  // Works for OpenAI/Groq/Gemini/OpenRouter and any custom base URL — no hardcoding.
  useEffect(() => {
    if (provider === 'server') { setFetchedModels([]); setModelsLoading(false); return; }
    const baseURL = provider === 'custom' ? customBaseURL : AI_PROVIDERS[provider].baseURL;
    const key = apiKeys[provider] || '';
    if (!baseURL || (!key && provider !== 'openrouter')) { setFetchedModels([]); setModelsLoading(false); return; }

    // Cache hit -> show instantly, no network call.
    const cacheKey = `${provider}|${baseURL}|${key.slice(0, 10)}`;
    const cached = MODEL_CACHE.get(cacheKey);
    if (cached) { setFetchedModels(cached); setModelsLoading(false); return; }

    setFetchedModels([]);
    if (modelsTimeoutRef.current) clearTimeout(modelsTimeoutRef.current);
    setModelsLoading(true);
    modelsTimeoutRef.current = setTimeout(async () => {
      const ids = await fetchModels(baseURL, key);
      setModelsLoading(false);
      if (ids && ids.length) { MODEL_CACHE.set(cacheKey, ids); setFetchedModels(ids); }
    }, 600);
    return () => { if (modelsTimeoutRef.current) clearTimeout(modelsTimeoutRef.current); };
  }, [provider, customBaseURL, apiKeys]);

  // Auto-select server default model when switching to server provider
  useEffect(() => {
    if (provider === 'server' && serverAvailable && serverDefaultModel) {
      // 'offline-nllb' is a valid client-side choice that is never in the server's list
      const modelExists = model === 'offline-nllb' || serverModels.some(m => m.id === model);
      if (!modelExists || !model) {
        console.log('[Settings] Auto-selecting server default model:', serverDefaultModel);
        setModel(serverDefaultModel);
      }
    }
  }, [provider, serverAvailable, serverDefaultModel, serverModels, model, setModel]);
  const [activeTab, setActiveTab] = useState<TabType>('general');
  const [showApiKey, setShowApiKey] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState<'translate' | 'popup' | 'terminal' | 'enhance' | 'voice' | 'voiceOriginal' | null>(null);

  // Microphone list for the voice-input device picker. Labels only appear once the app has mic
  // permission (a granted recording session); before that we fall back to a generic name.
  const [micList, setMicList] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setMicList(
          devices
            .filter((d) => d.kind === 'audioinput')
            .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
            .filter((d) => d.id && d.id !== 'default')
        );
      } catch { /* enumeration unavailable */ }
    };
    void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  // Voice-correction draft row (added to the dictionary on +).
  const [corrFrom, setCorrFrom] = useState('');
  const [dictQuery, setDictQuery] = useState('');
  // Offline STT models: curated registry (id -> download size label), install status per
  // model, and live download progress (events from download_stt_model).
  const LOCAL_STT_MODELS: Record<string, { size: string }> = {
    'omnilingual-300m': { size: '348 MB' },
    'whisper-turbo': { size: '987 MB' },
    'parakeet-v3': { size: '640 MB' },
    // The live-dictation model. Listed here so it shares the status check and the download
    // progress plumbing; it is not offered in the one-shot engine dropdown because it is a
    // streaming model driven by the live path, not by transcribe_local.
    'streaming-multi': { size: '340 MB' },
  };
  const [sttReady, setSttReady] = useState<Record<string, boolean>>({});
  // Keyed by model id: two download UIs render from this (the engine card and the live
  // dictation row), and a single shared value made each show the OTHER's progress.
  const [sttDl, setSttDl] = useState<Record<string, { received: number; total: number }>>({});
  useEffect(() => {
    for (const id of Object.keys(LOCAL_STT_MODELS)) {
      void invoke<boolean>('stt_model_status', { modelId: id })
        .then((ok) => setSttReady((r) => ({ ...r, [id]: ok })))
        .catch(() => setSttReady((r) => ({ ...r, [id]: false })));
    }
    const un = listen<{ model: string; received: number; total: number; done: boolean }>('stt-download-progress', (e) => {
      if (e.payload.done) {
        setSttDl((d) => { const n = { ...d }; delete n[e.payload.model]; return n; });
        void invoke<boolean>('stt_model_status', { modelId: e.payload.model })
          .then((ok) => setSttReady((r) => ({ ...r, [e.payload.model]: ok })))
          .catch(() => {});
      } else {
        setSttDl((d) => ({ ...d, [e.payload.model]: { received: e.payload.received, total: e.payload.total } }));
      }
    });
    return () => { un.then((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [corrTo, setCorrTo] = useState('');
  const [dictOpen, setDictOpen] = useState(false);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  // Console/log panel hidden by default; toggle via the View → Console menu.
  const [showConsole, setShowConsole] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // Manual "Check for updates": runs the app-wide updater check. If an update is found,
  // App's UpdateModal shows it; otherwise we tell the user they're up to date.
  const handleCheckForUpdates = useCallback(async () => {
    if (!onCheckForUpdates || checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const found = await onCheckForUpdates();
      if (!found) toast.success(t('upToDate'));
    } catch {
      toast.error(t('updateFailed'));
    } finally {
      setCheckingUpdate(false);
    }
  }, [onCheckForUpdates, checkingUpdate, t]);

  // Esc closes the What's New panel.
  useEffect(() => {
    if (!showChangelog) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowChangelog(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showChangelog]);
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'testing' | 'valid' | 'invalid'>('idle');
  const [appVersion, setAppVersion] = useState('1.0.0');
  const logsEndRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const testTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch app version from Tauri
  useEffect(() => {
    getVersion().then(v => setAppVersion(v)).catch(() => {});
  }, []);


  // Sync autostart state from OS on mount (OS is source of truth)
  useEffect(() => {
    const syncAutostart = async () => {
      try {
        const osEnabled = await isAutostartEnabled();
        console.log('[Settings] OS Autostart status:', osEnabled);
        // Always sync from OS - it's the source of truth
        setAutoStart(osEnabled);
      } catch (err) {
        console.error('[Settings] Failed to check autostart status:', err);
      }
    };
    // Small delay to ensure component is fully mounted
    const timer = setTimeout(syncAutostart, 100);
    return () => clearTimeout(timer);
  }, [setAutoStart]);

  // Handler for autostart toggle - calls OS API
  const handleAutoStartChange = useCallback(async (enabled: boolean) => {
    console.log('[Settings] Auto Start:', enabled);
    try {
      if (enabled) {
        await enableAutostart();
        console.log('[Settings] Autostart enabled in OS');
      } else {
        await disableAutostart();
        console.log('[Settings] Autostart disabled in OS');
      }
      setAutoStart(enabled);
      toast.success(enabled ? 'Start at login enabled' : 'Start at login disabled');
    } catch (err) {
      console.error('[Settings] Failed to change autostart:', err);
      toast.error('Failed to change startup setting');
    }
  }, [setAutoStart]);

  // Auto-test API key after typing stops
  useEffect(() => {
    if (!apiKey || apiKey.length < 10) {
      setApiKeyStatus('idle');
      return;
    }
    
    setApiKeyStatus('idle');
    if (testTimeoutRef.current) clearTimeout(testTimeoutRef.current);
    
    testTimeoutRef.current = setTimeout(async () => {
      setApiKeyStatus('testing');
      try {
        await translateText({
          text: 'Hi',
          sourceLang: 'en',
          targetLang: 'id',
          apiKey,
          provider,
          model: provider === 'custom' ? (customModel || undefined) : (model === 'auto' ? undefined : model),
          baseURL: provider === 'custom' ? customBaseURL : undefined,
        });
        setApiKeyStatus('valid');
        console.log('[API Test] Valid!');
      } catch (err) {
        setApiKeyStatus('invalid');
        console.error('[API Test] Invalid:', err);
      }
    }, 1500); // Test 1.5s after last keystroke
    
    return () => {
      if (testTimeoutRef.current) clearTimeout(testTimeoutRef.current);
    };
  }, [apiKey, provider, model, customModel, customBaseURL]);

  // Auto-save with debounce
  const autoSave = useCallback(async () => {
    setSaveStatus('saving');
    try {
      await save();
      setSaveStatus('saved');
      console.log('[AutoSave] Settings saved');
      setTimeout(() => setSaveStatus('idle'), 1500);
    } catch (error) {
      console.error('[AutoSave] Failed:', error);
      setSaveStatus('idle');
    }
  }, [save]);

  useEffect(() => {
    // Don't autosave until persisted settings have loaded — otherwise the 500ms debounce
    // can write default values over the user's saved settings on a slow cold start.
    if (!settingsLoaded) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => autoSave(), 500);
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [settingsLoaded, apiKey, provider, model, customBaseURL, customModel, shortcut, popupShortcut, terminalShortcut, sourceLang, targetLang, autoStart, enhanceEnabled, enhanceShortcut, voiceEnabled, voiceShortcut, voiceOriginalShortcut, voiceAutoStop, voicePopupPosition, voiceSoundEnabled, uiFont, uiScale, soundEnabled, loadingEnabled, appEnabled, uiLanguage, autoSave]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    const addLog = (type: string, ...args: unknown[]) => {
      const msgContent = args.map(a => 
        typeof a === 'object' ? JSON.stringify(a) : String(a)
      ).join(' ');
      
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      const msg = `${time} [${type}] ${msgContent}`;
      setLogs(prev => [...prev.slice(-100), msg]);
    };

    console.log = (...args) => { originalLog(...args); addLog('LOG', ...args); };
    console.error = (...args) => { originalError(...args); addLog('ERR', ...args); };
    console.warn = (...args) => { originalWarn(...args); addLog('WARN', ...args); };

    return () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    };
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClick = () => setActiveMenu(null);
    if (activeMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [activeMenu]);

  // Apply a completed shortcut. Takes the keys array DIRECTLY (not from React state) so a
  // fast/synthetic keystroke — e.g. from a mouse-macro button that fires keydown+keyup in
  // microseconds — isn't lost to the keydown→keyup state-commit race. Guarded on isRecording
  // so a fallback call after it already finalized is a harmless no-op.
  const finalizeShortcut = useCallback((keys: string[]) => {
    const which = isRecording;
    if (!which) return;
    const singleFnKey = keys.length === 1 && /^F([1-9]|1[0-9]|2[0-4])$/i.test(keys[0]);
    // A mouse shortcut is any combo ENDING in a mouse button (Mouse1/3/4/5), with or without
    // modifiers — e.g. "Mouse3", "Alt+Mouse3", "CommandOrControl+Shift+Mouse4".
    const mouseShortcut = keys.length > 0 && /^Mouse\d+$/.test(keys[keys.length - 1]);
    if (keys.length < 2 && !singleFnKey && !mouseShortcut) return;
    const newShortcut = keys.join('+');
    if (which === 'translate') setShortcut(newShortcut);
    else if (which === 'popup') setPopupShortcut(newShortcut);
    else if (which === 'terminal') setTerminalShortcut(newShortcut);
    else if (which === 'enhance') setEnhanceShortcut(newShortcut);
    else if (which === 'voice') setVoiceShortcut(newShortcut);
    else if (which === 'voiceOriginal') setVoiceOriginalShortcut(newShortcut);
    setIsRecording(null);
    setRecordedKeys([]);

    // Conflict check: warn (but still apply) on a duplicate within the app, an AltGr-risky
    // Ctrl+Alt+letter on Windows, or a combo the OS usually reserves.
    const macNow = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const others = ([
      ['translate', shortcut], ['popup', popupShortcut], ['terminal', terminalShortcut],
      ['enhance', enhanceShortcut], ['voice', voiceShortcut], ['voiceOriginal', voiceOriginalShortcut],
    ] as const).filter(([k]) => k !== which).map(([, v]) => v);
    const reserved = macNow
      ? ['CommandOrControl+Space', 'CommandOrControl+Tab', 'CommandOrControl+Q', 'CommandOrControl+W', 'CommandOrControl+H', 'CommandOrControl+M', 'CommandOrControl+C', 'CommandOrControl+V', 'CommandOrControl+X', 'CommandOrControl+Z', 'CommandOrControl+A']
      : ['Alt+Tab', 'Alt+F4', 'CommandOrControl+Escape', 'CommandOrControl+Alt+Delete'];
    let warnKey: 'shortcutDupWarn' | 'shortcutAltGrWarn' | 'shortcutReservedWarn' | null = null;
    if (others.includes(newShortcut)) warnKey = 'shortcutDupWarn';
    else if (!macNow && /^CommandOrControl\+Alt\+[A-Za-z0-9]$/.test(newShortcut)) warnKey = 'shortcutAltGrWarn';
    else if (reserved.includes(newShortcut)) warnKey = 'shortcutReservedWarn';

    if (warnKey) {
      toast(t(warnKey), { icon: '⚠️', duration: 6000 });
    } else if (mouseShortcut) {
      // Mouse shortcuts need the native global hook, which requires Accessibility permission.
      // If it isn't active, tell the user how to enable it (and retry the hook once granted).
      void invoke<boolean>('mouse_hook_active').then((active) => {
        if (active) {
          toast.success(`Mouse shortcut set: ${formatShortcut(newShortcut)}`);
        } else {
          void invoke('restart_mouse_hook').catch(() => {});
          toast(t('mouseHookPermission'), { icon: '🖱️', duration: 9000 });
        }
      }).catch(() => toast.success(`Mouse shortcut set: ${formatShortcut(newShortcut)}`));
    } else {
      toast.success(`Shortcut set: ${formatShortcut(newShortcut)}`);
    }
  }, [isRecording, setShortcut, setPopupShortcut, setTerminalShortcut, setEnhanceShortcut, setVoiceShortcut, setVoiceOriginalShortcut, shortcut, popupShortcut, terminalShortcut, enhanceShortcut, voiceShortcut, voiceOriginalShortcut, t]);

  // Modifier tokens (used to tell whether the combo already has a "real" key).
  const MODIFIER_TOKENS = ['CommandOrControl', 'Control', 'Super', 'Alt', 'Shift'];

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isRecording) return;
    e.preventDefault();
    e.stopPropagation();

    const keys: string[] = [];
    // Primary modifier is platform-specific: on macOS it's Cmd (metaKey), on Windows/Linux
    // it's Ctrl (ctrlKey). Map the primary to the portable "CommandOrControl" token so the
    // recorded shortcut works on both platforms; the physical Win/Super key maps to "Super".
    const isMacKb = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    if (isMacKb) {
      if (e.metaKey) keys.push('CommandOrControl');   // Cmd
      else if (e.ctrlKey) keys.push('Control');
    } else {
      if (e.ctrlKey) keys.push('CommandOrControl');   // Ctrl (portable primary)
      else if (e.metaKey) keys.push('Super');         // Win / Super key
    }
    if (e.altKey) keys.push('Alt');
    if (e.shiftKey) keys.push('Shift');

    // Normalize the key name. e.key is unreliable for Space (' ') and for Option
    // combos (which produce special chars like '√'), so fall back to e.code.
    let key = e.key;
    if (key === ' ' || e.code === 'Space') key = 'Space';
    else if (key.length === 1) {
      if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);        // KeyV -> V
      else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5); // Digit1 -> 1
      else key = key.toUpperCase();
    }
    if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key)) {
      keys.push(key);
    }
    setRecordedKeys(keys); // for the live display
    // If the combo has a real (non-modifier) key it's complete — finalize NOW, synchronously,
    // so fast/synthetic input (mouse-macro keystrokes) is captured reliably.
    const last = keys[keys.length - 1];
    if (keys.length > 0 && !MODIFIER_TOKENS.includes(last)) finalizeShortcut(keys);
  }, [isRecording, finalizeShortcut]);

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (!isRecording) return;
    e.preventDefault();
    // Fallback for slow human input where keydown didn't yet see a real key; no-op if
    // finalizeShortcut already ran (isRecording is null by then).
    finalizeShortcut(recordedKeys);
  }, [isRecording, recordedKeys, finalizeShortcut]);

  // Extract held keyboard modifiers from a mouse event, matching handleKeyDown's naming.
  const mouseMods = useCallback((e: MouseEvent) => {
    const mods: string[] = [];
    const isMacKb = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    if (isMacKb) {
      if (e.metaKey) mods.push('CommandOrControl');
      else if (e.ctrlKey) mods.push('Control');
    } else {
      if (e.ctrlKey) mods.push('CommandOrControl');
      else if (e.metaKey) mods.push('Super');
    }
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    return mods;
  }, []);

  // Pressing an EXTRA button (middle=1, back=3, forward=4, side=5) starts a "pending hold": if the
  // user then clicks ANOTHER button it's a chord ("Hold3+Mouse0" = hold Back, left-click); if they
  // just release it, it's a plain single-button shortcut ("Mouse3"). Modifiers held at press time
  // are captured for combos like "⌥+Back".
  const pendingHoldRef = useRef<number | null>(null);
  const pendingHoldModsRef = useRef<string[]>([]);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (!isRecording) return;
    // Second press while an extra button is held → chord (hold + this click).
    if (pendingHoldRef.current !== null && e.button !== pendingHoldRef.current) {
      e.preventDefault();
      e.stopPropagation();
      const hold = pendingHoldRef.current;
      pendingHoldRef.current = null;
      finalizeShortcut([...pendingHoldModsRef.current, `Hold${hold}`, `Mouse${e.button}`]);
      return;
    }
    // First press of an extra button → start a pending hold (wait for a second click or release).
    if (e.button === 1 || e.button >= 3) {
      e.preventDefault();
      e.stopPropagation();
      pendingHoldRef.current = e.button;
      pendingHoldModsRef.current = mouseMods(e);
    }
  }, [isRecording, finalizeShortcut, mouseMods]);

  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (!isRecording) return;
    // Released the held extra button without a second click → plain single-button shortcut.
    if (pendingHoldRef.current !== null && e.button === pendingHoldRef.current) {
      e.preventDefault();
      e.stopPropagation();
      const hold = pendingHoldRef.current;
      pendingHoldRef.current = null;
      finalizeShortcut([...pendingHoldModsRef.current, `Mouse${hold}`]);
    }
  }, [isRecording, finalizeShortcut]);

  useEffect(() => {
    if (isRecording) {
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('keyup', handleKeyUp, true);
      window.addEventListener('mousedown', handleMouseDown, true);
      window.addEventListener('mouseup', handleMouseUp, true);
    } else {
      pendingHoldRef.current = null; // clear any stale pending hold when recording stops
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('mouseup', handleMouseUp, true);
    };
  }, [isRecording, handleKeyDown, handleKeyUp, handleMouseDown, handleMouseUp]);

  // While recording, tell the native mouse hook (via the shared flag) to stop swallowing/
  // triggering mouse buttons, so the button being pressed reaches this recorder and doesn't fire
  // its bound action. Covers every start/stop path since it just tracks isRecording.
  useEffect(() => {
    setRecordingShortcut(isRecording !== null);
  }, [isRecording, setRecordingShortcut]);

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const formatShortcut = (s: string) => {
    // Friendly labels for mouse buttons (left/right included for chord triggers).
    const btnName = (n: string) =>
      ({ '0': 'Left', '1': 'Middle', '2': 'Right', '3': 'Back', '4': 'Forward', '5': 'Side' }[n] ?? `Btn ${n}`);
    // Label each token so combos (modifier + mouse, and hold-chords like "Hold3+Mouse0") render.
    const label = (part: string) => {
      let m: RegExpExecArray | null;
      if ((m = /^Hold(\d+)$/.exec(part))) return `🖱 ${btnName(m[1])} (hold)`;
      if ((m = /^Mouse(\d+)$/.exec(part))) return `🖱 ${btnName(m[1])}`;
      return part
        .replace('CommandOrControl', isMac ? 'Cmd' : 'Ctrl')
        .replace('Command', 'Cmd')
        .replace('Control', 'Ctrl')
        .replace('Alt', isMac ? 'Option' : 'Alt')
        .replace('Super', isMac ? 'Cmd' : 'Win');
    };
    return s.split('+').map(label).join(' + ');
  };

  const handleMenuAction = async (action: string) => {
    setActiveMenu(null);
    switch (action) {
      // 'Hide Window' carried action:'quit' since the menu was written — File → Hide
      // Window exited the whole app, which is exactly what issue #14 reported. The
      // 1.0.42 remove_menu() fix chased Tauri's default menu, but this bar is OURS.
      case 'hide':
        await invoke('hide_settings_window');
        break;
      case 'quit':
        await invoke('quit_app');
        break;
      case 'clear-logs':
        setLogs([]);
        break;
      case 'copy-logs':
        navigator.clipboard.writeText(logs.join('\n'));
        toast.success('Logs copied!');
        break;
      case 'toggle-console':
        setShowConsole(!showConsole);
        break;
      case 'website':
        try {
          const { open } = await import('@tauri-apps/plugin-shell');
          await open('https://vibetranslate.id');
        } catch (e) {
          console.warn('Could not open website:', e);
        }
        break;
      case 'about':
        toast(`VibeTranslate v${appVersion}\nAuto Translate with AI\n\nCreated by Robith Yusuf`, { 
          duration: 4000,
          icon: <img src={logo} alt="" className="w-5 h-5 rounded" />
        });
        break;
    }
  };

  type MenuItem = { type: 'separator' } | { type?: 'item'; label: string; shortcut?: string; action: string };
  
  const menuKey = isMac ? 'Cmd' : 'Ctrl';
  const menus: { label: string; items: MenuItem[] }[] = [
    {
      label: 'File',
      items: [
        { label: 'Hide Window', shortcut: `${menuKey}+H`, action: 'hide' },
        { type: 'separator' },
        { label: 'Quit', shortcut: `${menuKey}+Q`, action: 'quit' },
      ]
    },
    {
      label: 'Edit',
      items: [
        { label: 'Clear Logs', action: 'clear-logs' },
        { label: 'Copy Logs', shortcut: `${menuKey}+C`, action: 'copy-logs' },
      ]
    },
    {
      label: 'View',
      items: [
        { label: showConsole ? '✓ Console' : '  Console', action: 'toggle-console' },
      ]
    },
    {
      label: 'Help',
      items: [
        { label: 'Visit Website', action: 'website' },
        { label: 'About VibeTranslate', action: 'about' },
      ]
    },
  ];

  return (
    <div className="h-screen flex flex-col bg-[#1e1e1e] text-white">
      <Toaster position="top-center" />
      
      {/* Title Bar - macOS style */}
      <div className="h-8 bg-[#323233] flex items-center justify-between px-2 select-none" data-tauri-drag-region>
        {/* Menu Bar */}
        <div className="flex items-center gap-1 text-[14px]">
          {menus.map((menu) => (
            <div key={menu.label} className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMenu(activeMenu === menu.label ? null : menu.label);
                }}
                className={`px-2.5 py-0.5 rounded ${
                  activeMenu === menu.label ? 'bg-[#0058d1] text-white' : 'hover:bg-white/10'
                }`}
              >
                {menu.label}
              </button>
              
              {activeMenu === menu.label && (
                <div className="absolute top-full left-0 mt-0.5 bg-[#2d2d2d] border border-[#454545] rounded-md shadow-xl py-1 min-w-[180px] z-50">
                  {menu.items.map((item, idx) => {
                    if (item.type === 'separator') {
                      return <div key={idx} className="h-px bg-[#454545] my-1" />;
                    }
                    return (
                      <button
                        key={idx}
                        onClick={() => handleMenuAction(item.action)}
                        className="w-full px-3 py-1 text-left text-[14px] hover:bg-[#0058d1] flex justify-between items-center"
                      >
                        <span>{item.label}</span>
                        {item.shortcut && <span className="text-white/50 text-[12px]">{item.shortcut}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" data-tauri-drag-region />

        {/* Status & Title */}
        <div className="flex items-center gap-2.5 text-[12px]">
          <span className="text-white/40">
            {saveStatus === 'saving' && 'Saving...'}
            {saveStatus === 'saved' && <span className="text-green-400">✓ Saved</span>}
          </span>
          {/* Top-bar manual update check — shows the update modal if a newer version exists,
              otherwise toasts "up to date". Complements the auto-check (which only runs once
              per launch, so it's easy to miss). */}
          {onCheckForUpdates && (
            <button
              onClick={handleCheckForUpdates}
              disabled={checkingUpdate}
              title={t('checkForUpdates')}
              aria-label={t('checkForUpdates')}
              className="p-1 rounded hover:bg-white/10 text-white/45 hover:text-white/90 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={checkingUpdate ? 'animate-spin' : ''} />
            </button>
          )}
          <span className="text-[14px] font-medium text-white/80">VibeTranslate</span>
          {import.meta.env.DEV && (
            <span
              title="Running the local dev build (not production)"
              className="px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-300 text-[9px] font-bold tracking-wider leading-none"
            >
              DEV
            </span>
          )}
        </div>
      </div>

      {/* Update Banner - Disabled until updater is properly configured */}
      {/* <UpdateBanner /> */}

      {/* Warning Banner */}
      {warningMessage && (
        <div className="px-3 py-2 bg-yellow-500/20 border-b border-yellow-500/30 flex items-center gap-2 text-yellow-200 text-[12px]">
          <AlertTriangle size={14} className="text-yellow-400 shrink-0" />
          <span className="flex-1">{warningMessage}</span>
          <a 
            href={APP_CONFIG.PRICING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-0.5 bg-yellow-500 text-black font-medium rounded text-[12px] hover:bg-yellow-400 transition-colors"
          >
            Get License
          </a>
        </div>
      )}

      {/* Tab Bar */}
      <div className="h-12 bg-[#252526] border-b border-[#1e1e1e] flex items-center px-3 gap-1">
        {[
          { id: 'general', label: t('tabGeneral'), icon: <Key size={16} /> },
          { id: 'shortcuts', label: t('tabShortcuts'), icon: <Keyboard size={16} /> },
          { id: 'appearance', label: t('tabAppearance'), icon: <Palette size={16} /> },
          { id: 'feedback', label: t('tabFeedback'), icon: <Volume2 size={16} /> },
          { id: 'tutorial', label: t('tabTutorial'), icon: <BookOpen size={16} /> },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as TabType)}
            className={`flex items-center gap-2 px-4 py-2.5 text-[14px] font-medium rounded-t-md border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-[#0078d4] text-white bg-[#1e1e1e]'
                : 'border-transparent text-white/55 hover:text-white/90 hover:bg-white/5'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Settings Panel */}
        <div className={`${showConsole ? 'w-1/2' : 'flex-1'} overflow-y-auto p-6 bg-[#1e1e1e]`}>
          {activeTab === 'general' && (
            <div className="space-y-5 w-full">
              {/* AI Provider & API Key — and the app-wide power switch, in this header.
                  It used to be a whole card of its own at the BOTTOM of the tab titled
                  "Translation Active": furthest from everything it controls, and the name
                  lied — in code it disables every shortcut, voice included. Riding on the
                  first card costs no vertical space, and everything it governs dims below
                  it when off, so cause and effect need no explaining. */}
              <div className="bg-[#252526] rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2.5 mb-0.5">
                  <Key size={15} className="text-[#0078d4] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-[14px] font-medium text-white/90 block">{t('aiProvider')}</span>
                    <p className="text-[12px] text-white/40 mt-0.5">{t('aiProviderDesc')}</p>
                  </div>
                  <Toggle
                    enabled={appEnabled}
                    onChange={(enabled) => { console.log('[Settings] App Enabled:', enabled); setAppEnabled(enabled); }}
                  />
                </div>
                <div className={`space-y-3 ${appEnabled ? '' : 'opacity-45 saturate-50 pointer-events-none'} transition-opacity`}>
                {/* Mode: Free (Built-in) vs Own API Key */}
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => { if (serverAvailable) setProvider('server'); }}
                    disabled={!serverAvailable}
                    className={`text-left px-3 py-2 rounded-lg border-2 transition-colors ${
                      provider === 'server'
                        ? 'border-green-500 bg-green-500/10'
                        : 'border-[#3c3c3c] bg-[#1e1e1e] hover:border-[#555]'
                    } ${!serverAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <Gift size={14} className="text-green-400 shrink-0" />
                      <span className="text-[13px] font-semibold text-white">{t('providerFreeTitle')}</span>
                      {provider === 'server' && <CheckCircle size={15} className="text-green-400 ml-auto" />}
                    </div>
                    <p className="text-[11px] text-white/50 mt-0.5">{t('providerFreeDesc')}</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (provider === 'server') setProvider('groq'); }}
                    className={`text-left px-3 py-2 rounded-lg border-2 transition-colors ${
                      provider !== 'server'
                        ? 'border-[#0078d4] bg-[#0078d4]/10'
                        : 'border-[#3c3c3c] bg-[#1e1e1e] hover:border-[#555]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Key size={14} className="text-[#3b9eff] shrink-0" />
                      <span className="text-[13px] font-semibold text-white">{t('providerOwnTitle')}</span>
                      {provider !== 'server' && <CheckCircle size={15} className="text-[#3b9eff] ml-auto" />}
                    </div>
                    <p className="text-[11px] text-white/50 mt-0.5">OpenAI · Groq · Gemini · OpenRouter</p>
                  </button>
                </div>

                {/* Provider picker (own-key only) + Base URL (custom) + model */}
                <div className="flex flex-wrap items-center gap-2">
                  {provider !== 'server' && (
                    <Select
                      value={provider}
                      onChange={(value) => { console.log('[Settings] Provider:', value); setProvider(value as AIProvider); }}
                      options={availableProviders.filter((p) => p !== 'server').map((p) => ({ value: p, label: AI_PROVIDERS[p].name }))}
                      maxHeight={200}
                    />
                  )}
                  {/* Model: dropdown from the live /models list; text input for custom until fetched */}
                  {provider === 'custom' && availableModels.length === 0 ? (
                    <input
                      type="text"
                      value={customModel}
                      onChange={(e) => setCustomModel(e.target.value)}
                      placeholder={t('modelPlaceholder')}
                      className="flex-1 px-3 py-1.5 text-[14px] bg-[#3c3c3c] border border-[#454545] rounded focus:outline-none focus:border-[#0078d4]"
                    />
                  ) : (
                    <Select
                      value={provider === 'custom' ? customModel : model}
                      onChange={(value) => { console.log('[Settings] Model:', value); (provider === 'custom' ? setCustomModel : setModel)(value); }}
                      options={availableModels.map((m) => ({
                        value: m.id,
                        label: m.name,
                        description: m.id === 'offline-nllb' ? t('mtOfflineDesc') : undefined,
                        icon: m.id === 'offline-nllb' ? <HardDrive size={13} /> : undefined,
                      }))}
                      className="flex-1"
                      maxHeight={240}
                      searchable
                    />
                  )}
                </div>

                {/* Custom Base URL */}
                {provider === 'custom' && (
                  <input
                    type="text"
                    value={customBaseURL}
                    onChange={(e) => setCustomBaseURL(e.target.value)}
                    placeholder={t('baseUrlPlaceholder')}
                    className="w-full px-3 py-1.5 text-[14px] bg-[#3c3c3c] border border-[#454545] rounded focus:outline-none focus:border-[#0078d4]"
                  />
                )}

                {/* Live model fetch status */}
                {provider !== 'server' && (
                  <div className="flex items-center gap-1.5 text-[11px] text-white/40">
                    {modelsLoading ? (
                      <><Loader2 size={11} className="animate-spin text-blue-400" /> {t('modelsFetching')}</>
                    ) : fetchedModels.length > 0 ? (
                      <><CheckCircle size={11} className="text-green-400" /> {fetchedModels.length} {t('modelsLoadedLive')}</>
                    ) : (
                      <span>{provider === 'custom' ? t('enterKeyBaseUrlToLoadModels') : t('enterKeyToLoadModels')}</span>
                    )}
                  </div>
                )}
                {AI_PROVIDERS[provider].isServer ? (
                  <div className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded flex items-center gap-2">
                    <CheckCircle size={14} className="text-green-400" />
                    <span className="text-[12px] text-green-300">{t('providerBuiltinFree')}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <div className="flex-1 relative">
                        <input
                          type={showApiKey ? 'text' : 'password'}
                          value={apiKey || ''}
                          onChange={(e) => setApiKey(e.target.value)}
                          placeholder={AI_PROVIDERS[provider].keyPlaceholder}
                          className={`w-full px-3 py-1.5 pr-8 text-[14px] bg-[#3c3c3c] border rounded focus:outline-none ${
                            apiKeyStatus === 'valid' ? 'border-green-500' :
                            apiKeyStatus === 'invalid' ? 'border-red-500' :
                            'border-[#454545] focus:border-[#0078d4]'
                          }`}
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2">
                          {apiKeyStatus === 'testing' && (
                            <Loader2 size={14} className="text-blue-400 animate-spin" />
                          )}
                          {apiKeyStatus === 'valid' && (
                            <CheckCircle size={14} className="text-green-400" />
                          )}
                          {apiKeyStatus === 'invalid' && (
                            <XCircle size={14} className="text-red-400" />
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="px-3 text-[14px] bg-[#3c3c3c] hover:bg-[#454545] border border-[#454545] rounded"
                      >
                        {showApiKey ? t('hide') : t('show')}
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] text-white/40">
                        {provider !== 'openai' && <span className="text-green-400 mr-2">✓ {t('freeTier')}</span>}
                      </span>
                      <button
                        onClick={async () => {
                          const urls: Record<string, string> = {
                            openai: 'https://platform.openai.com/api-keys',
                            openrouter: 'https://openrouter.ai/keys',
                            groq: 'https://console.groq.com/keys',
                            gemini: 'https://aistudio.google.com/apikey',
                          };
                          // A custom OpenAI-compatible endpoint has no canonical key page, and
                          // Gemini was simply missing — both used to call open(undefined), which
                          // does nothing and reads as a dead button.
                          const url = urls[provider];
                          if (!url) return;
                          const { open } = await import('@tauri-apps/plugin-shell');
                          await open(url);
                        }}
                        className="text-[12px] text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        {t('getApiKey')} →
                      </button>
                    </div>
                  </>
                )}
                </div>
              </div>

              <div className={`space-y-5 ${appEnabled ? '' : 'opacity-45 saturate-50 pointer-events-none'} transition-opacity`}>
              {/* Languages (default source + target for translation) */}
              <div className="bg-[#252526] rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[14px] font-medium text-white/80 flex items-center gap-2">
                    <Languages size={14} /> {t('languages')}
                  </label>
                  <span className="text-[11px] text-white/40">{t('maxCharsInfo').replace('{max}', '5000')}</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 space-y-1">
                    <span className="text-[12px] text-white/50">{t('fromLang')}</span>
                    <Select
                      value={sourceLang}
                      onChange={(value) => { console.log('[Settings] Source Lang:', value); setSourceLang(value); }}
                      options={LANGUAGES.map((lang) => ({ value: lang.code, label: lang.name }))}
                      maxHeight={200}
                      minWidth={140}
                    />
                  </div>
                  <button
                    onClick={swapLanguages}
                    disabled={sourceLang === 'auto'}
                    className="px-2 py-1.5 mt-5 text-white/60 hover:text-white hover:bg-[#3c3c3c] rounded disabled:opacity-30"
                  >
                    ⇄
                  </button>
                  <div className="flex-1 space-y-1">
                    <span className="text-[12px] text-white/50">{t('toLang')}</span>
                    <Select
                      value={targetLang}
                      onChange={(value) => { console.log('[Settings] Target Lang:', value); setTargetLang(value); }}
                      options={LANGUAGES.filter(l => l.code !== 'auto').map((lang) => ({ value: lang.code, label: lang.name }))}
                      maxHeight={200}
                      minWidth={140}
                    />
                  </div>
                </div>
              </div>

              {/* Quick Shortcuts Reference */}
              <div className="bg-gradient-to-r from-[#252526] to-[#2d2d30] rounded-lg p-4 space-y-3 border border-[#454545]">
                <h4 className="text-[14px] font-medium text-white/90 flex items-center gap-2">
                  <Keyboard size={14} className="text-blue-400" /> Shortcuts
                  {enhanceEnabled && (
                    <span className="px-1.5 py-0.5 bg-purple-500/30 text-purple-300 rounded text-[9px]">ENHANCE</span>
                  )}
                </h4>
                <div className="grid gap-2 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="text-white/60">{enhanceEnabled ? 'Enhance & Replace' : 'Translate & Replace'}</span>
                    <code className="px-2 py-0.5 bg-blue-500/20 border border-blue-500/30 rounded text-blue-300 text-[11px]">{formatShortcut(shortcut)}</code>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/60">{enhanceEnabled ? 'Enhance & Popup' : 'Translate & Popup'}</span>
                    <code className="px-2 py-0.5 bg-green-500/20 border border-green-500/30 rounded text-green-300 text-[11px]">{formatShortcut(popupShortcut)}</code>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/60">{enhanceEnabled ? 'CLI Enhance (Replace)' : 'CLI Translate (Replace)'}</span>
                    <code className="px-2 py-0.5 bg-amber-500/20 border border-amber-500/30 rounded text-amber-300 text-[11px]">{formatShortcut(terminalShortcut)}</code>
                  </div>
                  {voiceEnabled && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-white/60">Voice → Original</span>
                        <code className="px-2 py-0.5 bg-cyan-500/20 border border-cyan-500/30 rounded text-cyan-300 text-[11px]">{formatShortcut(voiceOriginalShortcut)}</code>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-white/60">Voice → Translate</span>
                        <code className="px-2 py-0.5 bg-cyan-500/20 border border-cyan-500/30 rounded text-cyan-300 text-[11px]">{formatShortcut(voiceShortcut)}</code>
                      </div>
                    </>
                  )}
                </div>
                <button
                  onClick={() => setActiveTab('shortcuts')}
                  className="w-full mt-1 px-3 py-2 rounded-md bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 flex items-center justify-center gap-1.5 text-[12px] font-medium text-blue-300 transition-colors group"
                >
                  <Keyboard size={13} /> {t('editShortcuts')}
                  <ChevronRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
                </button>
              </div>

              {/* Voice Input (Voice Active) — enable + stop mode live here; shortcuts are in the Shortcuts tab */}
              <div className="bg-gradient-to-r from-[#252526] to-[#2a2a2c] rounded-lg p-4 border border-[#454545] space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${voiceEnabled ? 'bg-cyan-500/20' : 'bg-[#3c3c3c]'}`}>
                      <Mic size={18} className={voiceEnabled ? 'text-cyan-400' : 'text-white/40'} />
                    </div>
                    <div>
                      <span className="text-[14px] font-medium text-white block">{t('voiceInput')}</span>
                      <span className="text-[12px] text-white/40">{voiceEnabled ? t('voiceInputOnDesc') : t('voiceInputOffDesc')}</span>
                    </div>
                  </div>
                  <Toggle
                    enabled={voiceEnabled}
                    onChange={(enabled) => { console.log('[Settings] Voice:', enabled); setVoiceEnabled(enabled); }}
                  />
                </div>
                {voiceEnabled && (
                  <>
                    {/* Transcription engine — ONE compact picker for every STT source
                        (auto online: BYOK key else built-in server; offline on-device models).
                        The status line live-reflects what will actually be used. */}
                    <div className="bg-[#1e1e1e] rounded-md px-2.5 py-2 border border-[#3c3c3c]" title={t('voiceSttByokDesc')}>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-[11px] text-white/50">{t('sttEngine')}</span>
                        {voiceSttEngine in LOCAL_STT_MODELS ? (
                          sttReady[voiceSttEngine] === false ? (
                            <span className="text-[10px] text-amber-400/90 shrink-0">● {t('sttStatusNoModel')}</span>
                          ) : (
                            <span className="text-[10px] text-cyan-300/80 shrink-0">● {t('voiceSttActiveLocal')}</span>
                          )
                        ) : voiceSttEngine === 'groq' || voiceSttEngine === 'openai' ? (
                          (apiKeys[voiceSttEngine as 'groq' | 'openai'] || '').trim() ? (
                            <span className="text-[10px] text-green-400/90 shrink-0">
                              ● {t('voiceSttActiveByok').replace('{provider}', voiceSttEngine === 'groq' ? 'Groq' : 'OpenAI')}
                            </span>
                          ) : (
                            <span className="text-[10px] text-amber-400/90 shrink-0">● {t('sttStatusNoKey')}</span>
                          )
                        ) : (apiKeys.groq || apiKeys.openai) ? (
                          <span className="text-[10px] text-green-400/90 shrink-0">
                            ● {t('voiceSttActiveByok').replace('{provider}', apiKeys.groq ? 'Groq' : 'OpenAI')}
                          </span>
                        ) : (
                          <span className="text-[10px] text-sky-400/90 shrink-0">● {t('voiceSttActiveServer')}</span>
                        )}
                      </div>
                      <Select
                        value={voiceSttEngine}
                        onChange={setVoiceSttEngine}
                        options={[
                          { value: 'auto', label: t('sttEngineAuto'), description: t('sttEngineAutoDesc'), icon: <Cloud size={13} /> },
                          { value: 'groq', label: t('sttEngineGroq'), description: t('sttEngineGroqDesc'), icon: <Key size={13} /> },
                          {
                            value: 'omnilingual-300m',
                            label: `${t('sttEngineOmni')}${sttReady['omnilingual-300m'] === false ? ` — ${t('sttNotDownloaded')}` : ''}`,
                            description: t('sttEngineOmniDesc'),
                            icon: <HardDrive size={13} />,
                          },
                          {
                            value: 'whisper-turbo',
                            label: `${t('sttEngineTurbo')}${sttReady['whisper-turbo'] === false ? ` — ${t('sttNotDownloaded')}` : ''}`,
                            description: t('sttEngineTurboDesc'),
                            icon: <HardDrive size={13} />,
                          },
                          {
                            value: 'parakeet-v3',
                            label: `${t('sttEngineParakeet')}${sttReady['parakeet-v3'] === false ? ` — ${t('sttNotDownloaded')}` : ''}`,
                            description: t('sttEngineParakeetDesc'),
                            icon: <HardDrive size={13} />,
                          },
                          { value: 'openai', label: t('sttEngineOpenai'), description: t('sttEngineOpenaiDesc'), icon: <Lock size={13} /> },
                        ]}
                        className="w-full"
                        maxHeight={220}
                      />
                      {/* Offline model chosen but not installed -> inline download card */}
                      {voiceSttEngine in LOCAL_STT_MODELS && sttReady[voiceSttEngine] === false && (
                        sttDl[voiceSttEngine] ? (
                          <div className="mt-2">
                            <div className="flex justify-between text-[10px] text-white/50 mb-1">
                              <span>{t('sttDownloading')}</span>
                              <span>{Math.round(sttDl[voiceSttEngine].received / 1048576)} / {Math.max(1, Math.round(sttDl[voiceSttEngine].total / 1048576))} MB</span>
                            </div>
                            <div className="h-1.5 bg-[#2a2a2a] rounded overflow-hidden">
                              <div className="h-full bg-cyan-500 transition-all" style={{ width: `${Math.min(100, (sttDl[voiceSttEngine].received / Math.max(1, sttDl[voiceSttEngine].total)) * 100)}%` }} />
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { const m = voiceSttEngine; setSttDl((d) => ({ ...d, [m]: { received: 0, total: 1 } })); void invoke('download_stt_model', { modelId: m }).catch((e) => { setSttDl((d) => { const n = { ...d }; delete n[m]; return n; }); toast.error(String(e)); }); }}
                            className="mt-2 w-full px-2 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-[12px] font-medium transition-colors"
                          >
                            <span className="inline-flex items-center justify-center gap-1.5"><Download size={13} /> {t('sttDownloadCta').replace('{size}', LOCAL_STT_MODELS[voiceSttEngine]?.size ?? '')}</span>
                          </button>
                        )
                      )}
                      {/* Explicit BYOK engine without a key -> inline key field (same store as the
                          provider section above: one key feeds translate AND voice) */}
                      {(voiceSttEngine === 'groq' || voiceSttEngine === 'openai') && !(apiKeys[voiceSttEngine as 'groq' | 'openai'] || '').trim() && (
                        <input
                          type="password"
                          placeholder={t('sttKeyPlaceholder').replace('{provider}', voiceSttEngine === 'groq' ? 'Groq' : 'OpenAI')}
                          onChange={(e) => setApiKeyFor(voiceSttEngine as 'groq' | 'openai', e.target.value.trim() || null)}
                          className="mt-2 w-full px-2 py-1.5 bg-[#2a2a2a] border border-[#3c3c3c] rounded-md text-[12px] text-white outline-none focus:border-cyan-500 placeholder:text-white/30"
                        />
                      )}
                    </div>

                    {/* Compact 2-column grid: label-on-top cells, descriptions moved to tooltips.
                        Pairs: (stop mode | silence pause) and (max length | microphone). */}
                    <div className="grid grid-cols-2 gap-2">
                      {/* Stop mode */}
                      <div className="bg-[#1e1e1e] rounded-md px-2.5 py-2 border border-[#3c3c3c]" title={voiceAutoStop ? t('voiceAutoStopDesc') : t('voiceManualDesc')}>
                        <span className="text-[11px] text-white/50 block mb-1">{t('voiceStopMode')}</span>
                        <div className="grid grid-cols-2 gap-1">
                          <button
                            type="button"
                            onClick={() => setVoiceAutoStop(false)}
                            className={`px-2 py-1.5 rounded text-[11px] font-medium border transition-colors ${
                              !voiceAutoStop
                                ? 'bg-cyan-600 text-white border-cyan-500'
                                : 'bg-[#2a2a2a] text-white/55 border-[#3c3c3c] hover:text-white hover:border-[#555]'
                            }`}
                          >
                            {t('voiceManualLabel')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setVoiceAutoStop(true)}
                            className={`px-2 py-1.5 rounded text-[11px] font-medium border transition-colors flex items-center justify-center gap-1 ${
                              voiceAutoStop
                                ? 'bg-cyan-600 text-white border-cyan-500'
                                : 'bg-[#2a2a2a] text-white/55 border-[#3c3c3c] hover:text-white hover:border-[#555]'
                            }`}
                          >
                            {t('voiceAutoStopLabel')}
                            <span className="px-1 py-0.5 rounded bg-amber-500/25 text-amber-200 text-[8px] font-bold leading-none tracking-wide">BETA</span>
                          </button>
                        </div>
                        <p className="text-[10px] text-white/35 mt-1 leading-snug">{voiceAutoStop ? t('voiceAutoHint') : t('voiceManualHint')}</p>
                      </div>
                      {/* Auto-stop silence pause (only meaningful in auto mode) */}
                      <div className={`bg-[#1e1e1e] rounded-md px-2.5 py-2 border border-[#3c3c3c] ${voiceAutoStop ? '' : 'opacity-40'}`} title={t('voiceAutoStopDesc')}>
                        <span className="text-[11px] text-white/50 block mb-1">{t('voiceSilenceLabel')}</span>
                        <div className={voiceAutoStop ? '' : 'pointer-events-none'}>
                          <Select
                            value={String(voiceSilenceSec)}
                            onChange={(v) => setVoiceSilenceSec(parseFloat(v))}
                            options={[1, 1.5, 2, 3, 4, 5].map((sec) => ({ value: String(sec), label: `${sec} ${t('voiceSilenceSeconds')}` }))}
                            className="w-full"
                            maxHeight={180}
                          />
                        </div>
                        <p className="text-[10px] text-white/35 mt-1 leading-snug">{t('voiceSilenceHint')}</p>
                      </div>
                      {/* Max recording length */}
                      <div className="bg-[#1e1e1e] rounded-md px-2.5 py-2 border border-[#3c3c3c]" title={t('voiceMaxDesc')}>
                        <span className="text-[11px] text-white/50 block mb-1">{t('voiceMaxLabel')}</span>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={1}
                            max={15}
                            step={1}
                            value={voiceMaxMinutes}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              if (Number.isFinite(v)) setVoiceMaxMinutes(Math.min(15, Math.max(1, v)));
                            }}
                            className="w-14 px-2 py-1.5 bg-[#2a2a2a] border border-[#3c3c3c] rounded text-[12px] text-white text-center outline-none focus:border-cyan-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            aria-label={t('voiceMaxLabel')}
                          />
                          <span className="text-[11px] text-white/50">{t('voiceMaxMinutes')}</span>
                          <div className="flex-1" />
                          {[5, 10, 15].map((m) => (
                            <button
                              key={m}
                              type="button"
                              onClick={() => setVoiceMaxMinutes(m)}
                              className={`px-1.5 py-1 rounded text-[10px] font-medium border transition-colors ${
                                voiceMaxMinutes === m
                                  ? 'bg-cyan-600 text-white border-cyan-500'
                                  : 'bg-[#2a2a2a] text-white/50 border-[#3c3c3c] hover:text-white hover:border-[#555]'
                              }`}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-white/35 mt-1 leading-snug">{t('voiceMaxHint')}</p>
                      </div>
                      {/* Microphone */}
                      <div className="bg-[#1e1e1e] rounded-md px-2.5 py-2 border border-[#3c3c3c]" title={t('micDeviceDesc')}>
                        <span className="text-[11px] text-white/50 block mb-1">
                          {t('micDeviceLabel')}
                          {lastMicUsed && <span className="text-cyan-300/70"> · 🎙 {lastMicUsed}</span>}
                        </span>
                        <Select
                          value={micDeviceId}
                          onChange={setMicDeviceId}
                          options={[
                            { value: '', label: t('micDeviceDefault') },
                            ...micList.map((m) => ({ value: m.id, label: m.label })),
                            ...(micDeviceId && !micList.some((m) => m.id === micDeviceId)
                              ? [{ value: micDeviceId, label: t('micDeviceMissing') }]
                              : []),
                          ]}
                          className="w-full"
                          maxHeight={200}
                        />
                        <p className="text-[10px] text-white/35 mt-1 leading-snug">{t('micDeviceHint')}</p>
                      </div>
                    </div>

                    {/* Compact toggle pair: AI tidy | mic boost — same 2-col rhythm as the
                        grid above; long explanations live in the hover tooltips */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-[#1e1e1e] rounded-md px-2.5 py-2 border border-[#3c3c3c]" title={t('voiceCleanupDesc')}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] text-white/80 truncate">{t('voiceCleanupLabel')}</span>
                          <Toggle enabled={voiceCleanup} onChange={setVoiceCleanup} size="sm" />
                        </div>
                        <span className="text-[10px] text-white/35 leading-snug block mt-0.5">{t('voiceCleanupHint')}</span>
                      </div>
                      <div className="bg-[#1e1e1e] rounded-md px-2.5 py-2 border border-[#3c3c3c]" title={t('micBoostDesc')}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] text-white/80 truncate">{t('micBoost')}</span>
                          <Toggle enabled={micAutoGain} onChange={setMicAutoGain} size="sm" />
                        </div>
                        <span className="text-[10px] text-white/35 leading-snug block mt-0.5">{t('micBoostDesc')}</span>
                      </div>
                    </div>

                    {/* Live dictation (Beta). The toggle only arms once its model is on disk:
                        340MB is not something to fetch silently on a toggle flip, and a user on
                        a metered connection deserves the number before the download. */}
                    <div className="bg-[#1e1e1e] rounded-md px-2.5 py-2 border border-amber-500/30">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] text-amber-300/90 truncate">
                          {t('voiceLiveLabel')}
                        </span>
                        {sttReady['streaming-multi'] !== true ? (
                          sttDl['streaming-multi'] ? (
                            <span className="text-[10px] text-white/40 tabular-nums shrink-0">
                              {Math.round((sttDl['streaming-multi'].received / Math.max(1, sttDl['streaming-multi'].total)) * 100)}%
                            </span>
                          ) : sttReady['streaming-multi'] === undefined ? (
                            // Status check still in flight: showing the Toggle here let the
                            // user arm live mode with no model on disk.
                            <span className="text-[10px] text-white/25 shrink-0">…</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => { setSttDl((d) => ({ ...d, 'streaming-multi': { received: 0, total: 1 } })); void invoke('download_stt_model', { modelId: 'streaming-multi' }).catch((e) => { setSttDl((d) => { const n = { ...d }; delete n['streaming-multi']; return n; }); toast.error(String(e)); }); }}
                              className="text-[10px] text-cyan-300/90 hover:text-cyan-200 underline underline-offset-2 cursor-pointer shrink-0"
                            >
                              {t('voiceLiveDownload')}
                            </button>
                          )
                        ) : (
                          <Toggle
                            enabled={voiceLiveMode}
                            onChange={(on) => {
                              setVoiceLiveMode(on);
                              // Load now, while the user is still in Settings, rather than on
                              // the first shortcut press when they are already talking.
                              if (on) void warmLive().catch(() => { /* first use will load it */ });
                              else void releaseLive().catch(() => { /* */ });
                            }}
                            size="sm"
                          />
                        )}
                      </div>
                      <span className="text-[10px] text-white/35 leading-snug block mt-0.5">
                        {t('voiceLiveHint')}
                      </span>
                    </div>

                    {/* Correction dictionary — collapsible so it doesn't dominate the section */}
                    <div className="bg-[#1e1e1e] rounded-md border border-[#3c3c3c]">
                      <button
                        type="button"
                        onClick={() => setDictOpen((v) => !v)}
                        className="w-full flex items-center justify-between px-3 py-2 text-left"
                        title={t('voiceDictDesc')}
                      >
                        <span className="text-[12px] text-white/80">
                          {t('voiceDictLabel')}
                          {voiceCorrections.length > 0 && <span className="text-cyan-300/70"> ({voiceCorrections.length})</span>}
                        </span>
                        <ChevronRight size={14} className={`text-white/40 transition-transform ${dictOpen ? 'rotate-90' : ''}`} />
                      </button>
                      {dictOpen && (
                        <div className="px-3 pb-2.5 space-y-2">
                          <p className="text-[11px] text-white/40">{t('voiceDictDesc')}</p>
                          {/* Add-row PINNED ABOVE the list: with many entries the form used to sink
                              below 100 rows — new entries are also prepended so they appear here. */}
                          <div className="flex items-center gap-2">
                            <input
                              value={corrFrom}
                              onChange={(e) => setCorrFrom(e.target.value)}
                              placeholder={t('voiceDictFrom')}
                              maxLength={60}
                              className="flex-1 min-w-0 px-2 py-1.5 bg-[#2a2a2a] border border-[#3c3c3c] rounded-md text-[12px] text-white outline-none focus:border-cyan-500 placeholder:text-white/30"
                            />
                            <span className="text-white/35">→</span>
                            <input
                              value={corrTo}
                              onChange={(e) => setCorrTo(e.target.value)}
                              placeholder={t('voiceDictTo')}
                              maxLength={60}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && corrFrom.trim()) {
                                  setVoiceCorrections([{ from: corrFrom.trim(), to: corrTo.trim() }, ...voiceCorrections]);
                                  setCorrFrom(''); setCorrTo('');
                                }
                              }}
                              className="flex-1 min-w-0 px-2 py-1.5 bg-[#2a2a2a] border border-[#3c3c3c] rounded-md text-[12px] text-white outline-none focus:border-cyan-500 placeholder:text-white/30"
                            />
                            <button
                              type="button"
                              disabled={!corrFrom.trim() || voiceCorrections.length >= 100}
                              onClick={() => {
                                setVoiceCorrections([{ from: corrFrom.trim(), to: corrTo.trim() }, ...voiceCorrections]);
                                setCorrFrom(''); setCorrTo('');
                              }}
                              className="px-2.5 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[12px] font-medium transition-colors"
                            >
                              +
                            </button>
                          </div>
                          {/* Search appears once the list is big enough to need it */}
                          {voiceCorrections.length > 5 && (
                            <input
                              value={dictQuery}
                              onChange={(e) => setDictQuery(e.target.value)}
                              placeholder={t('voiceDictSearch')}
                              className="w-full px-2 py-1.5 bg-[#242424] border border-[#3c3c3c] rounded-md text-[12px] text-white outline-none focus:border-cyan-500 placeholder:text-white/30"
                            />
                          )}
                          {voiceCorrections.length > 0 && (
                            <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                              {voiceCorrections
                                .map((c, i) => ({ c, i }))
                                .filter(({ c }) => {
                                  const q = dictQuery.trim().toLowerCase();
                                  return !q || c.from.toLowerCase().includes(q) || c.to.toLowerCase().includes(q);
                                })
                                .map(({ c, i }) => (
                                  <div key={i} className="flex items-center gap-2 text-[12px]">
                                    <input
                                      value={c.from}
                                      maxLength={60}
                                      onChange={(e) => setVoiceCorrections(voiceCorrections.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}
                                      className="flex-1 min-w-0 px-2 py-1 bg-[#2a2a2a] border border-transparent focus:border-cyan-500 rounded text-white/75 outline-none"
                                    />
                                    <span className="text-white/35">→</span>
                                    <input
                                      value={c.to}
                                      maxLength={60}
                                      onChange={(e) => setVoiceCorrections(voiceCorrections.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
                                      className="flex-1 min-w-0 px-2 py-1 bg-[#2a2a2a] border border-transparent focus:border-cyan-500 rounded text-cyan-300/90 outline-none"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => setVoiceCorrections(voiceCorrections.filter((_, j) => j !== i))}
                                      className="p-1 text-white/35 hover:text-red-400 transition-colors"
                                      title={t('voiceDictRemove')}
                                    >
                                      <X size={13} />
                                    </button>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Spoken language follows the translation "From" setting */}
                    <p className="text-[11px] text-white/35 px-1">{t('voiceLangFollowNote')}</p>
                  </>
                )}
              </div>

              {/* Auto Start */}
              <div className="bg-[#252526] rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] text-white/80">{t('startAtLogin')}</span>
                  <Toggle
                    enabled={autoStart}
                    onChange={handleAutoStartChange}
                    size="sm"
                  />
                </div>
              </div>

              {/* macOS Accessibility - Only show on macOS */}
              {isMac && (
                <div className="bg-[#252526] rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2.5">
                    {/* A shield read as "security warning"; this is a permission the user
                        GRANTS, and macOS labels it with the same accessibility mark. The
                        tinted badge also gives a 14px glyph enough weight to sit beside
                        14px type instead of floating next to it. */}
                    <span className="w-6 h-6 rounded-md bg-amber-500/15 border border-amber-500/25 grid place-items-center shrink-0">
                      <Accessibility size={14} className="text-amber-400" />
                    </span>
                    <span className="text-[14px] font-medium text-white/80">{t('macAccessibility')}</span>
                  </div>
                  <p className="text-[12px] text-white/50">{t('macAccessibilityDesc')}</p>
                  <p className="text-[12px] text-amber-400/80">{t('macAccessibilityHelp')}</p>
                  <button
                    onClick={async () => {
                      try {
                        await invoke('open_accessibility_settings');
                      } catch (err) {
                        console.error('Failed to open accessibility settings:', err);
                      }
                    }}
                    className="w-full px-3 py-2 text-[12px] bg-amber-600 hover:bg-amber-500 text-white rounded font-medium transition-colors"
                  >
                    {t('openAccessibilitySettings')}
                  </button>
                </div>
              )}
              </div>
            </div>
          )}

          {activeTab === 'shortcuts' && (
            <div className="space-y-4 w-full">
              {/* Shortcuts group: Translate, Popup, Terminal + Enhance Mode */}
              <div className="bg-[#252526] rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Keyboard size={14} className="text-white/60" />
                  <span className="text-[14px] font-medium text-white/80">{t('shortcuts')}</span>
                </div>

                {/* Translate Shortcut */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[14px] font-medium text-white/80">{t('translateReplace')}</label>
                    <span className="text-[12px] text-white/40">{t('translateReplaceDesc')}</span>
                  </div>
                  {isRecording === 'translate' ? (
                    <div className="flex gap-2">
                      <div className="flex-1 px-3 py-2 bg-[#0078d4]/20 border-2 border-[#0078d4] rounded text-center animate-pulse">
                        <span className="text-[14px] font-medium">
                          {recordedKeys.length > 0 ? formatShortcut(recordedKeys.join('+')) : t('pressKeys')}
                        </span>
                      </div>
                      <button
                        onClick={() => { setIsRecording(null); setRecordedKeys([]); }}
                        className="px-3 text-[12px] bg-[#3c3c3c] hover:bg-[#454545] rounded"
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <div className="flex-1 px-3 py-1.5 bg-[#3c3c3c] rounded">
                        <span className="text-[14px] font-mono">{formatShortcut(shortcut)}</span>
                      </div>
                      <button
                        onClick={() => { setIsRecording('translate'); setRecordedKeys([]); }}
                        className="px-3 text-[12px] bg-[#0078d4] hover:bg-[#0078d4]/80 rounded"
                      >
                        {t('record')}
                      </button>
                    </div>
                  )}
                </div>

                {/* Popup Shortcut */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[14px] font-medium text-green-300">{t('translatePopup')}</label>
                    <span className="text-[12px] text-white/40">{t('translatePopupDesc')}</span>
                  </div>
                  {isRecording === 'popup' ? (
                    <div className="flex gap-2">
                      <div className="flex-1 px-3 py-2 bg-green-500/20 border-2 border-green-500 rounded text-center animate-pulse">
                        <span className="text-[14px] font-medium">
                          {recordedKeys.length > 0 ? formatShortcut(recordedKeys.join('+')) : t('pressKeys')}
                        </span>
                      </div>
                      <button
                        onClick={() => { setIsRecording(null); setRecordedKeys([]); }}
                        className="px-3 text-[12px] bg-[#3c3c3c] hover:bg-[#454545] rounded"
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <div className="flex-1 px-3 py-1.5 bg-green-500/10 border border-green-500/30 rounded">
                        <span className="text-[14px] font-mono text-green-300">{formatShortcut(popupShortcut)}</span>
                      </div>
                      <button
                        onClick={() => { setIsRecording('popup'); setRecordedKeys([]); }}
                        className="px-3 text-[12px] bg-green-600 hover:bg-green-600/80 rounded"
                      >
                        {t('record')}
                      </button>
                    </div>
                  )}
                </div>

                {/* Terminal Shortcut */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[14px] font-medium text-amber-300">{t('terminalMode')}</label>
                    <span className="text-[12px] text-white/40">{t('terminalModeDesc')}</span>
                  </div>
                  {isRecording === 'terminal' ? (
                    <div className="flex gap-2">
                      <div className="flex-1 px-3 py-2 bg-amber-500/20 border-2 border-amber-500 rounded text-center animate-pulse">
                        <span className="text-[14px] font-medium">
                          {recordedKeys.length > 0 ? formatShortcut(recordedKeys.join('+')) : t('pressKeys')}
                        </span>
                      </div>
                      <button
                        onClick={() => { setIsRecording(null); setRecordedKeys([]); }}
                        className="px-3 text-[12px] bg-[#3c3c3c] hover:bg-[#454545] rounded"
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <div className="flex-1 px-3 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded">
                        <span className="text-[14px] font-mono text-amber-300">{formatShortcut(terminalShortcut)}</span>
                      </div>
                      <button
                        onClick={() => { setIsRecording('terminal'); setRecordedKeys([]); }}
                        className="px-3 text-[12px] bg-amber-600 hover:bg-amber-600/80 rounded"
                      >
                        {t('record')}
                      </button>
                    </div>
                  )}
                </div>

                {/* Divider */}
                <div className="border-t border-[#3c3c3c]" />

                {/* Enhance Mode */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles size={14} className="text-purple-400" />
                      <span className="text-[14px] font-medium text-purple-300">{t('enhanceMode')}</span>
                    </div>
                    <Toggle
                      enabled={enhanceEnabled}
                      onChange={(enabled) => { console.log('[Settings] Enhance:', enabled); setEnhanceEnabled(enabled); }}
                      size="sm"
                    />
                  </div>
                  <p className="text-[12px] text-white/40">
                    {enhanceEnabled ? `✓ ${t('enhanceModeOn')}` : t('enhanceModeOff')}
                  </p>
                </div>
              </div>

              {/* Voice shortcuts only — enable + stop mode live in the General tab */}
              <div className="bg-[#252526] rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <Mic size={14} className="text-cyan-400" />
                  <span className="text-[14px] font-medium text-cyan-300">{t('voiceInput')}</span>
                </div>
                {voiceEnabled ? (
                  <>
                    {/* Voice → Original shortcut (primary — raw transcription, shown first) */}
                    <div className="space-y-1.5">
                      <span className="text-[12px] text-white/50">{t('voiceOriginalLabel')}</span>
                      {isRecording === 'voiceOriginal' ? (
                        <div className="flex gap-2">
                          <div className="flex-1 px-3 py-2 bg-cyan-500/20 border-2 border-cyan-500 rounded text-center animate-pulse">
                            <span className="text-[14px] font-medium">
                              {recordedKeys.length > 0 ? formatShortcut(recordedKeys.join('+')) : t('pressKeys')}
                            </span>
                          </div>
                          <button
                            onClick={() => { setIsRecording(null); setRecordedKeys([]); }}
                            className="px-3 text-[12px] bg-[#3c3c3c] hover:bg-[#454545] rounded"
                          >
                            {t('cancel')}
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <div className="flex-1 px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/30 rounded">
                            <span className="text-[14px] font-mono text-cyan-300">{formatShortcut(voiceOriginalShortcut)}</span>
                          </div>
                          <button
                            onClick={() => { setIsRecording('voiceOriginal'); setRecordedKeys([]); }}
                            className="px-3 text-[12px] bg-cyan-600 hover:bg-cyan-600/80 rounded"
                          >
                            {t('record')}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Voice → Translate shortcut */}
                    <div className="space-y-1.5">
                      <span className="text-[12px] text-white/50">{t('voiceTranslateLabel')}</span>
                      {isRecording === 'voice' ? (
                        <div className="flex gap-2">
                          <div className="flex-1 px-3 py-2 bg-cyan-500/20 border-2 border-cyan-500 rounded text-center animate-pulse">
                            <span className="text-[14px] font-medium">
                              {recordedKeys.length > 0 ? formatShortcut(recordedKeys.join('+')) : t('pressKeys')}
                            </span>
                          </div>
                          <button
                            onClick={() => { setIsRecording(null); setRecordedKeys([]); }}
                            className="px-3 text-[12px] bg-[#3c3c3c] hover:bg-[#454545] rounded"
                          >
                            {t('cancel')}
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <div className="flex-1 px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/30 rounded">
                            <span className="text-[14px] font-mono text-cyan-300">{formatShortcut(voiceShortcut)}</span>
                          </div>
                          <button
                            onClick={() => { setIsRecording('voice'); setRecordedKeys([]); }}
                            className="px-3 text-[12px] bg-cyan-600 hover:bg-cyan-600/80 rounded"
                          >
                            {t('record')}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Hint: popup position lives in the Appearance tab */}
                    <button
                      onClick={() => setActiveTab('appearance')}
                      className="text-left text-[11px] text-cyan-400/80 hover:text-cyan-300 hover:underline px-1"
                    >
                      {t('voicePopupHint')}
                    </button>
                  </>
                ) : (
                  <p className="text-[12px] text-white/40">{t('voiceEnableInGeneral')}</p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="space-y-5 w-full">
              {/* App (UI) language */}
              <div className="bg-[#252526] rounded-lg p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <Globe size={16} className="text-indigo-400" />
                  <span className="text-[15px] font-semibold text-white/90">{t('language')}</span>
                </div>
                <p className="text-[12px] text-white/40">{t('uiLanguageDesc')}</p>
                <Select
                  value={uiLanguage}
                  onChange={(value) => { console.log('[Settings] UI Language:', value); setUiLanguage(value as Language); }}
                  options={UI_LANGUAGES.map((lang) => ({ value: lang.code, label: lang.nativeName }))}
                  maxHeight={150}
                />
              </div>

              {/* Font */}
              <div className="bg-[#252526] rounded-lg p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <Palette size={16} className="text-indigo-400" />
                  <span className="text-[15px] font-semibold text-white/90">{t('font')}</span>
                </div>
                <p className="text-[12px] text-white/40">{t('fontDesc')}</p>
                <Select
                  value={uiFont}
                  onChange={setUiFont}
                  options={FONT_OPTIONS.map((f) => ({ value: f.id, label: f.name }))}
                />
                <div className="mt-1 px-3 py-2 rounded-md bg-[#1e1e1e] border border-[#3c3c3c]" style={{ fontFamily: fontStackFor(uiFont) }}>
                  <p className="text-[15px] text-white/90 leading-snug">{t('fontSample')}</p>
                  <p className="text-[12px] text-white/50">{t('sampleText')} · 0123456789</p>
                </div>
              </div>

              {/* UI size */}
              <div className="bg-[#252526] rounded-lg p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <Languages size={16} className="text-indigo-400" />
                  <span className="text-[15px] font-semibold text-white/90">{t('textSize')}</span>
                </div>
                <p className="text-[12px] text-white/40">{t('textSizeDesc')}</p>
                <div className="grid grid-cols-4 gap-2">
                  {UI_SCALE_OPTIONS.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setUiScale(s.id)}
                      className={`py-2.5 rounded-lg text-[13px] font-medium transition-colors flex flex-col items-center gap-0.5 ${
                        uiScale === s.id
                          ? 'bg-indigo-600 text-white'
                          : 'bg-[#1e1e1e] text-white/60 hover:text-white hover:bg-[#3c3c3c]'
                      }`}
                    >
                      <span className="text-[16px] font-bold leading-none">A</span>
                      <span className="text-[11px] leading-none">{s.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Recording popup position (top / center / bottom) */}
              <div className="bg-[#252526] rounded-lg p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <Mic size={16} className="text-indigo-400" />
                  <span className="text-[15px] font-semibold text-white/90">{t('voicePopupPosition')}</span>
                </div>
                <p className="text-[12px] text-white/40">{t('voicePopupPositionDesc')}</p>
                <div className="grid grid-cols-3 gap-2">
                  {([['top', t('positionTop')], ['center', t('positionCenter')], ['bottom', t('positionBottom')]] as const).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => { console.log('[Settings] Popup position:', id); setVoicePopupPosition(id); }}
                      className={`py-2.5 rounded-lg text-[13px] font-medium transition-colors ${
                        voicePopupPosition === id
                          ? 'bg-indigo-600 text-white'
                          : 'bg-[#1e1e1e] text-white/60 hover:text-white hover:bg-[#3c3c3c]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'feedback' && (
            <div className="space-y-5 w-full">
              {/* Sound */}
              <div className="bg-[#252526] rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-500/20 rounded">
                      <Volume2 size={18} className="text-blue-400" />
                    </div>
                    <div>
                      <span className="text-[14px] text-white/80 block">{t('soundFeedback')}</span>
                      <span className="text-[12px] text-white/40">{t('soundFeedbackDesc')}</span>
                    </div>
                  </div>
                  <Toggle
                    enabled={soundEnabled}
                    onChange={(enabled) => { console.log('[Settings] Sound:', enabled); setSoundEnabled(enabled); }}
                  />
                </div>
              </div>

              {/* Voice listening sound (on/off beep when recording starts/stops) */}
              <div className="bg-[#252526] rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-cyan-500/20 rounded">
                      <Mic size={18} className="text-cyan-400" />
                    </div>
                    <div>
                      <span className="text-[14px] text-white/80 block">{t('voiceSound')}</span>
                      <span className="text-[12px] text-white/40">{t('voiceSoundDesc')}</span>
                    </div>
                  </div>
                  <Toggle
                    enabled={voiceSoundEnabled}
                    onChange={(enabled) => { console.log('[Settings] Voice sound:', enabled); setVoiceSoundEnabled(enabled); }}
                  />
                </div>
              </div>

              {/* Loading */}
              <div className="bg-[#252526] rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-purple-500/20 rounded">
                      <Loader2 size={18} className="text-purple-400" />
                    </div>
                    <div>
                      <span className="text-[14px] text-white/80 block">{t('loadingIndicator')}</span>
                      <span className="text-[12px] text-white/40">{t('loadingIndicatorDesc')}</span>
                      <span className="text-[12px] text-amber-400 block">⚠️ {t('loadingWarning')}</span>
                    </div>
                  </div>
                  <Toggle
                    enabled={loadingEnabled}
                    onChange={(enabled) => { console.log('[Settings] Loading:', enabled); setLoadingEnabled(enabled); }}
                  />
                </div>
              </div>

              {/* Updates: auto-check toggle + manual check */}
              <div className="bg-[#252526] rounded-lg p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-cyan-500/20 rounded">
                      <RefreshCw size={18} className="text-cyan-400" />
                    </div>
                    <div>
                      <span className="text-[14px] text-white/80 block">{t('autoUpdateLabel')}</span>
                      <span className="text-[12px] text-white/40">{t('autoUpdateDesc')}</span>
                    </div>
                  </div>
                  <Toggle enabled={autoUpdateCheck} onChange={setAutoUpdateCheck} />
                </div>
                <button
                  onClick={handleCheckForUpdates}
                  disabled={checkingUpdate || !onCheckForUpdates}
                  className="mt-3 w-full px-3 py-2 text-[13px] rounded-md bg-[#1e1e1e] border border-[#3c3c3c] text-white/80 hover:bg-white/5 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  <RefreshCw size={14} className={checkingUpdate ? 'animate-spin' : ''} />
                  {checkingUpdate ? t('checkingUpdate') : t('checkForUpdates')}
                </button>
              </div>

              {/* Info Box */}
              <div className="bg-[#252526] rounded-lg p-4 text-[12px] text-white/50">
                <p className="font-medium text-white/70 mb-2">{t('recommendation')}</p>
                <ul className="list-disc list-inside space-y-1">
                  <li><strong className="text-white/70">{t('soundOn')}</strong> - {t('soundOnDesc')}</li>
                  <li><strong className="text-white/70">{t('loadingOn')}</strong> - {t('loadingOnDesc')}</li>
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'tutorial' && (
            <div className="space-y-5 w-full">
              {/* Quick Start */}
              <div className="bg-[#252526] rounded-lg p-4 space-y-3">
                <h3 className="text-[14px] font-semibold text-white flex items-center gap-2">
                  <BookOpen size={16} className="text-blue-400" /> {t('quickStart')}
                </h3>
                <ol className="space-y-2 text-[12px] text-white/70">
                  <li className="flex gap-2"><span className="text-[#0078d4] font-mono">1.</span> {t('quickStart1')}</li>
                  <li className="flex gap-2"><span className="text-[#0078d4] font-mono">2.</span> {t('quickStart2')}</li>
                  <li className="flex gap-2"><span className="text-[#0078d4] font-mono">3.</span> {t('quickStart3')}</li>
                  <li className="flex gap-2"><span className="text-[#0078d4] font-mono">4.</span> {t('quickStart4')}</li>
                  <li className="flex gap-2"><span className="text-[#0078d4] font-mono">5.</span> {t('quickStart5')}</li>
                  {voiceEnabled && <li className="flex gap-2"><span className="text-cyan-400 font-mono">6.</span> {t('quickStartVoice')}</li>}
                </ol>
              </div>

              {/* Tip: mouse button as a shortcut (via mouse-software key mapping) */}
              <div className="bg-[#252526] rounded-lg p-4 flex items-start gap-3">
                <div className="p-2 bg-purple-500/20 rounded shrink-0">
                  <MousePointer size={16} className="text-purple-400" />
                </div>
                <div>
                  <h3 className="text-[13.5px] font-semibold text-white mb-1">{t('mouseTipTitle')}</h3>
                  <p className="text-[12px] text-white/60 leading-relaxed">{t('mouseTipDesc')}</p>
                </div>
              </div>

              {/* Shortcuts Guide */}
              <div className="bg-[#252526] rounded-lg p-4 space-y-3">
                <h3 className="text-[14px] font-semibold text-white flex items-center gap-2">
                  <Keyboard size={16} className="text-blue-400" /> {t('shortcuts')}
                </h3>
                <div className="space-y-3">
                  <div className="flex items-start gap-3 p-2 bg-[#1e1e1e] rounded">
                    <div className="p-1.5 bg-blue-500/20 rounded">
                      <MousePointer size={14} className="text-blue-400" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-medium text-white">{t('translateReplace')}</span>
                        <code className="px-2 py-0.5 bg-[#3c3c3c] rounded text-[12px] text-blue-300">{formatShortcut(shortcut)}</code>
                      </div>
                      <p className="text-[12px] text-white/50 mt-1">{t('shortcutReplaceDesc')}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 p-2 bg-[#1e1e1e] rounded">
                    <div className="p-1.5 bg-green-500/20 rounded">
                      <MessageSquare size={14} className="text-green-400" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-medium text-white">{t('translatePopup')}</span>
                        <code className="px-2 py-0.5 bg-[#3c3c3c] rounded text-[12px] text-green-300">{formatShortcut(popupShortcut)}</code>
                      </div>
                      <p className="text-[12px] text-white/50 mt-1">{t('shortcutPopupDesc')}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 p-2 bg-[#1e1e1e] rounded">
                    <div className="p-1.5 bg-amber-500/20 rounded">
                      <Keyboard size={14} className="text-amber-400" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-medium text-white">{t('terminalMode')}</span>
                        <code className="px-2 py-0.5 bg-[#3c3c3c] rounded text-[12px] text-amber-300">{formatShortcut(terminalShortcut)}</code>
                      </div>
                      <p className="text-[12px] text-white/50 mt-1">{t('shortcutTerminalDesc')}</p>
                    </div>
                  </div>
                  {voiceEnabled && (
                    <div className="flex items-start gap-3 p-2 bg-[#1e1e1e] rounded">
                      <div className="p-1.5 bg-cyan-500/20 rounded">
                        <Mic size={14} className="text-cyan-400" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] font-medium text-white">{t('voiceInput')}</span>
                          <code className="px-2 py-0.5 bg-[#3c3c3c] rounded text-[12px] text-cyan-300">{formatShortcut(voiceOriginalShortcut)}</code>
                        </div>
                        <p className="text-[12px] text-white/50 mt-1">{t('shortcutVoiceDesc')}</p>
                      </div>
                    </div>
                  )}
                  {enhanceEnabled && (
                    <div className="flex items-start gap-3 p-2 bg-purple-500/10 border border-purple-500/30 rounded">
                      <div className="p-1.5 bg-purple-500/20 rounded">
                        <Sparkles size={14} className="text-purple-400" />
                      </div>
                      <div className="flex-1">
                        <span className="text-[14px] font-medium text-purple-300">{t('enhanceModeActive')}</span>
                        <p className="text-[12px] text-white/50 mt-1">{t('enhanceModeActiveDesc')}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Tips */}
              <div className="bg-[#252526] rounded-lg p-4 space-y-3">
                <h3 className="text-[14px] font-semibold text-white flex items-center gap-2">
                  <BookOpen size={16} className="text-amber-400" /> {t('tips')}
                </h3>
                <ul className="space-y-2 text-[12px] text-white/60">
                  <li className="flex gap-2">
                    <span className="text-green-400">•</span>
                    <span><strong className="text-white/80">{t('tipAlwaysRunning')}</strong> {t('tipAlwaysRunningDesc')}</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-amber-400">•</span>
                    <span><strong className="text-white/80">{t('tipBuiltinFree')}</strong> {t('tipBuiltinFreeDesc')}</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-amber-400">•</span>
                    <span><strong className="text-white/80">{t('tipOwnApiKey')}</strong> {t('tipOwnApiKeyDesc')}</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-amber-400">•</span>
                    <span><strong className="text-white/80">{t('tipAutoDetect')}</strong> {t('tipAutoDetectDesc')}</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-amber-400">•</span>
                    <span><strong className="text-white/80">{t('tipMessagingApps')}</strong> {t('tipMessagingAppsDesc')}</span>
                  </li>
                </ul>
              </div>

              {/* Status bar note (kept from the old How-It-Works section) */}
              <div className="p-2.5 bg-[#1e1e1e] rounded-lg text-[12px] text-white/40">
                <strong className="text-white/60">{t('note')}</strong> {t('statusBarNote')}
              </div>
            </div>
          )}
        </div>

        {/* Console Panel */}
        {showConsole && (
          <div className="w-1/2 border-l border-[#454545] flex flex-col bg-[#1e1e1e]">
            <div className="h-8 bg-[#252526] flex items-center justify-between px-3 border-b border-[#454545]">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-white/60">Console</span>
                <span className="px-1.5 py-0.5 bg-[#3c3c3c] rounded text-[11px] text-white/50">{logs.length}</span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => { navigator.clipboard.writeText(logs.join('\n')); toast.success('Copied!'); }}
                  className="p-1 hover:bg-[#3c3c3c] rounded"
                  title="Copy"
                >
                  <Copy size={12} className="text-white/50" />
                </button>
                <button
                  onClick={() => setLogs([])}
                  className="px-2 text-[12px] text-white/50 hover:text-white hover:bg-[#3c3c3c] rounded"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 font-mono text-[12px] leading-relaxed bg-[#1e1e1e]">
              {logs.length === 0 ? (
                <div className="text-white/30">Waiting for events...</div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className={`${
                    log.includes('[ERR]') ? 'text-red-400' :
                    log.includes('[WARN]') ? 'text-yellow-400' :
                    log.includes('[Enhance]') ? 'text-purple-400' : 'text-green-400'
                  }`}>
                    {log}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className={`h-6 flex items-center justify-between px-2 text-[11px] ${appEnabled ? 'bg-[#007acc]' : 'bg-[#6c6c6c]'}`}>
        <div className="flex items-center gap-2">
          <span className={`font-medium ${appEnabled ? 'text-green-200' : 'text-red-200'}`}>
            {appEnabled ? '● ON' : '○ OFF'}
          </span>
          {appEnabled && (
            <>
              {enhanceEnabled && <span className="text-purple-200 font-medium">ENHANCE</span>}
              <span>{formatShortcut(shortcut)}</span>
              <span className="text-green-200">{formatShortcut(popupShortcut)}</span>
              <span className="text-amber-200">{formatShortcut(terminalShortcut)}</span>
              {voiceEnabled && <span className="text-cyan-200">🎙 {formatShortcut(voiceShortcut)}</span>}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-yellow-200">{AI_PROVIDERS[provider].name.split(' ')[0]}</span>
          <span>{soundEnabled ? '🔊' : '🔇'}</span>
          <button
            onClick={() => setShowChangelog(true)}
            title={t('whatsNew')}
            className="hover:bg-white/15 rounded px-1 -mx-0.5 transition-colors cursor-pointer"
          >
            v{appVersion}
          </button>
        </div>
      </div>

      {/* What's New / Changelog (opened by clicking the version) */}
      {showChangelog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          onClick={() => setShowChangelog(false)}
        >
          <div
            className="w-full max-w-md max-h-[80vh] flex flex-col bg-[#252526] border border-[#454545] rounded-lg shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#454545]">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-blue-400" />
                <span className="text-[14px] font-semibold text-white">{t('whatsNew')}</span>
              </div>
              <button
                onClick={() => setShowChangelog(false)}
                className="p-1 rounded hover:bg-[#3c3c3c] text-white/50 hover:text-white transition-colors"
              >
                <XCircle size={16} />
              </button>
            </div>
            <div className="overflow-y-auto p-4 space-y-4">
              {CHANGELOG.map((entry, i) => (
                <div key={entry.version} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-white">v{entry.version}</span>
                    {i === 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-green-500/20 text-green-300 text-[9px] font-semibold tracking-wide">{t('latest')}</span>
                    )}
                    {entry.date && <span className="text-[11px] text-white/30">{entry.date}</span>}
                  </div>
                  <ul className="space-y-1 text-[12px] text-white/60">
                    {entry.changes.map((c, j) => (
                      <li key={j} className="flex gap-2">
                        <span className="text-blue-400 mt-px">•</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
