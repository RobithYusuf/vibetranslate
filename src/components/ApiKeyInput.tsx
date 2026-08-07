import { useState } from 'react';
import { Eye, EyeOff, Check, X } from 'lucide-react';

interface ApiKeyInputProps {
  value: string;
  onChange: (value: string) => void;
}

export default function ApiKeyInput({ value, onChange }: ApiKeyInputProps) {
  const [showKey, setShowKey] = useState(false);
  const isValid = value ? value.length > 20 : null;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">
        OpenAI API Key
      </label>
      <div className="relative">
        <input
          type={showKey ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="sk-..."
          className="input pr-20"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {isValid !== null && (
            <span className={isValid ? 'text-green-500' : 'text-red-500'}>
              {isValid ? <Check size={16} /> : <X size={16} />}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="text-gray-400 hover:text-gray-600"
          >
            {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Get your API key from{' '}
        <a
          href="https://platform.openai.com/api-keys"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary-600 hover:underline"
        >
          OpenAI Dashboard
        </a>
      </p>
    </div>
  );
}
