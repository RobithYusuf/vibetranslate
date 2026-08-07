import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Copy, Check, ArrowRight, RefreshCw, ChevronDown } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { LANGUAGES, LANGUAGE_MAP } from '@/utils/constants';
import { translateText } from '@/services/openai';
import { useAppStore } from '@/stores/appStore';

interface TranslationData {
  original: string;
  translated: string;
  sourceLang: string;
  targetLang: string;
}

// Cache for translations: key = `${original}_${targetLang}`
const translationCache = new Map<string, string>();

export default function TranslationPopup() {
  const [translation, setTranslation] = useState<TranslationData | null>(null);
  const [selectedTargetLang, setSelectedTargetLang] = useState<string>('en');
  const [isRetranslating, setIsRetranslating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showLangDropdown, setShowLangDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Get store values for API calls
  const { apiKeys, provider, model } = useAppStore();
  const apiKey = apiKeys[provider];

  // Target languages (exclude 'auto')
  const targetLanguages = LANGUAGES.filter(l => l.code !== 'auto');

  useEffect(() => {
    setIsLoading(true);

    const unlisten = listen<TranslationData>('translation-result', (event) => {
      console.log('[Popup] Received translation:', event.payload);
      setTranslation(event.payload);
      setSelectedTargetLang(event.payload.targetLang);
      setCopied(false);
      setIsLoading(false);
      
      // Cache the initial translation
      const cacheKey = `${event.payload.original}_${event.payload.targetLang}`;
      translationCache.set(cacheKey, event.payload.translated);
    });

    const unlistenShow = listen('tauri://window-created', () => {
      console.log('[Popup] Window shown - waiting for data');
      setIsLoading(true);
    });

    const timeout = setTimeout(() => setIsLoading(false), 3000);

    return () => {
      unlisten.then(fn => fn());
      unlistenShow.then(fn => fn());
      clearTimeout(timeout);
    };
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowLangDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Re-translate when target language changes
  const handleTargetLangChange = useCallback(async (newLang: string) => {
    if (!translation || newLang === selectedTargetLang) {
      setShowLangDropdown(false);
      return;
    }

    setSelectedTargetLang(newLang);
    setShowLangDropdown(false);
    setCopied(false);

    // Check cache first
    const cacheKey = `${translation.original}_${newLang}`;
    const cached = translationCache.get(cacheKey);
    
    if (cached) {
      console.log('[Popup] Using cached translation for', newLang);
      setTranslation({
        ...translation,
        translated: cached,
        targetLang: newLang,
      });
      return;
    }

    // Need to re-translate
    setIsRetranslating(true);
    console.log('[Popup] Re-translating to', newLang);

    try {
      const result = await translateText({
        text: translation.original,
        sourceLang: translation.sourceLang,
        targetLang: newLang,
        apiKey: apiKey || '',
        provider,
        model,
      });

      // Cache the result
      translationCache.set(cacheKey, result.translatedText);

      setTranslation({
        ...translation,
        translated: result.translatedText,
        targetLang: newLang,
      });
    } catch (err) {
      console.error('[Popup] Re-translate failed:', err);
      // Revert to previous language
      setSelectedTargetLang(translation.targetLang);
    } finally {
      setIsRetranslating(false);
    }
  }, [translation, selectedTargetLang, apiKey, provider, model]);

  const handleCopy = async () => {
    if (translation?.translated) {
      await writeText(translation.translated);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleClose = async () => {
    await invoke('hide_popup');
  };

  const sourceLangName = translation
    ? LANGUAGE_MAP[translation.sourceLang] || translation.sourceLang
    : 'Auto';
  const targetLangName = LANGUAGE_MAP[selectedTargetLang] || selectedTargetLang;

  return (
    <div className="h-screen w-screen bg-slate-50 flex flex-col overflow-hidden">
      {/* Language Header with Dropdown */}
      <div className="px-4 py-3 bg-gradient-to-r from-blue-600 to-blue-700 flex items-center justify-center gap-3">
        {/* Source Language (static) */}
        <span className="px-2.5 py-1 bg-white/20 rounded-md text-white text-sm font-medium">
          {sourceLangName}
        </span>
        
        <ArrowRight size={16} className="text-white/80" />
        
        {/* Target Language (dropdown) */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowLangDropdown(!showLangDropdown)}
            disabled={isRetranslating || isLoading}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-white/30 hover:bg-white/40 rounded-md text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {isRetranslating ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : null}
            {targetLangName}
            <ChevronDown size={14} className={`transition-transform ${showLangDropdown ? 'rotate-180' : ''}`} />
          </button>
          
          {/* Dropdown Menu */}
          {showLangDropdown && (
            <div className="absolute top-full left-0 mt-1 w-40 bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-50 max-h-60 overflow-auto">
              {targetLanguages.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => handleTargetLangChange(lang.code)}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-blue-50 transition-colors ${
                    lang.code === selectedTargetLang
                      ? 'bg-blue-100 text-blue-700 font-medium'
                      : 'text-slate-700'
                  }`}
                >
                  {lang.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 space-y-4 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span>Translating...</span>
            </div>
          </div>
        ) : translation ? (
          <>
            {/* Original */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Original
                </span>
                <span className="text-xs text-slate-400">({sourceLangName})</span>
              </div>
              <div className="p-3.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 max-h-44 overflow-auto leading-relaxed shadow-sm">
                {translation.original}
              </div>
            </div>

            {/* Translated */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
                  Translated
                </span>
                <span className="text-xs text-blue-400">({targetLangName})</span>
                {isRetranslating && (
                  <RefreshCw size={12} className="text-blue-400 animate-spin" />
                )}
              </div>
              <div className={`p-3.5 bg-blue-50 border border-blue-200 rounded-xl text-sm text-slate-800 max-h-44 overflow-auto leading-relaxed font-medium shadow-sm ${isRetranslating ? 'opacity-50' : ''}`}>
                {translation.translated}
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm">
            No translation data
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 bg-white border-t border-slate-200 flex gap-2">
        <button
          onClick={handleCopy}
          disabled={!translation || isRetranslating}
          className={`flex-1 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-all ${
            copied 
              ? 'bg-green-500 text-white' 
              : 'bg-blue-600 hover:bg-blue-700 text-white disabled:bg-slate-200 disabled:text-slate-400'
          }`}
        >
          {copied ? (
            <>
              <Check size={14} />
              Copied!
            </>
          ) : (
            <>
              <Copy size={14} />
              Copy Result
            </>
          )}
        </button>
        <button 
          onClick={handleClose} 
          className="px-5 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-sm font-medium transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}
