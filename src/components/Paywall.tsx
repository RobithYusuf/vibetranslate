import { useState, useEffect } from 'react';
import { getDeviceId } from '@/utils/deviceId';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { getVersion } from '@tauri-apps/api/app';
import { useAppStore } from '../stores/appStore';
import APP_CONFIG from '../config';

interface PaywallProps {
  onActivated: () => void;
}

export function Paywall({ onActivated }: PaywallProps) {
  const [licenseKey, setLicenseKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState('1.0.0');
  
  const { setLicenseKey: saveLicenseKey, setLicenseStatus } = useAppStore();

  useEffect(() => {
    getVersion().then(v => setAppVersion(v)).catch(() => {});
  }, []);
  
  const handleActivate = async () => {
    if (!licenseKey.trim()) {
      setError('Please enter a license key');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const machineId = getDeviceId();
      
      const response = await fetch(`${APP_CONFIG.API_URL}/api/license/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey: licenseKey.trim(),
          machineId,
          platform: navigator.platform,
          appVersion,
        }),
      });
      
      const data = await response.json();
      
      if (data.success) {
        saveLicenseKey(licenseKey.trim());
        setLicenseStatus('valid');
        onActivated();
      } else {
        setError(data.error || 'Invalid license key');
      }
    } catch (err) {
      setError('Could not connect to server. Please try again.');
    } finally {
      setLoading(false);
    }
  };
  
  const handleBuy = async () => {
    // Was invoke('open_url') — a command that doesn't exist in Rust, so this always threw
    // and fell back to window.open(), which does nothing from a Tauri webview: the button
    // was simply dead. The shell plugin is already a dependency and already permitted.
    try {
      await openUrl(APP_CONFIG.PRICING_URL);
    } catch (err) {
      console.warn('[Paywall] Could not open the browser:', err);
    }
  };
  
  return (
    <div className="h-screen flex items-center justify-center bg-[#1e1e1e] text-white p-8">
      <div className="max-w-md w-full text-center">
        {/* Icon */}
        <div className="text-6xl mb-6">🔒</div>
        
        {/* Title */}
        <h1 className="text-2xl font-bold mb-2">License Required</h1>
        <p className="text-white/60 mb-8">
          The free period has ended. Please enter your license key to continue using VibeTranslate.
        </p>
        
        {/* License Input */}
        <div className="mb-4">
          <input
            type="text"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
            placeholder="VIBE-XXXX-XXXX-XXXX"
            className="w-full px-4 py-3 bg-[#2d2d2d] border border-[#454545] rounded-lg text-center text-lg tracking-wider font-mono focus:outline-none focus:border-[#6366f1]"
            disabled={loading}
          />
        </div>
        
        {/* Error */}
        {error && (
          <div className="mb-4 text-red-400 text-sm">
            {error}
          </div>
        )}
        
        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={handleActivate}
            disabled={loading || !licenseKey.trim()}
            className="flex-1 py-3 bg-[#6366f1] hover:bg-[#818cf8] rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Activating...' : 'Activate License'}
          </button>
          
          <button
            onClick={handleBuy}
            className="flex-1 py-3 bg-[#2d2d2d] hover:bg-[#3d3d3d] border border-[#454545] rounded-lg font-semibold transition-colors"
          >
            Buy License
          </button>
        </div>
        
        {/* Help */}
        <p className="mt-6 text-sm text-white/40">
          Need help? Contact {APP_CONFIG.SUPPORT_EMAIL}
        </p>
      </div>
    </div>
  );
}
