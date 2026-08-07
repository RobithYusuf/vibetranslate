import { useAppStore } from '@/stores/appStore';
import { translations, Language, TranslationKey } from './translations';

export type { Language, TranslationKey };
export { translations };

export function useI18n() {
  const uiLanguage = useAppStore((state) => state.uiLanguage);
  
  const t = (key: TranslationKey): string => {
    return translations[uiLanguage][key] || translations.en[key] || key;
  };
  
  return { t, language: uiLanguage };
}

export const UI_LANGUAGES = [
  { code: 'en' as Language, name: 'English', nativeName: 'English' },
  { code: 'id' as Language, name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
];
