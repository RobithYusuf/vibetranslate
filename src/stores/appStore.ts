import { create } from 'zustand';
import { Translation, TranslationMode, TranslationStatus, VoiceStatus, AIProvider, LicenseStatus } from '@/types';
import { VoiceCorrection } from '@/utils/voiceCorrections';
import { Language } from '@/i18n';
import {
  DEFAULT_SHORTCUT,
  DEFAULT_POPUP_SHORTCUT,
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
  DEFAULT_MODE,
  DEFAULT_ENHANCE_SHORTCUT,
  DEFAULT_TERMINAL_SHORTCUT,
  DEFAULT_VOICE_SHORTCUT,
  DEFAULT_VOICE_ORIGINAL_SHORTCUT,
  DEFAULT_VOICE_HOLD_TO_TALK,
  DEFAULT_VOICE_AUTO_STOP,
  DEFAULT_VOICE_ENABLED,
  DEFAULT_VOICE_POPUP_POSITION,
  DEFAULT_VOICE_SOUND_ENABLED,
  DEFAULT_MIC_AUTO_GAIN,
  DEFAULT_VOICE_MAX_MINUTES,
  DEFAULT_VOICE_SILENCE_SEC,
  DEFAULT_UI_FONT,
  DEFAULT_UI_SCALE,
  DEFAULT_PROVIDER,
  AI_PROVIDERS,
} from '@/utils/constants';

interface AppState {
  // License
  licenseKey: string | null;
  licenseStatus: LicenseStatus;
  
  // App enabled state (global on/off)
  appEnabled: boolean;

  // True once persisted settings have been loaded from disk. Gates autosave so the
  // 500ms debounced save can't write default values before load completes.
  settingsLoaded: boolean;

  // True while the Settings shortcut recorder is active. Tells the native mouse hook to stop
  // swallowing/triggering mouse buttons so a bound button can be re-recorded (and won't fire its
  // action) while you're setting a new shortcut.
  recordingShortcut: boolean;
  
  // UI Language
  uiLanguage: Language;
  
  apiKeys: Record<AIProvider, string | null>;
  provider: AIProvider;
  model: string;
  customBaseURL: string; // for the 'custom' OpenAI-compatible provider
  customModel: string;
  shortcut: string;
  popupShortcut: string;
  terminalShortcut: string;
  sourceLang: string;
  targetLang: string;
  autoStart: boolean;
  mode: TranslationMode;
  
  // Enhance feature
  enhanceEnabled: boolean;
  enhanceShortcut: string;

  // Voice-to-Text feature
  voiceEnabled: boolean;
  voiceShortcut: string;
  voiceOriginalShortcut: string;
  voiceAutoStop: boolean; // true = auto-stop on silence (BETA); false = manual (press shortcut again)
  voiceHoldToTalk: boolean; // true = hold shortcut while speaking, release to stop
  voiceMaxMinutes: number; // safety cap for one recording, in minutes (system audio stays muted while recording)
  voiceSilenceSec: number; // AUTO-STOP only: how long a pause ends the utterance (seconds)
  micDeviceId: string; // preferred microphone deviceId ('' = system default)
  lastMicUsed: string; // label of the mic actually used in the last recording (session-only)
  voiceCorrections: VoiceCorrection[]; // post-transcription find-and-replace dictionary
  voicePopupPosition: string; // 'top' | 'center' | 'bottom'
  voiceSoundEnabled: boolean; // sound when voice recording starts/stops
  micAutoGain: boolean;       // single mic knob: boost quiet mics (AGC) so speech is heard
  voiceSttEngine: string;     // 'auto' (online: BYOK/server) | 'omnilingual-300m' (offline, experimental)
  // Live dictation: text appears while you speak, still pasted once at the end. Development
  // only for now — the toggle is hidden in production builds until it has been used in anger.
  voiceLiveMode: boolean;
  voiceCleanup: boolean;      // Original mode: AI proofreads the transcript (mishearings/punctuation only)
  isRecording: boolean;
  voiceStatus: VoiceStatus;

  // Appearance
  uiFont: string;
  uiScale: string;

  // Feedback settings
  soundEnabled: boolean;
  loadingEnabled: boolean;

  // Auto-update
  autoUpdateCheck: boolean;       // check for updates automatically on startup
  skippedUpdateVersion: string;   // a version the user chose to skip (don't re-prompt for it)

  isTranslating: boolean;
  isEnhancing: boolean; // Track if current operation is enhance
  translationStatus: TranslationStatus;
  currentTranslation: Translation | null;
  error: string | null;
  
  // Abort controller for cancelling
  abortController: AbortController | null;

  // License setters
  setLicenseKey: (key: string | null) => void;
  setLicenseStatus: (status: LicenseStatus) => void;
  
  // App enabled setter
  setAppEnabled: (enabled: boolean) => void;
  setSettingsLoaded: (loaded: boolean) => void;
  setRecordingShortcut: (recording: boolean) => void;

  // UI Language setter
  setUiLanguage: (lang: Language) => void;
  
  setApiKey: (key: string | null) => void;
  setApiKeyFor: (provider: AIProvider, key: string | null) => void;
  setProvider: (provider: AIProvider) => void;
  setModel: (model: string) => void;
  setCustomBaseURL: (url: string) => void;
  setCustomModel: (model: string) => void;
  setShortcut: (shortcut: string) => void;
  setPopupShortcut: (shortcut: string) => void;
  setTerminalShortcut: (shortcut: string) => void;
  setSourceLang: (lang: string) => void;
  setTargetLang: (lang: string) => void;
  setAutoStart: (enabled: boolean) => void;
  setMode: (mode: TranslationMode) => void;
  swapLanguages: () => void;
  
  // Enhance setters
  setEnhanceEnabled: (enabled: boolean) => void;
  setEnhanceShortcut: (shortcut: string) => void;

  // Voice setters
  setVoiceEnabled: (enabled: boolean) => void;
  setVoiceAutoStop: (enabled: boolean) => void;
  setVoiceHoldToTalk: (enabled: boolean) => void;
  setVoiceMaxMinutes: (minutes: number) => void;
  setVoiceSilenceSec: (seconds: number) => void;
  setMicDeviceId: (deviceId: string) => void;
  setLastMicUsed: (label: string) => void;
  setVoiceCorrections: (corrections: VoiceCorrection[]) => void;
  setVoicePopupPosition: (position: string) => void;
  setVoiceSoundEnabled: (enabled: boolean) => void;
  setMicAutoGain: (enabled: boolean) => void;
  setVoiceSttEngine: (engine: string) => void;
  setVoiceLiveMode: (voiceLiveMode: boolean) => void;
  setVoiceCleanup: (enabled: boolean) => void;
  setUiFont: (font: string) => void;
  setUiScale: (scale: string) => void;
  setVoiceShortcut: (shortcut: string) => void;
  setVoiceOriginalShortcut: (shortcut: string) => void;
  setIsRecording: (isRecording: boolean) => void;
  setVoiceStatus: (status: VoiceStatus) => void;

  // Feedback setters
  setSoundEnabled: (enabled: boolean) => void;
  setLoadingEnabled: (enabled: boolean) => void;

  // Auto-update setters
  setAutoUpdateCheck: (enabled: boolean) => void;
  setSkippedUpdateVersion: (version: string) => void;

  setTranslating: (isTranslating: boolean) => void;
  setEnhancing: (isEnhancing: boolean) => void;
  setTranslationStatus: (status: TranslationStatus) => void;
  setTranslation: (translation: Translation | null) => void;
  setError: (error: string | null) => void;
  clearTranslation: () => void;
  reset: () => void;
  
  // Abort functions
  setAbortController: (controller: AbortController | null) => void;
  cancelTranslation: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // License
  licenseKey: null,
  licenseStatus: 'none',
  
  // App enabled (global on/off)
  appEnabled: true,
  settingsLoaded: false,
  recordingShortcut: false,

  // UI Language (default English)
  uiLanguage: 'en' as Language,
  
  apiKeys: {
    server: null, // Uses server endpoint
    openai: null,
    openrouter: null,
    groq: null,
    gemini: null,
    custom: null,
  },
  provider: DEFAULT_PROVIDER,
  model: AI_PROVIDERS[DEFAULT_PROVIDER].defaultModel,
  customBaseURL: '',
  customModel: '',
  shortcut: DEFAULT_SHORTCUT,
  popupShortcut: DEFAULT_POPUP_SHORTCUT,
  terminalShortcut: DEFAULT_TERMINAL_SHORTCUT,
  sourceLang: DEFAULT_SOURCE_LANG,
  targetLang: DEFAULT_TARGET_LANG,
  autoStart: false,
  mode: DEFAULT_MODE as TranslationMode,
  
  // Enhance defaults
  enhanceEnabled: false,
  enhanceShortcut: DEFAULT_ENHANCE_SHORTCUT,

  // Voice defaults
  voiceEnabled: DEFAULT_VOICE_ENABLED, // Voice Input ON by default; auto-stop (below) stays OFF
  voiceShortcut: DEFAULT_VOICE_SHORTCUT,
  voiceOriginalShortcut: DEFAULT_VOICE_ORIGINAL_SHORTCUT,
  voiceAutoStop: DEFAULT_VOICE_AUTO_STOP,
  voiceHoldToTalk: DEFAULT_VOICE_HOLD_TO_TALK,
  voiceMaxMinutes: DEFAULT_VOICE_MAX_MINUTES,
  voiceSilenceSec: DEFAULT_VOICE_SILENCE_SEC,
  micDeviceId: '',
  lastMicUsed: '',
  voiceCorrections: [],
  voicePopupPosition: DEFAULT_VOICE_POPUP_POSITION,
  voiceSoundEnabled: DEFAULT_VOICE_SOUND_ENABLED,
  micAutoGain: DEFAULT_MIC_AUTO_GAIN,
  voiceSttEngine: 'auto',
  voiceLiveMode: false,
  voiceCleanup: false,
  uiFont: DEFAULT_UI_FONT,
  uiScale: DEFAULT_UI_SCALE,
  isRecording: false,
  voiceStatus: 'idle',

  // Feedback defaults
  soundEnabled: true,
  loadingEnabled: true,

  // Auto-update defaults
  autoUpdateCheck: true,
  skippedUpdateVersion: '',

  isTranslating: false,
  isEnhancing: false,
  translationStatus: 'idle',
  currentTranslation: null,
  error: null,
  abortController: null,

  // License setters
  setLicenseKey: (key) => set({ licenseKey: key }),
  setLicenseStatus: (status) => set({ licenseStatus: status }),
  
  // App enabled setter
  setAppEnabled: (enabled) => set({ appEnabled: enabled }),
  setSettingsLoaded: (settingsLoaded) => set({ settingsLoaded }),
  setRecordingShortcut: (recordingShortcut) => set({ recordingShortcut }),
  
  // UI Language setter
  setUiLanguage: (lang) => set({ uiLanguage: lang }),
  
  setApiKey: (key) => set((state) => ({ 
    apiKeys: { ...state.apiKeys, [state.provider]: key }
  })),
  setApiKeyFor: (provider, key) => set((state) => ({
    apiKeys: { ...state.apiKeys, [provider]: key }
  })),
  setProvider: (provider) => set({ 
    provider, 
    model: AI_PROVIDERS[provider].defaultModel,
    // API key is now per-provider, no need to reset
  }),
  setModel: (model) => set({ model }),
  setCustomBaseURL: (customBaseURL) => set({ customBaseURL }),
  setCustomModel: (customModel) => set({ customModel }),
  setShortcut: (shortcut) => set({ shortcut }),
  setPopupShortcut: (popupShortcut) => set({ popupShortcut }),
  setTerminalShortcut: (terminalShortcut) => set({ terminalShortcut }),
  setSourceLang: (lang) => set({ sourceLang: lang }),
  setTargetLang: (lang) => set({ targetLang: lang }),
  setAutoStart: (enabled) => set({ autoStart: enabled }),
  setMode: (mode) => set({ mode }),
  
  // Enhance setters
  setEnhanceEnabled: (enabled) => set({ enhanceEnabled: enabled }),
  setEnhanceShortcut: (shortcut) => set({ enhanceShortcut: shortcut }),

  // Voice setters
  setVoiceEnabled: (enabled) => set({ voiceEnabled: enabled }),
  setVoiceAutoStop: (enabled) => set({ voiceAutoStop: enabled }),
  setVoiceHoldToTalk: (voiceHoldToTalk) => set({ voiceHoldToTalk }),
  setVoiceMaxMinutes: (voiceMaxMinutes) => set({ voiceMaxMinutes }),
  setVoiceSilenceSec: (voiceSilenceSec) => set({ voiceSilenceSec }),
  setMicDeviceId: (micDeviceId) => set({ micDeviceId }),
  setLastMicUsed: (lastMicUsed) => set({ lastMicUsed }),
  setVoiceCorrections: (voiceCorrections) => set({ voiceCorrections }),
  setVoicePopupPosition: (voicePopupPosition) => set({ voicePopupPosition }),
  setVoiceSoundEnabled: (voiceSoundEnabled) => set({ voiceSoundEnabled }),
  setMicAutoGain: (micAutoGain) => set({ micAutoGain }),
  setVoiceSttEngine: (voiceSttEngine) => set({ voiceSttEngine }),
  setVoiceLiveMode: (voiceLiveMode) => set({ voiceLiveMode }),
  setVoiceCleanup: (voiceCleanup) => set({ voiceCleanup }),
  setUiFont: (uiFont) => set({ uiFont }),
  setUiScale: (uiScale) => set({ uiScale }),
  setVoiceShortcut: (voiceShortcut) => set({ voiceShortcut }),
  setVoiceOriginalShortcut: (voiceOriginalShortcut) => set({ voiceOriginalShortcut }),
  setIsRecording: (isRecording) => set({ isRecording }),
  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),

  // Feedback setters
  setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
  setLoadingEnabled: (enabled) => set({ loadingEnabled: enabled }),

  // Auto-update setters
  setAutoUpdateCheck: (autoUpdateCheck) => set({ autoUpdateCheck }),
  setSkippedUpdateVersion: (skippedUpdateVersion) => set({ skippedUpdateVersion }),

  swapLanguages: () => {
    const { sourceLang, targetLang } = get();
    if (sourceLang !== 'auto') {
      set({ sourceLang: targetLang, targetLang: sourceLang });
    }
  },

  setTranslating: (isTranslating) => set({ isTranslating }),
  setEnhancing: (isEnhancing) => set({ isEnhancing }),
  setTranslationStatus: (status) => set({ translationStatus: status }),
  setTranslation: (translation) => set({ currentTranslation: translation }),
  setError: (error) => set({ error, translationStatus: 'error' }),
  clearTranslation: () =>
    set({
      currentTranslation: null,
      error: null,
      translationStatus: 'idle',
    }),
  reset: () =>
    set({
      isTranslating: false,
      isEnhancing: false,
      translationStatus: 'idle',
      error: null,
    }),
    
  // Abort functions
  setAbortController: (controller) => set({ abortController: controller }),
  cancelTranslation: () => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
      set({ 
        abortController: null,
        isTranslating: false,
        isEnhancing: false,
        translationStatus: 'idle',
        error: 'Cancelled',
      });
    }
  },
}));
