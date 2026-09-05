export interface Translation {
  original: string;
  translated: string;
  sourceLang: string;
  targetLang: string;
}

export interface TranslateResult {
  translatedText: string;
  detectedLang?: string;
}

export type TranslationMode = 'replace' | 'popup';

// Voice-to-Text: 'translate' transcribes then translates to targetLang,
// 'original' pastes the raw transcription as-is.
export type VoiceMode = 'translate' | 'original';

export type VoiceStatus =
  | 'idle'
  // Between the shortcut and the microphone actually capturing there is a real gap
  // (system mute + getUserMedia + recorder start). Showing 'recording' during it invited
  // users to start talking ~500ms before anything was being recorded, so the first words
  // were lost. 'starting' owns that window.
  | 'starting'
  | 'recording'
  | 'transcribing'
  | 'translating'
  | 'cleaning'
  | 'pasting'
  | 'done'
  | 'error';

export type AIProvider = 'server' | 'openai' | 'openrouter' | 'groq' | 'gemini' | 'custom';

export type TranslationStatus =
  | 'idle'
  | 'copying'
  | 'translating'
  | 'pasting'
  | 'done'
  | 'error';

export type LicenseStatus = 'none' | 'validating' | 'valid' | 'invalid';

export type SupportedLanguage =
  | 'auto'
  | 'id'
  | 'en'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'es'
  | 'fr'
  | 'de'
  | 'ru'
  | 'ar'
  | 'pt';

export interface Language {
  code: SupportedLanguage;
  name: string;
}

export interface Settings {
  apiKey: string | null;
  provider: AIProvider;
  shortcut: string;
  sourceLang: string;
  targetLang: string;
  autoStart: boolean;
  mode: TranslationMode;
  enhanceEnabled: boolean;
  enhanceShortcut: string;
  soundEnabled: boolean;
  loadingEnabled: boolean;
  // Voice-to-Text
  voiceEnabled: boolean;
  voiceShortcut: string;
  voiceOriginalShortcut: string;
  voiceAutoStop: boolean; // true = stop on silence (VAD); false = manual (press shortcut again)
  voiceHoldToTalk: boolean; // true = hold shortcut while speaking; false = press to toggle
  // Appearance
  uiFont: string;  // FONT_OPTIONS id
  uiScale: string; // UI_SCALE_OPTIONS id
  // Custom (OpenAI-compatible) provider
  customBaseURL: string;
  customModel: string;
}
