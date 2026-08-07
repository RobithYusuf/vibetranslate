import { Replace, MessageSquare } from 'lucide-react';
import { TranslationMode } from '@/types';

interface ModeToggleProps {
  mode: TranslationMode;
  onChange: (mode: TranslationMode) => void;
}

export default function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">
        Translation Mode
      </label>
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onChange('replace')}
          className={`mode-option w-full text-left ${
            mode === 'replace' ? 'selected' : ''
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                mode === 'replace'
                  ? 'border-primary-600 bg-primary-600'
                  : 'border-gray-300'
              }`}
            >
              {mode === 'replace' && (
                <div className="w-1.5 h-1.5 bg-white rounded-full" />
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Replace size={16} className="text-gray-600" />
                <span className="font-medium">Replace Mode</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Automatically replace selected text with translation
              </p>
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onChange('popup')}
          className={`mode-option w-full text-left ${
            mode === 'popup' ? 'selected' : ''
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                mode === 'popup'
                  ? 'border-primary-600 bg-primary-600'
                  : 'border-gray-300'
              }`}
            >
              {mode === 'popup' && (
                <div className="w-1.5 h-1.5 bg-white rounded-full" />
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <MessageSquare size={16} className="text-gray-600" />
                <span className="font-medium">Popup Mode</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Show translation in a popup window (manual copy)
              </p>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
