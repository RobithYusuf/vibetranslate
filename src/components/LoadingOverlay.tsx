import { useEffect, useState, useCallback, useRef } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import logo from '@/assets/logo.png';

export default function LoadingOverlay() {
  // Enable macOS rounded corners on mount (only on macOS)
  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    if (isMac) {
      const moduleName = '@cloudworxx/tauri-plugin-mac-rounded-corners';
      import(/* @vite-ignore */ moduleName)
        .then((mod) => {
          mod.enableModernWindowStyle({ cornerRadius: 12 }).catch(() => {});
        })
        .catch(() => {});
    }
  }, []);
  const [dots, setDots] = useState('');
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const [errorHint, setErrorHint] = useState('');
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const startTimeRef = useRef<number>(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset function to clear and restart timer
  const resetTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    setElapsedTime(0);
    setStatus('loading');
  }, []);

  // Animated dots
  useEffect(() => {
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
    }, 250);
    return () => clearInterval(interval);
  }, []);

  // Elapsed time counter - properly managed with ref
  useEffect(() => {
    // Clear any existing timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    
    if (status !== 'loading') return;
    
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setElapsedTime(elapsed);
    }, 100);
    
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);

  // Listen for loading events from main window
  useEffect(() => {
    const unlistenStatus = listen<{ status: string; isEnhancing?: boolean; message?: string }>('loading-status', (event) => {
      if (event.payload.status === 'done') {
        setStatus('done');
      } else if (event.payload.status === 'error') {
        setStatus('error');
        setErrorHint(event.payload.message || '');
      } else {
        // Reset everything for new loading
        setErrorHint('');
        resetTimer();
      }
      
      if (event.payload.isEnhancing !== undefined) {
        setIsEnhancing(event.payload.isEnhancing);
      }
    });

    // Also listen for show event to reset timer
    const unlistenShow = listen('loading-show', () => {
      resetTimer();
    });

    return () => {
      unlistenStatus.then(fn => fn());
      unlistenShow.then(fn => fn());
    };
  }, [resetTimer]);

  // Cancel handler
  const handleCancel = useCallback(async () => {
    await emit('translation-cancel');
  }, []);

  // Escape key to cancel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status === 'loading') {
        handleCancel();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [status, handleCancel]);

  const isSuccess = status === 'done';
  const isError = status === 'error';
  const isLoading = status === 'loading';

  const getLoadingText = () => {
    if (isSuccess) return 'Done!';
    if (isError) return 'Error';
    return isEnhancing ? `Enhancing${dots}` : `Translating${dots}`;
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[#1a1a1a] overflow-hidden">
      <div className="flex flex-col items-center gap-2 text-white px-4 py-3">
        {/* Logo with spinner around it */}
        <div className="relative w-14 h-14 flex items-center justify-center">
          {/* Spinner ring */}
          {isLoading && (
            <div className="absolute inset-0">
              <svg className="w-14 h-14 animate-spin" viewBox="0 0 56 56">
                <circle 
                  cx="28" cy="28" r="24" 
                  fill="none" 
                  stroke="rgba(59, 130, 246, 0.2)" 
                  strokeWidth="3"
                />
                <circle 
                  cx="28" cy="28" r="24" 
                  fill="none" 
                  stroke="#3b82f6" 
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray="75 113"
                />
              </svg>
            </div>
          )}
          
          {/* Logo - centered */}
          <img 
            src={logo} 
            alt="VibeTranslate" 
            className="w-8 h-8 relative z-10"
          />
          
          {/* Success/Error badge */}
          {isSuccess && (
            <div className="absolute bottom-0 right-0 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center z-20">
              <span className="text-white text-[9px] font-bold">✓</span>
            </div>
          )}
          {isError && (
            <div className="absolute bottom-0 right-0 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center z-20">
              <span className="text-white text-[9px] font-bold">✗</span>
            </div>
          )}
        </div>
        
        {/* Status text */}
        <div className="text-center">
          <div className="text-[12px] font-medium">{getLoadingText()}</div>
          {isError && errorHint && (
            <div className="text-[10px] text-red-300/90 leading-snug mt-0.5 max-w-[130px]">{errorHint}</div>
          )}
          {isLoading && elapsedTime > 0 && (
            <div className="text-[10px] text-white/40">{elapsedTime}s</div>
          )}
        </div>
        
        {/* Cancel button - show after 2 seconds */}
        {isLoading && elapsedTime >= 2 && (
          <button
            onClick={handleCancel}
            className="px-2.5 py-0.5 text-[10px] text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
