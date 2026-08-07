import { ArrowLeftRight } from 'lucide-react';
import { LANGUAGES } from '@/utils/constants';

interface LanguageSelectorProps {
  sourceLang: string;
  targetLang: string;
  onSourceChange: (lang: string) => void;
  onTargetChange: (lang: string) => void;
  onSwap: () => void;
}

export default function LanguageSelector({
  sourceLang,
  targetLang,
  onSourceChange,
  onTargetChange,
  onSwap,
}: LanguageSelectorProps) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">
        Languages
      </label>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">Source</label>
          <select
            value={sourceLang}
            onChange={(e) => onSourceChange(e.target.value)}
            className="input"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={onSwap}
          disabled={sourceLang === 'auto'}
          className="mt-5 p-2 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Swap languages"
        >
          <ArrowLeftRight size={20} className="text-gray-600" />
        </button>

        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">Target</label>
          <select
            value={targetLang}
            onChange={(e) => onTargetChange(e.target.value)}
            className="input"
          >
            {LANGUAGES.filter((l) => l.code !== 'auto').map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
