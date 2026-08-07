import { Loader2, Check, X } from 'lucide-react';
import { TranslationStatus } from '@/types';
import { STATUS_MESSAGES } from '@/utils/constants';

interface TranslatingOverlayProps {
  isVisible: boolean;
  status: TranslationStatus;
  error?: string | null;
}

export default function TranslatingOverlay({
  isVisible,
  status,
  error,
}: TranslatingOverlayProps) {
  if (!isVisible && status === 'idle') return null;

  const getIcon = () => {
    switch (status) {
      case 'done':
        return <Check size={20} className="text-green-500" />;
      case 'error':
        return <X size={20} className="text-red-500" />;
      default:
        return <Loader2 size={20} className="text-primary-600 animate-spin" />;
    }
  };

  const getMessage = () => {
    if (status === 'error' && error) {
      return error;
    }
    return STATUS_MESSAGES[status] || '';
  };

  return (
    <div className="overlay-notification animate-in fade-in slide-in-from-top-2 duration-200">
      <div className="flex items-center gap-3">
        {getIcon()}
        <span
          className={`text-sm ${
            status === 'error' ? 'text-red-600' : 'text-gray-700'
          }`}
        >
          {getMessage()}
        </span>
      </div>
    </div>
  );
}
