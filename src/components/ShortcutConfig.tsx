import { Keyboard } from 'lucide-react';
import { formatShortcut } from '@/utils/helpers';
import { DEFAULT_SHORTCUT } from '@/utils/constants';

interface ShortcutConfigProps {
  shortcut: string;
  onChange: (shortcut: string) => void;
}

export default function ShortcutConfig({
  shortcut,
  onChange,
}: ShortcutConfigProps) {
  const handleReset = () => {
    onChange(DEFAULT_SHORTCUT);
  };

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">
        Keyboard Shortcut
      </label>
      <div className="flex items-center gap-2">
        <div className="flex-1 input flex items-center gap-2 bg-gray-50">
          <Keyboard size={18} className="text-gray-400" />
          <span className="font-mono">{formatShortcut(shortcut)}</span>
        </div>
        <button
          type="button"
          onClick={handleReset}
          className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg"
        >
          Reset
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Press this shortcut after selecting text to translate
      </p>
    </div>
  );
}
