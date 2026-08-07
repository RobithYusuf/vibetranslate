import { useEffect, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { loadSettings, saveSettings } from '@/services/storage';
import { loadAllApiKeys, saveAllApiKeys, migratePlaintextKeys } from '@/services/secrets';
import { Settings, AIProvider, LicenseStatus } from '@/types';
import { Language } from '@/i18n';
import { sanitizeCorrections } from '@/utils/voiceCorrections';
import { DEFAULT_SHORTCUT, DEFAULT_POPUP_SHORTCUT, DEFAULT_TERMINAL_SHORTCUT, DEFAULT_VOICE_SHORTCUT, DEFAULT_VOICE_ORIGINAL_SHORTCUT } from '@/utils/constants';

// Validate shortcut format - modifier + key, OR a single function key (F1–F24).
function isValidShortcut(shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split('+').map(p => p.trim());
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/i.test(shortcut.trim());
  if (parts.length < 2) return isFunctionKey;

  // Last part should be the key (not a modifier)
  const lastPart = parts[parts.length - 1].toLowerCase();
  const modifiers = ['control', 'ctrl', 'alt', 'shift', 'meta', 'command', 'commandorcontrol', 'super'];

  // Last part should NOT be a modifier (it should be the actual key)
  return !modifiers.includes(lastPart);
}

export function useSettings() {
  const {
    licenseKey,
    licenseStatus,
    appEnabled,
    uiLanguage,
    apiKeys,
    provider,
    model,
    shortcut,
    popupShortcut,
    terminalShortcut,
    sourceLang,
    targetLang,
    autoStart,
    enhanceEnabled,
    enhanceShortcut,
    customBaseURL,
    customModel,
    voiceEnabled,
    voiceShortcut,
    voiceOriginalShortcut,
    voiceAutoStop,
    voicePopupPosition,
    voiceMaxMinutes,
    voiceSilenceSec,
    micDeviceId,
    voiceCorrections,
    voiceSoundEnabled,
    micAutoGain,
    voiceSttEngine,
    voiceCleanup,
    uiFont,
    uiScale,
    soundEnabled,
    loadingEnabled,
    autoUpdateCheck,
    skippedUpdateVersion,
    setLicenseKey,
    setLicenseStatus,
    setAppEnabled,
    setSettingsLoaded,
    setUiLanguage,
    setApiKey,
    setProvider,
    setModel,
    setCustomBaseURL,
    setCustomModel,
    setShortcut,
    setPopupShortcut,
    setTerminalShortcut,
    setSourceLang,
    setTargetLang,
    setAutoStart,
    setEnhanceEnabled,
    setEnhanceShortcut,
    setVoiceEnabled,
    setVoiceAutoStop,
    setVoicePopupPosition,
    setVoiceSoundEnabled,
    setMicAutoGain,
    setVoiceMaxMinutes,
    setVoiceSilenceSec,
    setMicDeviceId,
    setVoiceCorrections,
    setUiFont,
    setUiScale,
    setVoiceShortcut,
    setVoiceOriginalShortcut,
    setSoundEnabled,
    setLoadingEnabled,
    setAutoUpdateCheck,
    setSkippedUpdateVersion,
  } = useAppStore();

  useEffect(() => {
    const load = async () => {
      console.log('[Settings] Loading settings from storage...');
      try {
        const settings = await loadSettings();
        // Never log the raw settings — it contains API keys + license key. Log only shape.
        console.log('[Settings] Loaded:', settings ? { ...settings, apiKey: settings.apiKey ? '***' : undefined, apiKeys: '***', licenseKey: (settings as { licenseKey?: string }).licenseKey ? '***' : null } : null);
        if (settings) {
          // Load provider first (this sets its default model too).
          if (settings.provider) setProvider(settings.provider as AIProvider);
          // Load all API keys per provider. NOTE: this loop switches provider back and
          // forth (setProvider resets `model` to that provider's default), so it MUST run
          // BEFORE we restore the saved model below — otherwise the user's model choice is
          // silently clobbered to the default on every launch.
          // API keys now live in the OS credential store. An older build wrote them into
          // settings.json in plaintext, so anything still in the file is migrated across and
          // then dropped from the file on the next save.
          const plaintextKeys = (settings as { apiKeys?: Record<string, string | null> }).apiKeys;
          const migrated = await migratePlaintextKeys(plaintextKeys);
          const savedApiKeys = { ...(plaintextKeys || {}), ...(await loadAllApiKeys()) };
          if (migrated) {
            // Strip the plaintext copy NOW rather than waiting for the user to happen to
            // change a setting — leaving a readable key on disk is the whole problem.
            const { apiKeys: _dropped, ...withoutKeys } = settings as unknown as Record<string, unknown>;
            try {
              await saveSettings(withoutKeys as unknown as Settings);
              console.log('[Settings] plaintext API keys removed from the settings file');
            } catch (e) {
              console.warn('[Settings] could not rewrite settings without the keys:', e);
            }
          }
          if (savedApiKeys) {
            console.log('[Settings] Loading API keys per provider');
            // Set each provider's API key
            for (const p of ['server', 'openai', 'openrouter', 'groq', 'gemini', 'custom'] as AIProvider[]) {
              if (savedApiKeys[p]) {
                // Temporarily switch provider to set the key, then switch back
                const currentProvider = settings.provider as AIProvider || provider;
                setProvider(p);
                setApiKey(savedApiKeys[p]);
                setProvider(currentProvider);
              }
            }
          } else if (settings.apiKey) {
            // Legacy: single apiKey - save it for current provider
            console.log('[Settings] Setting legacy API key');
            setApiKey(settings.apiKey);
          }
          // Restore the saved model LAST, after the provider/key dance above, so it isn't
          // overwritten by a setProvider() default.
          if ((settings as { model?: string }).model) setModel((settings as { model?: string }).model!);
          // Validate shortcuts before applying - reset to default if invalid
          const savedShortcut = settings.shortcut;
          const savedPopupShortcut = (settings as { popupShortcut?: string }).popupShortcut;
          const savedTerminalShortcut = (settings as { terminalShortcut?: string }).terminalShortcut;
          
          if (savedShortcut && isValidShortcut(savedShortcut)) {
            setShortcut(savedShortcut);
          } else if (savedShortcut) {
            console.warn(`[Settings] Invalid shortcut "${savedShortcut}", resetting to default`);
            setShortcut(DEFAULT_SHORTCUT);
          }
          
          if (savedPopupShortcut && isValidShortcut(savedPopupShortcut)) {
            setPopupShortcut(savedPopupShortcut);
          } else if (savedPopupShortcut) {
            console.warn(`[Settings] Invalid popupShortcut "${savedPopupShortcut}", resetting to default`);
            setPopupShortcut(DEFAULT_POPUP_SHORTCUT);
          }
          
          if (savedTerminalShortcut && isValidShortcut(savedTerminalShortcut)) {
            setTerminalShortcut(savedTerminalShortcut);
          } else if (savedTerminalShortcut) {
            console.warn(`[Settings] Invalid terminalShortcut "${savedTerminalShortcut}", resetting to default`);
            setTerminalShortcut(DEFAULT_TERMINAL_SHORTCUT);
          }
          if (settings.sourceLang) setSourceLang(settings.sourceLang);
          if (settings.targetLang) setTargetLang(settings.targetLang);
          if (settings.autoStart !== undefined) setAutoStart(settings.autoStart);
          if (settings.enhanceEnabled !== undefined) setEnhanceEnabled(settings.enhanceEnabled);
          if (settings.enhanceShortcut) setEnhanceShortcut(settings.enhanceShortcut);
          // Voice-to-Text settings
          if ((settings as { voiceEnabled?: boolean }).voiceEnabled !== undefined) {
            setVoiceEnabled((settings as { voiceEnabled?: boolean }).voiceEnabled!);
          }
          if ((settings as { voiceAutoStop?: boolean }).voiceAutoStop !== undefined) {
            setVoiceAutoStop((settings as { voiceAutoStop?: boolean }).voiceAutoStop!);
          }
          if ((settings as { voicePopupPosition?: string }).voicePopupPosition) {
            setVoicePopupPosition((settings as { voicePopupPosition?: string }).voicePopupPosition!);
          }
          if ((settings as { voiceSoundEnabled?: boolean }).voiceSoundEnabled !== undefined) {
            setVoiceSoundEnabled((settings as { voiceSoundEnabled?: boolean }).voiceSoundEnabled!);
          }
          if ((settings as { micAutoGain?: boolean }).micAutoGain !== undefined) {
            setMicAutoGain((settings as { micAutoGain?: boolean }).micAutoGain!);
          }
          if ((settings as { voiceSttEngine?: string }).voiceSttEngine !== undefined) {
            useAppStore.getState().setVoiceSttEngine((settings as { voiceSttEngine?: string }).voiceSttEngine!);
          }
          if ((settings as { voiceCleanup?: boolean }).voiceCleanup !== undefined) {
            useAppStore.getState().setVoiceCleanup((settings as { voiceCleanup?: boolean }).voiceCleanup!);
          }
          {
            const vm = (settings as { voiceMaxMinutes?: number }).voiceMaxMinutes;
            if (typeof vm === 'number' && vm >= 1 && vm <= 15) {
              setVoiceMaxMinutes(vm);
            }
          }
          {
            const vs = (settings as { voiceSilenceSec?: number }).voiceSilenceSec;
            if (typeof vs === 'number' && vs >= 0.5 && vs <= 5) {
              setVoiceSilenceSec(vs);
            }
          }
          {
            const md = (settings as { micDeviceId?: string }).micDeviceId;
            if (typeof md === 'string') setMicDeviceId(md);
            const vc = (settings as { voiceCorrections?: unknown }).voiceCorrections;
            if (vc !== undefined) setVoiceCorrections(sanitizeCorrections(vc));
          }
          if ((settings as { uiFont?: string }).uiFont) setUiFont((settings as { uiFont?: string }).uiFont!);
          if ((settings as { uiScale?: string }).uiScale) setUiScale((settings as { uiScale?: string }).uiScale!);
          if ((settings as { customBaseURL?: string }).customBaseURL) setCustomBaseURL((settings as { customBaseURL?: string }).customBaseURL!);
          if ((settings as { customModel?: string }).customModel) setCustomModel((settings as { customModel?: string }).customModel!);
          const savedVoiceShortcut = (settings as { voiceShortcut?: string }).voiceShortcut;
          if (savedVoiceShortcut && isValidShortcut(savedVoiceShortcut)) {
            setVoiceShortcut(savedVoiceShortcut);
          } else if (savedVoiceShortcut) {
            console.warn(`[Settings] Invalid voiceShortcut "${savedVoiceShortcut}", resetting to default`);
            setVoiceShortcut(DEFAULT_VOICE_SHORTCUT);
          }
          const savedVoiceOriginalShortcut = (settings as { voiceOriginalShortcut?: string }).voiceOriginalShortcut;
          if (savedVoiceOriginalShortcut && isValidShortcut(savedVoiceOriginalShortcut)) {
            setVoiceOriginalShortcut(savedVoiceOriginalShortcut);
          } else if (savedVoiceOriginalShortcut) {
            console.warn(`[Settings] Invalid voiceOriginalShortcut "${savedVoiceOriginalShortcut}", resetting to default`);
            setVoiceOriginalShortcut(DEFAULT_VOICE_ORIGINAL_SHORTCUT);
          }
          if (settings.soundEnabled !== undefined) setSoundEnabled(settings.soundEnabled);
          if (settings.loadingEnabled !== undefined) setLoadingEnabled(settings.loadingEnabled);
          if ((settings as { autoUpdateCheck?: boolean }).autoUpdateCheck !== undefined) {
            setAutoUpdateCheck((settings as { autoUpdateCheck?: boolean }).autoUpdateCheck!);
          }
          if ((settings as { skippedUpdateVersion?: string }).skippedUpdateVersion !== undefined) {
            setSkippedUpdateVersion((settings as { skippedUpdateVersion?: string }).skippedUpdateVersion!);
          }
          // App enabled (default to true if not set)
          if ((settings as { appEnabled?: boolean }).appEnabled !== undefined) {
            setAppEnabled((settings as { appEnabled?: boolean }).appEnabled!);
          }
          // UI Language
          if ((settings as { uiLanguage?: Language }).uiLanguage) {
            setUiLanguage((settings as { uiLanguage?: Language }).uiLanguage!);
          }
          // License
          if ((settings as { licenseKey?: string }).licenseKey) {
            setLicenseKey((settings as { licenseKey?: string }).licenseKey!);
            setLicenseStatus((settings as { licenseStatus?: LicenseStatus }).licenseStatus || 'valid');
          }
        } else {
          console.log('[Settings] No saved settings found');
        }
      } catch (err) {
        console.error('[Settings] Failed to load:', err);
      } finally {
        // Mark loaded (even on error / fresh install) so autosave may run from now on.
        setSettingsLoaded(true);
      }
    };
    load();
  }, [setApiKey, setProvider, setModel, setShortcut, setPopupShortcut, setTerminalShortcut, setSourceLang, setTargetLang, setAutoStart, setEnhanceEnabled, setEnhanceShortcut, setVoiceEnabled, setVoiceAutoStop, setVoicePopupPosition, setVoiceSoundEnabled, setMicAutoGain, setUiFont, setUiScale, setVoiceShortcut, setVoiceOriginalShortcut, setSoundEnabled, setLoadingEnabled, setAutoUpdateCheck, setSkippedUpdateVersion, setAppEnabled, setUiLanguage, setLicenseKey, setLicenseStatus, setCustomBaseURL, setCustomModel, setSettingsLoaded]);

  const save = useCallback(async () => {
    // Written to the OS credential store, deliberately NOT into the settings file below.
    await saveAllApiKeys(apiKeys);
    const settings = {
      licenseKey,
      licenseStatus,
      appEnabled,
      uiLanguage,
      provider,
      model,
      customBaseURL,
      customModel,
      shortcut,
      popupShortcut,
      terminalShortcut,
      sourceLang,
      targetLang,
      autoStart,
      enhanceEnabled,
      enhanceShortcut,
      voiceEnabled,
      voiceShortcut,
      voiceOriginalShortcut,
      voiceAutoStop,
      voicePopupPosition,
      voiceSoundEnabled,
      micAutoGain,
      voiceSttEngine,
      voiceCleanup,
      voiceMaxMinutes,
      voiceSilenceSec,
      micDeviceId,
      voiceCorrections,
      uiFont,
      uiScale,
      soundEnabled,
      loadingEnabled,
      autoUpdateCheck,
      skippedUpdateVersion,
    };
    console.log('[Settings] Saving settings:', { ...settings, apiKeys: '***', licenseKey: licenseKey ? '***' : null });
    await saveSettings(settings as unknown as Settings);
    console.log('[Settings] Saved successfully');
  }, [licenseKey, licenseStatus, appEnabled, uiLanguage, apiKeys, provider, model, customBaseURL, customModel, shortcut, popupShortcut, terminalShortcut, sourceLang, targetLang, autoStart, enhanceEnabled, enhanceShortcut, voiceEnabled, voiceShortcut, voiceOriginalShortcut, voiceAutoStop, voicePopupPosition, voiceSoundEnabled, micAutoGain, voiceSttEngine, voiceCleanup, voiceMaxMinutes, voiceSilenceSec, micDeviceId, voiceCorrections, uiFont, uiScale, soundEnabled, loadingEnabled, autoUpdateCheck, skippedUpdateVersion]);

  return { save };
}
