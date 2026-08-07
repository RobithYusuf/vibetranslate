import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import APP_CONFIG from '../config';

const CACHE_KEY = 'vibetranslate_app_status';

interface AppStatus {
  freeMode: boolean;
  warningMessage: string | null;
  message: string;
  buyUrl: string;
  timestamp: number;
}

interface CachedStatus {
  status: AppStatus;
  cachedAt: number;
}

export function useAppStatus() {
  const [_loading, setLoading] = useState(true);
  const [_freeMode, setFreeMode] = useState<boolean | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastCheckRef = useRef<number>(0);
  
  const { licenseKey, licenseStatus, setLicenseStatus } = useAppStore();
  
  // Check if user has valid license
  const hasValidLicense = licenseStatus === 'valid' && !!licenseKey;
  
  // Load cached status
  const getCachedStatus = (): AppStatus | null => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;
      
      const { status, cachedAt }: CachedStatus = JSON.parse(cached);
      
      // Check if cache is still valid
      if (Date.now() - cachedAt < APP_CONFIG.STATUS_CACHE_DURATION) {
        return status;
      }
    } catch {
      // Invalid cache
    }
    return null;
  };
  
  // Save to cache
  const setCachedStatus = (status: AppStatus) => {
    try {
      const cached: CachedStatus = { status, cachedAt: Date.now() };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
    } catch {
      // Storage full or unavailable
    }
  };
  
  // Check server status
  const checkStatus = useCallback(async (force = false) => {
    // Cooldown check (skip if recently checked, unless forced)
    const now = Date.now();
    if (!force && now - lastCheckRef.current < APP_CONFIG.FOCUS_CHECK_COOLDOWN) {
      return;
    }
    lastCheckRef.current = now;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${APP_CONFIG.API_URL}/api/status`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!response.ok) throw new Error('Server error');
      
      const status: AppStatus = await response.json();
      setFreeMode(status.freeMode);
      setWarningMessage(status.warningMessage);
      setCachedStatus(status);
      console.log('[AppStatus] Status:', status.freeMode ? 'free' : 'paid', status.warningMessage ? `(warning: ${status.warningMessage})` : '');
      
    } catch (err) {
      const cached = getCachedStatus();
      if (cached) {
        setFreeMode(cached.freeMode);
        setWarningMessage(cached.warningMessage);
        console.log('[AppStatus] Using cached status');
      } else {
        setFreeMode(true);
        console.log('[AppStatus] Server unreachable, defaulting to free mode');
      }
      setError('Could not connect to server');
    } finally {
      setLoading(false);
    }
  }, []);
  
  // Validate existing license
  const validateLicense = useCallback(async () => {
    if (!licenseKey) return;
    
    try {
      const response = await fetch(`${APP_CONFIG.API_URL}/api/license/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey }),
      });
      
      const data = await response.json();
      setLicenseStatus(data.valid ? 'valid' : 'invalid');
      
    } catch {
      // Keep existing status if server unreachable
      console.log('[AppStatus] Could not validate license, keeping existing status');
    }
  }, [licenseKey, setLicenseStatus]);
  
  // Initial check on mount
  useEffect(() => {
    checkStatus(true); // Force check on mount
    if (licenseKey) {
      validateLicense();
    }
  }, [checkStatus, validateLicense, licenseKey]);
  
  // Re-check on window focus (with cooldown)
  useEffect(() => {
    const handleFocus = () => {
      console.log('[AppStatus] Window focused, checking status...');
      checkStatus(false); // Respect cooldown
    };
    
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [checkStatus]);
  
  // Determine if app should be blocked
  // Controlled by server's freeMode setting
  const shouldShowPaywall = !_loading && _freeMode === false && !hasValidLicense;
  
  return {
    loading: _loading,
    freeMode: _freeMode ?? true, // Default to free if not loaded yet
    warningMessage,
    error,
    hasValidLicense,
    shouldShowPaywall,
    checkStatus: () => checkStatus(true), // Always force when called manually
  };
}
